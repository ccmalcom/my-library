"""Command-line interface for offline batch runs.

  python -m mylibrary.cli initdb
  python -m mylibrary.cli ingest [PATH]      # defaults to data/goodreads_library_export.csv
  python -m mylibrary.cli enrich [--force] [--limit N] [--include-unrated]
  python -m mylibrary.cli profile
  python -m mylibrary.cli recommend [--n N] [--no-claude-seeds]
  python -m mylibrary.cli recs                # reprint the latest run
  python -m mylibrary.cli stats
  python -m mylibrary.cli serve              # launches the FastAPI service
"""

from __future__ import annotations

import json

import typer

from .config import get_settings
from .db import init_db
from .enrich import enrich_library
from .ingest import ingest_csv
from .profile import extract_taste_profile
from .recommend import recommend as run_recommend
from .stats import dataset_stats

app = typer.Typer(add_completion=False, help="MyLibrary offline analysis engine.")


def _echo(obj) -> None:
    typer.echo(json.dumps(obj, indent=2, default=str))


@app.command()
def initdb() -> None:
    """Create the SQLite schema."""
    init_db()
    typer.echo(f"Initialized {get_settings().db_path}")


@app.command()
def ingest(path: str = typer.Argument(None, help="Path to the Goodreads CSV export.")) -> None:
    """Import a Goodreads export (idempotent)."""
    csv_path = path or str(get_settings().csv_path)
    _echo(ingest_csv(csv_path))


@app.command()
def enrich(
    force: bool = typer.Option(False, help="Re-resolve books that are already enriched."),
    limit: int = typer.Option(None, help="Stop after N books (handy for testing)."),
    include_unrated: bool = typer.Option(False, help="Also enrich unrated books."),
    retry_unresolved: bool = typer.Option(
        False, help="Re-attempt only books that previously failed to resolve."
    ),
    rps: float = typer.Option(
        None, help="Catalog requests per second (default 8). Lower it if you see 429s."
    ),
    progress: bool = typer.Option(True, help="Show a live progress bar."),
) -> None:
    """Resolve books to catalog metadata with a confidence score."""
    if not progress:
        result = enrich_library(
            force=force, limit=limit, include_unrated=include_unrated,
            retry_unresolved=retry_unresolved, requests_per_second=rps,
        )
        _echo(result)
        _warn_if_rate_limited(result)
        return

    from rich.progress import (
        BarColumn,
        MofNCompleteColumn,
        TextColumn,
        TimeElapsedColumn,
        TimeRemainingColumn,
    )
    from rich.progress import Progress as RichProgress

    with RichProgress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.percentage:>3.0f}%"),
        MofNCompleteColumn(),
        TimeElapsedColumn(),
        TimeRemainingColumn(),
        TextColumn("{task.fields[extra]}"),
    ) as bar:
        task = bar.add_task("Enriching", total=None, extra="")

        def on_progress(done: int, total: int, title: str, label: str) -> None:
            from .catalog import get_stats

            limited = get_stats().get("rate_limited", 0)
            extra = f"[red]429s: {limited}[/red]" if limited else ""
            bar.update(
                task,
                total=total,
                completed=done,
                extra=extra,
                description=f"Enriching [{label:10}] {title[:32]}",
            )

        result = enrich_library(
            force=force,
            limit=limit,
            include_unrated=include_unrated,
            retry_unresolved=retry_unresolved,
            requests_per_second=rps,
            progress=on_progress,
        )
    _echo(result)
    _warn_if_rate_limited(result)


def _warn_if_rate_limited(result: dict) -> None:
    http = result.get("http", {})
    limited = http.get("rate_limited", 0)
    if limited:
        hosts = ", ".join(
            f"{h} ({d['rate_limited']})"
            for h, d in http.get("by_host", {}).items()
            if d.get("rate_limited")
        )
        typer.secho(
            f"\n  Rate-limited {limited}x ({hosts}). Consider a lower --rps next run.",
            fg=typer.colors.YELLOW,
        )


@app.command()
def profile() -> None:
    """Extract the evidence-backed taste profile (needs ANTHROPIC_API_KEY)."""
    from rich.console import Console

    console = Console()
    try:
        # A single Claude call (no per-item loop), so a spinner fits better than a bar.
        with console.status("[bold]Analyzing taste tiers with Claude…", spinner="dots"):
            result = extract_taste_profile()
    except RuntimeError as e:
        typer.secho(str(e), fg=typer.colors.RED)
        raise typer.Exit(code=1)
    _echo(result)
    typer.echo("\nRun `python -m mylibrary.cli traits` to read the inferred profile.")


