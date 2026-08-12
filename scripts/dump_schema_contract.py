"""Dump the model-declared column contract for the Node schema mirrors to check against.

The Alembic baseline builds the database from Base.metadata.create_all(), so the
SQLAlchemy models are the authoritative source for nullability and SERVER defaults.
ORM-level defaults (Column(default=0)) are deliberately NOT included: they are applied
by Python at insert time and are invisible to any other client, which is exactly the
distinction that broke POST /enrich/start.

Run: .venv/bin/python scripts/dump_schema_contract.py
"""

from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# The venv has no editable install of the project, so importing mylibrary from a
# bare `.venv/bin/python scripts/...` invocation fails without this.
sys.path.insert(0, str(ROOT))

from mylibrary.db import Base  # noqa: E402

OUT = ROOT / "frontend/lib/server/__tests__/fixtures/schema-contract.json"


def server_default(column) -> str | None:
    if column.server_default is None:
        return None
    arg = column.server_default.arg
    return str(getattr(arg, "text", arg))


def main() -> None:
    contract = {
        name: {
            column.name: {
                "nullable": bool(column.nullable),
                "serverDefault": server_default(column),
            }
            for column in table.columns
        }
        for name, table in sorted(Base.metadata.tables.items())
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(contract, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(contract)} tables)")


if __name__ == "__main__":
    main()
