#!/usr/bin/env python3
"""Claude Code Stop hook for MyLibrary.

Runs when Claude finishes a turn. Inspects uncommitted changes and runs targeted
verification on the files that changed, so regressions surface before you hit
them manually:

  - frontend `tsc --noEmit`            (any frontend .ts/.tsx changed)
  - `ruff check` on changed .py        (if ruff is installed)
  - eslint on changed frontend files   (if eslint is installed)
  - prettier --check on changed files  (if prettier is installed)
  - `pytest -q`                        (any tracked .py changed; venv interpreter)
  - nudge when code changed but no .md  (docs convention)

Linters/tests run on changed files only, so a clean turn stays quiet and you are
not blocked by pre-existing debt in files Claude did not touch. Node tools are
skipped silently until their package appears in frontend/node_modules, and ruff
is skipped until it is installed -- so this never breaks before `npm install` /
`pip install -r requirements.txt`. On any finding it writes to stderr and exits
2, feeding the message back to Claude so it keeps working. `stop_hook_active` is
honored as a loop guard (fires at most once per stop cycle).

Read-only with respect to git (only `git diff` / `git ls-files`).
"""
import json
import os
import subprocess
import sys
from pathlib import Path

ESLINT_EXT = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")
PRETTIER_EXT = ESLINT_EXT + (".json", ".css", ".scss", ".md")


def git(root, *args):
    try:
        return subprocess.run(
            ["git", *args], cwd=root, capture_output=True, text=True
        ).stdout
    except Exception:
        return ""


def venv_python(root):
    for rel in (".venv/Scripts/python.exe", ".venv/bin/python"):
        p = root / rel
        if p.exists():
            return str(p)
    return sys.executable


def run(cmd, cwd):
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, shell=isinstance(cmd, str)
    )


def tail(text, n=25):
    return "\n".join(text.strip().splitlines()[-n:])


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("stop_hook_active"):
        return 0

    root = Path(os.environ.get("CLAUDE_PROJECT_DIR", ".")).resolve()

    changed = set()
    changed.update(git(root, "diff", "--name-only", "HEAD").split())
    changed.update(git(root, "ls-files", "--others", "--exclude-standard").split())
    changed = {c for c in changed if c}
    if not changed:
        return 0

    ts = [c for c in changed if c.startswith("frontend/") and c.endswith((".ts", ".tsx"))]
    py = [c for c in changed if c.endswith(".py") and not c.startswith("alembic/versions/")]
    docs = [c for c in changed if c.endswith(".md")]
    code = [c for c in changed if c.endswith((".py", ".ts", ".tsx"))]
    fe = [c for c in changed if c.startswith("frontend/")]
    fe_lint = [c[len("frontend/"):] for c in fe if c.endswith(ESLINT_EXT)]
    fe_fmt = [c[len("frontend/"):] for c in fe if c.endswith(PRETTIER_EXT)]

    fe_dir = root / "frontend"
    vp = venv_python(root)
    msgs = []

    # --- frontend type-check ---
    if ts:
        r = run("npm run -s type-check", fe_dir)
        if r.returncode != 0:
            msgs.append("[type-check FAILED] frontend tsc --noEmit\n" + tail(r.stdout + r.stderr))

    # --- ruff on changed .py ---
    if py and run([vp, "-m", "ruff", "--version"], root).returncode == 0:
        r = run([vp, "-m", "ruff", "check", *py], root)
        if r.returncode != 0:
            msgs.append("[ruff FAILED]\n" + tail(r.stdout + r.stderr))

    # --- eslint on changed frontend files ---
    if fe_lint and (fe_dir / "node_modules" / "eslint").exists():
        r = run("npm exec --no -- eslint " + " ".join(fe_lint), fe_dir)
        if r.returncode != 0:
            msgs.append("[eslint FAILED]\n" + tail(r.stdout + r.stderr))

    # --- prettier --check on changed frontend files ---
    if fe_fmt and (fe_dir / "node_modules" / "prettier").exists():
        r = run("npm exec --no -- prettier --check " + " ".join(fe_fmt), fe_dir)
        if r.returncode != 0:
            msgs.append(
                "[prettier FAILED] (run `npm run format` in frontend/ to fix)\n"
                + tail(r.stdout + r.stderr)
            )

    # --- pytest on changed .py ---
    if py:
        r = run([vp, "-m", "pytest", "-q"], root)
        if r.returncode != 0:
            msgs.append("[pytest FAILED]\n" + tail(r.stdout + r.stderr))

    # --- docs drift ---
    if code and not docs:
        msgs.append(
            "[docs reminder] Code changed but no .md was updated. Per project "
            "convention, update the relevant docs (CLAUDE.md or docs/*.md) to match."
        )

    if msgs:
        sys.stderr.write("\n\n".join(msgs) + "\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
