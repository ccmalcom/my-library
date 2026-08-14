#!/usr/bin/env python3
"""Claude Code Stop hook for MyLibrary.

Runs when Claude finishes a turn. Inspects uncommitted changes and runs targeted
verification on the files that changed, so regressions surface before you hit
them manually:

  - frontend `tsc --noEmit`            (any frontend .ts/.tsx changed)
  - eslint on changed frontend files   (if eslint is installed)
  - prettier --check on changed files  (if prettier is installed)
  - nudge when code changed but no .md  (docs convention)

Checks run on changed files only, so a clean turn stays quiet and you are not
blocked by pre-existing debt in files Claude did not touch. Node tools are
skipped silently until their package appears in frontend/node_modules. On any
finding it writes to stderr and exits 2, feeding the message back to Claude so it
keeps working. `stop_hook_active` is honored as a loop guard (fires at most once
per stop cycle).

Read-only with respect to git (only `git diff` / `git ls-files`).
"""
import json
import os
import shlex
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


def run(cmd, cwd):
    return subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, shell=isinstance(cmd, str)
    )


def tail(text, n=25):
    return "\n".join(text.strip().splitlines()[-n:])


def sh_args(paths):
    """Shell-quote paths for the npm commands, which run through `sh -c`.

    Load-bearing for Next.js route groups: `app/(main)/settings/page.tsx` contains
    parentheses, which `sh` reads as a subshell and dies on with a syntax error
    *before* eslint or prettier is invoked. The hook then reports a tool failure
    for a tool that never ran, which is indistinguishable from a real lint error.
    Spaces and quotes in filenames break the same way.
    """
    return " ".join(shlex.quote(p) for p in paths)


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
    docs = [c for c in changed if c.endswith(".md")]
    code = [c for c in changed if c.endswith((".py", ".ts", ".tsx"))]
    fe = [c for c in changed if c.startswith("frontend/")]
    fe_lint = [c[len("frontend/"):] for c in fe if c.endswith(ESLINT_EXT)]
    fe_fmt = [c[len("frontend/"):] for c in fe if c.endswith(PRETTIER_EXT)]

    fe_dir = root / "frontend"
    msgs = []

    # --- frontend type-check ---
    if ts:
        r = run("npm run -s type-check", fe_dir)
        if r.returncode != 0:
            msgs.append("[type-check FAILED] frontend tsc --noEmit\n" + tail(r.stdout + r.stderr))

    # --- eslint on changed frontend files ---
    if fe_lint and (fe_dir / "node_modules" / "eslint").exists():
        r = run("npm exec --no -- eslint " + sh_args(fe_lint), fe_dir)
        if r.returncode != 0:
            msgs.append("[eslint FAILED]\n" + tail(r.stdout + r.stderr))

    # --- prettier --check on changed frontend files ---
    if fe_fmt and (fe_dir / "node_modules" / "prettier").exists():
        r = run("npm exec --no -- prettier --check " + sh_args(fe_fmt), fe_dir)
        if r.returncode != 0:
            msgs.append(
                "[prettier FAILED] (run `npm run format` in frontend/ to fix)\n"
                + tail(r.stdout + r.stderr)
            )

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