@app.command()
def rate(
    book_id: int = typer.Argument(..., help="The library book id (see `stats`/`/books`)."),
    rating: int = typer.Argument(..., help="1-5 to set, or 0 to clear the in-app rating."),
) -> None:
    """Re-rate a book in-app (overrides the imported Goodreads rating)."""
    from .library import BookNotFoundError, set_book_feedback

    try:
        _echo(set_book_feedback(book_id, rating=rating))
    except (BookNotFoundError, ValueError) as e:
        typer.secho(str(e), fg=typer.colors.RED)
        raise typer.Exit(code=1)
    typer.echo("\nProfile may now be stale — run `profile-status` / `reprofile`.")


@app.command(name="add")
def add_book_cmd(
    title: str = typer.Argument(..., help="Book title."),
    author: str = typer.Option(None, help="Author (improves the catalog match)."),
    rating: int = typer.Option(None, help="Optional 1-5 rating (feeds the taste profile)."),
    shelf: str = typer.Option("read", help="read | to-read | currently-reading | did-not-finish."),
    no_resolve: bool = typer.Option(
        False, help="Skip the catalog lookup (no cover/subjects/year backfill)."
    ),
) -> None:
    """Manually add a book to the library (resolves cover/metadata from the catalog)."""
    from . import catalog
    from .library import BookExistsError, add_book

    cover = subjects = year = isbn = src = cid = None
    if not no_resolve:
        query = f"{title} {author}".strip() if author else title
        hits = catalog.search_books(query, max_results=1)
        if hits:
            h = hits[0]
            cover, subjects = h.get("cover_url"), h.get("subjects")
            year, isbn = h.get("year"), h.get("isbn13")
            src, cid = h.get("source"), h.get("resolved_id")

    try:
        book_id = add_book(
            title=title, author=author, year=year, isbn13=isbn, shelf=shelf,
            rating=rating, cover_url=cover, subjects=subjects,
            catalog_source=src, catalog_id=cid,
        )
    except (BookExistsError, ValueError) as e:
        typer.secho(str(e), fg=typer.colors.RED)
        raise typer.Exit(code=1)
    typer.secho(f"Added book {book_id}: {title}", fg=typer.colors.GREEN)
    if rating:
        typer.echo("Rated — profile may now be stale; run `reprofile`.")


@app.command()
def review(
    book_id: int = typer.Argument(..., help="The library book id."),
    text: str = typer.Argument(None, help="Review text. Omit with --clear to remove."),
    clear: bool = typer.Option(False, help="Remove the existing review."),
) -> None:
    """Write (or clear) an in-app text review for a book."""
    from .library import BookNotFoundError, set_book_feedback

    if text is None and not clear:
        typer.secho("Provide review text, or pass --clear to remove it.", fg=typer.colors.RED)
        raise typer.Exit(code=1)
    try:
        _echo(set_book_feedback(book_id, review=text, clear_review=clear))
    except (BookNotFoundError, ValueError) as e:
        typer.secho(str(e), fg=typer.colors.RED)
        raise typer.Exit(code=1)
    typer.echo("\nProfile may now be stale — run `profile-status` / `reprofile`.")


@app.command(name="profile-status")
def profile_status_cmd() -> None:
    """Show whether ratings/reviews changed since the profile was last built."""
    from .library import profile_status

    status = profile_status()
    _echo(status)
    if status["dirty"]:
        typer.secho(
            f"\nProfile is stale ({status['changed_books']} changed book(s)). "
            "Run `reprofile` to refresh.",
            fg=typer.colors.YELLOW,
        )
    else:
        typer.secho("\nProfile is up to date.", fg=typer.colors.GREEN)


@app.command()
def reprofile(
    full: bool = typer.Option(
        False, help="Force a full rebuild instead of the incremental update."
    ),
) -> None:
    """Refresh the taste profile (incremental by default; --full to rebuild)."""
    from rich.console import Console

    from .profile import extract_taste_profile, update_taste_profile

    console = Console()
    runner = extract_taste_profile if full else update_taste_profile
    try:
        with console.status("[bold]Re-profiling with Claude…", spinner="dots"):
            result = runner()
    except RuntimeError as e:
        typer.secho(str(e), fg=typer.colors.RED)
        raise typer.Exit(code=1)
    if result.get("note"):
        typer.secho(result["note"], fg=typer.colors.YELLOW)
    _echo(result)
    typer.echo("\nRun `python -m mylibrary.cli traits` to read the refreshed profile.")


