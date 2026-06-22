"""Command-line interface for offline batch runs.

  python -m mylibrary.cli initdb
  python -m mylibrary.cli ingest [PATH]      # defaults to data/goodreads_library_export.csv
  python -m mylibrary.cli enrich [--force] [--limit N] [--include-unrated]
  python -m mylibrary.cli profile
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
