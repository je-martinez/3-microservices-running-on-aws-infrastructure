"""Unit tests for the subagent frontmatter normalizer.

Folds block scalars into single-line double-quoted strings so downstream
consumers with limited YAML parsers read the value rather than the literal
block indicator ('>-'). All nine of this repo's subagents use
`description: >-`, so without folding, any consumer that can't parse block
scalars would read an empty description. Normalizing at the boundary means
we never depend on a downstream parser's block-scalar support.
"""
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from normalize_agent_frontmatter import (  # noqa: E402
    fold_block_scalars,
    normalize_file,
    split_frontmatter,
)


def test_split_frontmatter_extracts_block_and_body():
    text = "---\nname: a\n---\nbody line\n"
    fm, body = split_frontmatter(text)
    assert fm == "name: a\n"
    assert body == "body line\n"


def test_split_frontmatter_returns_none_without_delimiters():
    text = "no frontmatter here\n"
    fm, body = split_frontmatter(text)
    assert fm is None
    assert body == text


def test_folded_scalar_becomes_single_line():
    fm = "name: x\ndescription: >-\n  first part\n  second part\n"
    out, folded = fold_block_scalars(fm)
    assert folded == ["description"]
    assert yaml.safe_load(out)["description"] == "first part second part"


def test_literal_scalar_is_folded_too():
    fm = "description: |\n  line one\n  line two\n"
    out, folded = fold_block_scalars(fm)
    assert folded == ["description"]
    assert yaml.safe_load(out)["description"] == "line one line two"


def test_plain_scalars_are_untouched():
    fm = 'name: users-impl\nmodel: opus\ndescription: "already flat"\n'
    out, folded = fold_block_scalars(fm)
    assert folded == []
    assert yaml.safe_load(out) == yaml.safe_load(fm)


def test_nested_list_values_are_preserved():
    fm = "name: x\nskills:\n  - one\n  - two\ndescription: >-\n  text\n"
    out, folded = fold_block_scalars(fm)
    assert folded == ["description"]
    assert yaml.safe_load(out)["skills"] == ["one", "two"]


def test_quotes_and_backslashes_are_escaped():
    fm = 'description: >-\n  say "hi" and c:\\path\n'
    out, _ = fold_block_scalars(fm)
    assert yaml.safe_load(out)["description"] == r'say "hi" and c:\path'


def test_normalize_file_is_idempotent(tmp_path):
    src = tmp_path / "a.md"
    src.write_text("---\nname: x\ndescription: >-\n  a b\n---\nbody\n", encoding="utf-8")
    first = tmp_path / "first.md"
    second = tmp_path / "second.md"
    normalize_file(src, first)
    normalize_file(first, second)
    assert first.read_text(encoding="utf-8") == second.read_text(encoding="utf-8")


def test_normalize_file_preserves_body_and_other_fields(tmp_path):
    src = tmp_path / "a.md"
    src.write_text(
        "---\nname: users-impl\ntools: Read, Write\ndescription: >-\n  one\n  two\n---\n"
        "# Heading\n\nBody text.\n",
        encoding="utf-8",
    )
    dst = tmp_path / "out.md"
    folded = normalize_file(src, dst)
    fm, body = split_frontmatter(dst.read_text(encoding="utf-8"))
    data = yaml.safe_load(fm)
    assert folded == ["description"]
    assert data["tools"] == "Read, Write"
    assert data["name"] == "users-impl"
    assert body == "# Heading\n\nBody text.\n"


def test_file_without_frontmatter_is_copied_verbatim(tmp_path):
    src = tmp_path / "a.md"
    src.write_text("just text\n", encoding="utf-8")
    dst = tmp_path / "out.md"
    assert normalize_file(src, dst) == []
    assert dst.read_text(encoding="utf-8") == "just text\n"
