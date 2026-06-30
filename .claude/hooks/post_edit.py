#!/usr/bin/env python3
"""Claude Code PostToolUse hook for MyLibrary.

Fires after an Edit/Write/MultiEdit. Reads the hook payload (JSON on stdin) and
prints file-specific reminders to stderr. Exit code 2 surfaces the message to
Claude (the tool has already run, so this informs rather than blocks).

Currently: nudge to add an idempotent Alembic migration whenever the ORM models
in mylibrary/db.py change (guards against the 0001 create_all baseline trap).
"""
import json
import sys


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    fp = (data.get("tool_input") or {}).get("file_path", "") or ""
    fp = fp.replace("\\", "/")

    if fp.endswith("mylibrary/db.py"):
        sys.stderr.write(
            "[alembic reminder] mylibrary/db.py changed. If you altered the ORM "
            "schema (new column/table/constraint), add an *idempotent* Alembic "
            "migration under alembic/versions/ -- inspect the bind and skip if "
            "the object already exists. Mind the 0001 create_all baseline trap; "
            "do not rely on create_all in prod.\n"
        )
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
