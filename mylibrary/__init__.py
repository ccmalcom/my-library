"""MyLibrary — a personal, AI-powered book analysis engine built on a Goodreads export.

MVP1 scope: the offline analysis pipeline — ingest -> enrich -> taste profile.
Exposed both as a CLI (offline batch) and a FastAPI service (the future TS frontend
will call this over HTTP).
"""

__version__ = "0.1.0"