@app.command()
def traits() -> None:
    """Print the saved taste profile: each trait with its supporting books."""
    from .db import Book, TasteTrait, session_scope

    init_db()  # also migrates the taste_traits table shape if it's out of date
    with session_scope() as session:
        rows = (
            session.query(TasteTrait)
            .order_by(TasteTrait.polarity, TasteTrait.inference_confidence.desc())
            .all()
        )
        if not rows:
            typer.echo("No taste traits yet — run `profile` first.")
            return
        books = {b.id: b for b in session.query(Book).all()}

        def _line(bid: int) -> str | None:
            b = books.get(bid)
            if not b:
                return None
            star = b.effective_rating
            return f"        {b.title}" + (f"  ({star}★)" if star else "")

        for t in rows:
            mark = "▲ reward " if t.polarity == "reward" else "▼ aversion"
            typer.secho(
                f"\n{mark}  ({t.inference_confidence:.2f})  {t.claim}",
                fg=(typer.colors.GREEN if t.polarity == "reward" else typer.colors.RED),
            )
            if t.exhibits:
                typer.echo("   exhibits:")
                for bid in t.exhibits:
                    line = _line(bid)
                    if line:
                        typer.echo(line)
            if t.contrasts:
                typer.secho("   contrasts:", fg=typer.colors.BRIGHT_BLACK)
                for bid in t.contrasts:
                    line = _line(bid)
                    if line:
                        typer.secho(line, fg=typer.colors.BRIGHT_BLACK)


def _print_recs(recs: list[dict]) -> None:
    """Pretty-print a served recommendation set."""
    import typer as _typer

    if not recs:
        _typer.echo("No recommendations.")
        return
    for r in recs:
        pool = r.get("retrieval_pool") or "?"
        _typer.secho(
            f"\n{r['rank']:>2}. {r['title']}"
            + (f" — {r['author']}" if r.get("author") else "")
            + (f" ({r['year']})" if r.get("year") else ""),
            fg=_typer.colors.GREEN,
            bold=True,
        )
        _typer.echo(f"    fit {r.get('score', 0):.2f}  ·  via {pool}")
        if r.get("rationale"):
            _typer.echo(f"    {r['rationale']}")


@app.command()
def recommend(
    n: int = typer.Option(10, help="How many books to recommend."),
    metadata: bool = typer.Option(
        True, help="Use deterministic subject/author expansion for retrieval."
    ),
    claude_seeds: bool = typer.Option(
        True, help="Also let Claude propose catalog search queries (needs API key)."
    ),
    rps: float = typer.Option(None, help="Catalog requests per second."),
) -> None:
    """Two-stage recommender: retrieve real catalog candidates, then Claude reranks/explains."""
    from rich.console import Console

    console = Console()
    try:
        with console.status("[bold]Retrieving candidates + reranking with Claude…", spinner="dots"):
            result = run_recommend(
                n=n,
                use_metadata=metadata,
                use_claude_seeds=claude_seeds,
                requests_per_second=rps,
            )
    except RuntimeError as e:
        typer.secho(str(e), fg=typer.colors.RED)
        raise typer.Exit(code=1)

    if result.get("note"):
        typer.secho(result["note"], fg=typer.colors.YELLOW)
    typer.echo(
        f"run {result.get('run_id')}  ·  {result['served']} served "
        f"from {result['candidates']} candidates "
        f"(metadata={result.get('pool_metadata', 0)}, seed={result.get('pool_seed', 0)})"
    )
    _print_recs(result.get("recommendations", []))


@app.command()
def recs() -> None:
    """Reprint the most recent recommendation run."""
    from .db import session_scope
    from .recommend import latest_recommendations

    init_db()
    with session_scope() as session:
        rows = latest_recommendations(session)
        out = [
            {
                "rank": r.rank,
                "title": r.title,
                "author": r.author,
                "year": r.year,
                "score": r.score,
                "rationale": r.rationale,
                "retrieval_pool": r.retrieval_pool,
            }
            for r in rows
        ]
    if not out:
        typer.echo("No recommendations yet — run `python -m mylibrary.cli recommend`.")
        return
    _print_recs(out)


@app.command()
def stats() -> None:
    """Print dataset statistics."""
    _echo(dataset_stats())


@app.command()
def serve(
    host: str = "127.0.0.1",
    port: int = 8000,
    reload: bool = True,
) -> None:
    """Launch the FastAPI service (uvicorn)."""
    import uvicorn

    uvicorn.run("mylibrary.api:app", host=host, port=port, reload=reload)


if __name__ == "__main__":
    app()
