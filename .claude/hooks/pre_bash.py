#!/usr/bin/env python3
"""Claude Code PreToolUse hook (Bash) for MyLibrary.

Blocks shell commands that would read the project's `.env` secrets file, while
allowing `.env.example`, `.env.local`, etc. Exit code 2 denies the tool call and
returns the message to Claude. Complements the Read/Edit deny rules in
settings.json, which a raw shell command (e.g. `cat .env`) would otherwise bypass.
"""
import json
import re
import sys

# Match a `.env` path token that is NOT part of `.env.example` / `.env.local`:
#   - not preceded by a word char or dot  -> `foo.env`, `..env` don't match
#   - not followed by a word char or dot  -> `.env.example` doesn't match
ENV_REF = re.compile(r"(?<![\w.])\.env(?![\w.])")


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    cmd = (data.get("tool_input") or {}).get("command", "") or ""
    if ENV_REF.search(cmd):
        sys.stderr.write(
            "[blocked] This command references the .env secrets file, which is "
            "off-limits. Use .env.example for the variable names instead.\n"
        )
        return 2

    return 0


if __name__ == "__main__":
    sys.exit(main())
