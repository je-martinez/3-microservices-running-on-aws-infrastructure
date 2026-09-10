#!/usr/bin/env python3
"""Normalize Claude subagent frontmatter for consumers with weak YAML parsers.

Folds block scalars into single-line double-quoted strings, so a consumer that
cannot parse them reads the value, not the literal '>-' indicator.
"""

# CONTRACT: Stay deterministic — the same input bytes must always produce the
# same output bytes. Nothing here may depend on ordering, time, or model output,
# or parallel worktrees diverge.
#
# Usage: python scripts/normalize_agent_frontmatter.py <src_dir> <dst_dir>
from __future__ import annotations

import re
import sys
from pathlib import Path

# A top-level `key: >-` / `key: |` line opening a block scalar. Indented keys are
# left alone: only top-level subagent fields need folding, and rewriting nested
# structures risks changing meaning.
_BLOCK_SCALAR_RE = re.compile(r"^([A-Za-z_][\w-]*):[ \t]*([>|])([-+]?)[ \t]*$")

_DELIMITER = "---\n"


def split_frontmatter(text: str) -> tuple[str | None, str]:
    """Split leading `---` frontmatter from the body.

    Returns (frontmatter_without_delimiters, body). Returns (None, text) when
    the file has no leading frontmatter block.
    """
    if not text.startswith(_DELIMITER):
        return None, text
    end = text.find("\n" + _DELIMITER, len(_DELIMITER) - 1)
    if end == -1:
        return None, text
    return text[len(_DELIMITER):end + 1], text[end + 1 + len(_DELIMITER):]


def fold_block_scalars(fm: str) -> tuple[str, list[str]]:
    """Rewrite top-level block scalars as single-line double-quoted strings.

    Both folded (`>`) and literal (`|`) styles collapse to one line: the
    destination field is a description, where newlines carry no meaning.
    """
    lines = fm.split("\n")
    out: list[str] = []
    folded: list[str] = []
    i = 0
    while i < len(lines):
        match = _BLOCK_SCALAR_RE.match(lines[i])
        if match is None:
            out.append(lines[i])
            i += 1
            continue
        key = match.group(1)
        i += 1
        parts: list[str] = []
        while i < len(lines) and (lines[i].startswith((" ", "\t")) or not lines[i].strip()):
            parts.append(lines[i].strip())
            i += 1
        value = " ".join(p for p in parts if p).strip()
        value = value.replace("\\", "\\\\").replace('"', '\\"')
        out.append(f'{key}: "{value}"')
        folded.append(key)
    result = "\n".join(out)
    # CONTRACT: This string must always end in a newline — normalize_file
    # concatenates it straight against the closing "---" delimiter. The trailing
    # "" from the split is consumed by a block scalar opened on the LAST
    # frontmatter line, so restore it here rather than gluing the delimiter onto
    # the folded value.
    if not result.endswith("\n"):
        result += "\n"
    return result, folded


def normalize_file(src: Path, dst: Path) -> list[str]:
    """Normalize one markdown file. Returns the folded key names."""
    text = src.read_text(encoding="utf-8")
    fm, body = split_frontmatter(text)
    if fm is None:
        dst.write_text(text, encoding="utf-8")
        return []
    new_fm, folded = fold_block_scalars(fm)
    dst.write_text(f"{_DELIMITER}{new_fm}{_DELIMITER}{body}", encoding="utf-8")
    return folded


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    src_dir, dst_dir = Path(argv[1]), Path(argv[2])
    if not src_dir.is_dir():
        print(f"error: {src_dir} is not a directory", file=sys.stderr)
        return 1
    dst_dir.mkdir(parents=True, exist_ok=True)
    total = 0
    for src in sorted(src_dir.glob("*.md")):
        folded = normalize_file(src, dst_dir / src.name)
        total += len(folded)
        print(f"  {src.name}: folded {folded or '(none)'}")
    print(f"Total fields folded: {total}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
