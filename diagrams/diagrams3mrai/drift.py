"""Warn about diagrams whose watched sources changed since a base ref without a re-render. Never fails."""

import os
import subprocess
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Literal

from diagrams3mrai.catalog import REPO_ROOT, Entry, load_catalog

# Rendering inputs every diagram depends on: a change here may alter any render.
SHARED_RENDER_GLOBS = (
    "diagrams/diagrams3mrai/render.py",
    "diagrams/icons.yaml",
    "diagrams/pyproject.toml",
    ".diagram-design",
)
# Tests never change what a diagram depicts, so they never make one stale.
TEST_GLOBS = ("**/*.test.*", "**/*.spec.*", "**/*_test.go", "**/test/**", "**/tests/**", "**/__tests__/**")


@dataclass(frozen=True)
class DriftResult:
    id: str
    status: Literal["stale", "updated"]
    matches: tuple[str, ...]


def _matches(path: str, globs: tuple[str, ...]) -> bool:
    p = PurePosixPath(path)
    return any(p.full_match(g) for g in globs)


def affected(changed: list[str], entries: list[Entry]) -> list[DriftResult]:
    relevant = [f for f in changed if not _matches(f, TEST_GLOBS)]
    results = []
    for e in entries:
        globs = (*e.watches, e.src, *SHARED_RENDER_GLOBS)
        hits = tuple(f for f in relevant if _matches(f, globs))
        if not hits:
            continue
        results.append(DriftResult(e.id, "updated" if e.png in changed else "stale", hits))
    return results


def _git(*args: str) -> list[str]:
    out = subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=True).stdout
    return [line for line in out.splitlines() if line]


def main() -> int:
    base = os.environ.get("DIAGRAMS_BASE", "main")
    try:
        entries = load_catalog()
        local = [*_git("diff", "--name-only", "HEAD"), *_git("ls-files", "--others", "--exclude-standard")]
        try:
            merge_base = _git("merge-base", base, "HEAD")[0]
            changed = list(dict.fromkeys([*_git("diff", "--name-only", merge_base, "HEAD"), *local]))
        except (subprocess.CalledProcessError, IndexError):
            print(f'diagrams-check: warning — base "{base}" could not be resolved; checking uncommitted changes only')
            changed = list(dict.fromkeys(local))
        results = affected(changed, entries)
    except Exception as exc:  # WHY: a drift report must never break the caller (audit, PR prep).
        print(f"diagrams-check: skipped ({exc})")
        return 0
    if not results:
        print(f"diagrams-check: no diagram watches a path changed since {base}")
        return 0
    for r in results:
        mark = "STALE?  " if r.status == "stale" else "updated "
        more = ", …" if len(r.matches) > 3 else ""
        print(f"{mark} {r.id}  ← {', '.join(r.matches[:3])}{more}")
    stale = sum(r.status == "stale" for r in results)
    print(f"\n{stale} possibly stale. Re-render (make diagrams-render ID=<id>) or justify in the PR. See [[diagrams]].")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
