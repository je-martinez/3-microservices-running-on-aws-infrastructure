from pathlib import Path

import pytest

from diagrams3mrai.catalog import CATALOG_PATH, Entry, load_catalog, select


def write(tmp_path: Path, body: str) -> Path:
    p = tmp_path / "catalog.yaml"
    p.write_text(body)
    return p


GOOD = """
entries:
  - id: arch
    title: Arch
    src: diagrams/src/architecture/arch.html
    output: docs/00-overview/diagrams/arch
    watches: ["infra/modules/**"]
  - id: otp
    title: OTP
    src: diagrams/src/flows/otp.html
    output: docs/domains/users/specs/diagrams/otp
    watches: []
"""


def test_loads_entries_and_png_path(tmp_path):
    entries = load_catalog(write(tmp_path, GOOD))
    assert [e.id for e in entries] == ["arch", "otp"]
    assert entries[0].png == "docs/00-overview/diagrams/arch.png"
    assert entries[0].watches == ("infra/modules/**",)


def test_duplicate_id_raises(tmp_path):
    body = GOOD.replace("id: otp", "id: arch")
    with pytest.raises(ValueError, match="duplicate catalog ids: \\['arch'\\]"):
        load_catalog(write(tmp_path, body))


@pytest.mark.parametrize(
    "bad_src",
    ["diagrams/src/other/arch.html", "diagrams/src/architecture/wrong.html", "diagrams/src/architecture/arch.svg"],
)
def test_src_must_be_group_slash_id_html(tmp_path, bad_src):
    body = GOOD.replace("diagrams/src/architecture/arch.html", bad_src)
    with pytest.raises(ValueError, match="arch: src"):
        load_catalog(write(tmp_path, body))


@pytest.mark.parametrize("bad_output", ["out/arch", "docs/00-overview/diagrams/arch.png"])
def test_output_must_be_docs_path_without_extension(tmp_path, bad_output):
    body = GOOD.replace("docs/00-overview/diagrams/arch", bad_output, 1)
    with pytest.raises(ValueError, match="arch: output"):
        load_catalog(write(tmp_path, body))


def test_select_empty_returns_all(tmp_path):
    entries = load_catalog(write(tmp_path, GOOD))
    assert select(entries, []) == entries


def test_select_unknown_id_raises(tmp_path):
    entries = load_catalog(write(tmp_path, GOOD))
    with pytest.raises(KeyError, match="typo"):
        select(entries, ["arch", "typo"])


def test_real_catalog_has_29_entries():
    assert len(load_catalog(CATALOG_PATH)) == 29
