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
    progress: bool = typer.Option(True, help="Show a live progress bar."),
) -> None:
    """Resolve books to catalog metadata with a confidence score."""
    if not progress:
        _echo(enrich_library(force=force, limit=limit, include_unrated=include_unrated))
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
    ) as bar:
        task = bar.add_task("Enriching", total=None)

        def on_progress(done: int, total: int, title: str, label: str) -> None:
            bar.update(
                task,
                total=total,
                completed=done,
                description=f"Enriching [{label:10}] {title[:34]}",
            )

        result = enrich_library(
            force=force,
            limit=limit,
            include_unrated=include_unrated,
            progress=on_progress,
        )
    _echo(result)


@app.command()
def profile() -> None:
    """Extract the evidence-backed taste profile (needs ANTHROPIC_API_KEY)."""
    try:
        _echo(extract_taste_profile())
    except RuntimeError as e:
        typer.secho(str(e), fg=typer.colors.RED)
        raise typer.Exit(code=1)


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
