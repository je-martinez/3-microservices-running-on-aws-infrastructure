from pathlib import Path

import pytest

from diagrams3mrai.catalog import Entry
from diagrams3mrai.gate import (
    ICON_PREFIX, check_entry, check_icons, filter_self_check, image_hrefs, load_icons, load_verify, orphans,
    self_check_available, view_box_width,
)

FIX = Path(__file__).parent / "fixtures"
LAMBDA = ICON_PREFIX + "architecture-service/AWSLambda.svg"
ALLOWED = {LAMBDA}


def svg(body: str, width: int = 400) -> str:
    return f'<svg viewBox="0 0 {width} 200" role="img">{body}</svg>'


def test_load_icons_builds_full_urls():
    icons = load_icons()
    assert icons["lambda"] == LAMBDA
    assert all(u.startswith(ICON_PREFIX) and u.endswith(".svg") for u in icons.values())


def test_load_icons_rejects_bad_path(tmp_path):
    p = tmp_path / "icons.yaml"
    p.write_text("icons:\n  x: ../evil.svg\n")
    with pytest.raises(ValueError, match="x"):
        load_icons(p)


def test_image_hrefs_reads_href_and_xlink():
    html = svg(f'<image href="{LAMBDA}"/><image xlink:href="https://x/y.svg"/>')
    assert image_hrefs(html) == [LAMBDA, "https://x/y.svg"]


def test_allowed_icon_passes():
    assert check_icons(svg(f'<image href="{LAMBDA}"/>'), ALLOWED) == []


def test_unpinned_version_fails():
    url = "https://cdn.jsdelivr.net/npm/aws-icons@latest/icons/architecture-service/AWSLambda.svg"
    assert check_icons(svg(f'<image href="{url}"/>'), ALLOWED) == [f"icon not in diagrams/icons.yaml: {url}"]


def test_unlisted_icon_fails():
    url = ICON_PREFIX + "architecture-service/AWSLambdaa.svg"
    assert check_icons(svg(f'<image href="{url}"/>'), ALLOWED) == [f"icon not in diagrams/icons.yaml: {url}"]


def test_prefix_match_alone_is_not_enough():
    # self_check truncates URLs to 80 chars, so the filter cannot tell these apart; check_icons must.
    url = ICON_PREFIX + "resource/NotInTheManifestButSamePrefix.svg"
    errors = [f"remote reference on <image>: {url[:80]}"]
    assert filter_self_check(errors) == []
    assert check_icons(svg(f'<image href="{url}"/>'), ALLOWED) != []


def test_filter_keeps_every_other_error():
    errors = [
        f"remote reference on <image>: {LAMBDA[:80]}",
        "remote reference on <image>: https://example.com/x.svg",
        "remote reference on <script>: " + ICON_PREFIX,
        "svg 1 needs role=img",
    ]
    assert filter_self_check(errors) == errors[1:]


def test_view_box_width():
    assert view_box_width(svg("", 1996)) == 1996
    assert view_box_width("<p>no svg</p>") is None


def entry(tmp_path: Path, html: str | None, id_: str = "ok") -> Entry:
    src = f"diagrams/src/flows/{id_}.html"
    if html is not None:
        (tmp_path / "diagrams/src/flows").mkdir(parents=True, exist_ok=True)
        (tmp_path / src).write_text(html)
    return Entry(id_, "Ok", src, f"docs/x/{id_}", ())


def no_errors(_: Path) -> list[str]:
    return []


def test_check_entry_ok(tmp_path):
    e = entry(tmp_path, (FIX / "ok.html").read_text())
    assert check_entry(e, ALLOWED, no_errors, tmp_path) == []


def test_missing_src_fails(tmp_path):
    e = entry(tmp_path, None)
    assert check_entry(e, ALLOWED, no_errors, tmp_path) == ["ok: missing source diagrams/src/flows/ok.html"]


def test_too_wide_fails(tmp_path):
    e = entry(tmp_path, svg("", 2004))
    assert "ok: viewBox width 2004 exceeds 2000" in check_entry(e, ALLOWED, no_errors, tmp_path)


def test_self_check_errors_are_filtered_and_prefixed(tmp_path):
    e = entry(tmp_path, (FIX / "ok.html").read_text())
    verify = lambda _: [f"remote reference on <image>: {LAMBDA[:80]}", "svg 1 needs role=img"]
    assert check_entry(e, ALLOWED, verify, tmp_path) == ["ok: svg 1 needs role=img"]


def test_orphan_html_fails(tmp_path):
    e = entry(tmp_path, svg(""))
    (tmp_path / "diagrams/src/flows/stray.html").write_text(svg(""))
    assert orphans([e], tmp_path) == ["diagrams/src/flows/stray.html has no catalog entry"]


@pytest.mark.skipif(not self_check_available(), reason="diagram-design plugin not installed")
def test_real_self_check_accepts_fixture_after_filter():
    assert filter_self_check(load_verify()(FIX / "ok.html")) == []


def test_missing_png_fails(tmp_path):
    from diagrams3mrai.gate import missing_renders
    e = entry(tmp_path, svg(""))
    assert missing_renders([e], tmp_path) == ["ok: missing render docs/x/ok.png (make diagrams-render ID=ok)"]
    (tmp_path / "docs/x").mkdir(parents=True)
    (tmp_path / "docs/x/ok.png").write_bytes(b"png")
    assert missing_renders([e], tmp_path) == []


def test_missing_png_is_not_reported_before_the_source_exists(tmp_path):
    from diagrams3mrai.gate import missing_renders
    assert missing_renders([entry(tmp_path, None)], tmp_path) == []
