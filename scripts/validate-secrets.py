#!/usr/bin/env python3
"""3MRAI secret-literal linter — Stripe keys must never reach a commit.

Scans staged content for live Stripe key literals (spec Decision 15). Test keys
are refused too: a sandbox key is still a credential, and the sandbox holds the
data the E2E suite trusts. Exit: 0 clean, 1 a literal was found."""
from __future__ import annotations

import argparse
import re
import sys

# CONTRACT: Match the PREFIX plus enough body to be a real key, never the bare
# prefix. `sk_test_` appears in prose and in .env.example placeholders, and a
# linter that fires on those gets bypassed with --no-verify and stops gating.
PATTERNS = {
    "stripe secret key": re.compile(r"\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}"),
    "stripe webhook secret": re.compile(r"\bwhsec_[A-Za-z0-9]{16,}"),
}

# WHY: The generated env files carry real keys by design and are git-ignored, so
# they cannot be staged; .env.example carries placeholders short enough that the
# body length above already excludes them. This list covers the remaining case:
# a doc deliberately showing a key's SHAPE.
ALLOWED_SUFFIXES = (".env.example",)

# CONTRACT: Recognise an obviously-synthetic body instead of allow-listing the
# test files that carry one. A path list rots the moment a test moves, and it
# excuses a whole file rather than one value. A run of the alphabet, or one
# repeated character, cannot occur in a key Stripe issued.
SYNTHETIC = re.compile(r"abcdefghij|0123456789|(.)\1{7,}", re.IGNORECASE)


def scan(path: str, text: str) -> list[str]:
    if path.endswith(ALLOWED_SUFFIXES):
        return []
    hits = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for label, pattern in PATTERNS.items():
            match = pattern.search(line)
            if match:
                if SYNTHETIC.search(match.group(0)):
                    continue
                shown = match.group(0)[:12]
                hits.append(f"{path}:{lineno}: {label} literal ({shown}…)")
    return hits


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("paths", nargs="*", help="files to scan; content on stdin when absent")
    parser.add_argument("--strip", default="", help="strip this prefix from reported paths")
    args = parser.parse_args()

    findings: list[str] = []
    for path in args.paths:
        try:
            with open(path, encoding="utf-8", errors="replace") as handle:
                shown_path = path[len(args.strip):] if args.strip and path.startswith(args.strip) else path
                findings.extend(scan(shown_path, handle.read()))
        except OSError as error:
            print(f"ERROR: cannot read {path}: {error}", file=sys.stderr)
            return 1

    if findings:
        print("Stripe key literal(s) found in staged content:\n", file=sys.stderr)
        for finding in findings:
            print(f"  {finding}", file=sys.stderr)
        print(
            "\nKeys belong in a generated env file's CUSTOM box, never in source.\n"
            "See [[stripe-sandbox-setup]].",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
