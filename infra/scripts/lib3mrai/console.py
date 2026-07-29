"""Colored console output matching the formatting the bash scripts used.

Kept shape-compatible on purpose: this output is read live during
`make bootstrap`, and changing it would make diffing a failed run against a
known-good one harder than it needs to be.
"""

import sys

GREEN = "\033[0;32m"
RED = "\033[0;31m"
RESET = "\033[0m"


def ok(msg: str) -> None:
    """Success line: two-space indent, green OK marker."""
    print(f"  {GREEN}OK{RESET}: {msg}")


def no(msg: str) -> None:
    """Failure line. Goes to stderr so it survives stdout capture."""
    print(f"  {RED}NO{RESET}: {msg}", file=sys.stderr)


def inf(msg: str) -> None:
    """Neutral progress line, matching the bash `inf` helper's indent."""
    print(f"  {msg}")
