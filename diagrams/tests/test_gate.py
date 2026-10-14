from pathlib import Path

import pytest

from diagrams3mrai.catalog import Entry
from diagrams3mrai.gate import (
    DEVICON_PREFIX, ICON_PREFIX, VENDOR_PREFIX, check_entry, check_icons, filter_self_check, image_hrefs, load_icons, load_verify, orphans,
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
    assert all(u.startswith((ICON_PREFIX, DEVICON_PREFIX, VENDOR_PREFIX)) and u.endswith((".svg", ".png")) for u in icons.values())


def test_load_icons_reads_the_devicon_section():
    icons = load_icons()
    assert icons["docker"] == DEVICON_PREFIX + "docker/docker-original.svg"


def test_load_icons_rejects_bad_devicon_path(tmp_path):
    p = tmp_path / "icons.yaml"
    p.write_text("icons:\n  lambda: architecture-service/AWSLambda.svg\ndevicon:\n  d: ../docker/x.svg\n")
    with pytest.raises(ValueError, match="d"):
        load_icons(p)


def test_load_icons_rejects_a_key_in_both_sections(tmp_path):
    p = tmp_path / "icons.yaml"
    p.write_text("icons:\n  x: architecture-service/AWSLambda.svg\ndevicon:\n  x: docker/docker-original.svg\n")
    with pytest.raises(ValueError, match="x"):
        load_icons(p)


def test_load_icons_reads_the_vendor_section():
    icons = load_icons()
    assert icons["stripe"].startswith(VENDOR_PREFIX + "stripe/stripe-ios@")
    assert icons["openobserve"].startswith(VENDOR_PREFIX + "openobserve/openobserve@v")


@pytest.mark.parametrize("rel", [
    "stripe/stripe-ios@master/logo.svg",
    "stripe/stripe-ios@latest/logo.svg",
    "stripe/stripe-ios/logo.svg",
    "stripe/stripe-ios@1.0.0/../evil.svg",
    "stripe/stripe-ios@1.0.0/logo.js",
    "geoapify/sdk@cb2da5f/logo.png",
])
def test_load_icons_rejects_an_unpinned_or_unsafe_vendor_path(tmp_path, rel):
    p = tmp_path / "icons.yaml"
    p.write_text(f"vendor:\n  v: {rel}\n")
    with pytest.raises(ValueError, match="v"):
        load_icons(p)


@pytest.mark.parametrize("rel", [
    "stripe/stripe-ios@26.14.0/a/BrandIcon--stripe.svg",
    "openobserve/openobserve@v0.92.2/web/mini_logo.svg",
    "geoapify/route-planner-sdk@cb2da5f18aee1efa35eb85ab948ffe8e17fcf9a8/docs/geoapify-logo-new-125x125.png",
])
def test_load_icons_accepts_a_tag_or_full_sha_vendor_path(tmp_path, rel):
    p = tmp_path / "icons.yaml"
    p.write_text(f"vendor:\n  v: {rel}\n")
    assert load_icons(p) == {"v": VENDOR_PREFIX + rel}


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


def test_filter_tolerates_devicon_but_check_icons_still_validates():
    url = DEVICON_PREFIX + "docker/docker-plain.svg"
    assert filter_self_check([f"remote reference on <image>: {url[:80]}"]) == []
    assert check_icons(svg(f'<image href="{url}"/>'), ALLOWED) == [f"icon not in diagrams/icons.yaml: {url}"]


def test_unpinned_devicon_is_not_tolerated():
    url = "https://cdn.jsdelivr.net/npm/devicon@latest/icons/docker/docker-original.svg"
    assert filter_self_check([f"remote reference on <image>: {url[:80]}"]) != []


def test_filter_tolerates_vendor_but_check_icons_still_validates():
    url = VENDOR_PREFIX + "someone/else@1.0.0/logo.svg"
    assert filter_self_check([f"remote reference on <image>: {url[:80]}"]) == []
    assert check_icons(svg(f'<image href="{url}"/>'), ALLOWED) == [f"icon not in diagrams/icons.yaml: {url}"]


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


CLIPPED_LABEL = (
    '<rect x="100" y="96" width="40" height="12" rx="2" fill="#f5f5f5"/>'
    '<rect x="120" y="80" width="120" height="60" rx="6" fill="#fff"/>'
)


@pytest.mark.skipif(not self_check_available(), reason="diagram-design plugin not installed")
def test_real_verify_flags_a_label_clipped_by_a_later_node(tmp_path):
    src = tmp_path / "clipped.html"
    src.write_text((FIX / "ok.html").read_text().replace("</svg>", CLIPPED_LABEL + "</svg>"))
    errors = filter_self_check(load_verify()(src))
    assert any("label mask" in e and "clipped by node" in e for e in errors)


@pytest.mark.skipif(not self_check_available(), reason="diagram-design plugin not installed")
def test_real_verify_passes_the_ok_fixture_geometry(tmp_path):
    assert filter_self_check(load_verify()(FIX / "ok.html")) == []


@pytest.mark.skipif(not self_check_available(), reason="diagram-design plugin not installed")
def test_real_verify_passes_a_valid_motion_diagram():
    assert filter_self_check(load_verify()(FIX / "motion-ok.html")) == []


@pytest.mark.skipif(not self_check_available(), reason="diagram-design plugin not installed")
def test_real_verify_runs_verify_motion_on_a_motion_root(tmp_path):
    src = tmp_path / "count.html"
    src.write_text((FIX / "motion-ok.html").read_text().replace('data-step-count="8"', 'data-step-count="7"'))
    errors = load_verify()(src)
    assert "motion item data-step falls outside declared step count" in errors


@pytest.mark.skipif(not self_check_available(), reason="diagram-design plugin not installed")
def test_real_verify_skips_verify_motion_on_a_static_diagram():
    assert not any("data-motion-root" in e for e in load_verify()(FIX / "ok.html"))


def _fake_install(root: Path, version: str) -> Path:
    path = root / version / "skills/diagram-design/scripts/self_check.py"
    path.parent.mkdir(parents=True)
    path.write_text("")
    return path


def test_locate_self_check_picks_the_newest_installed_version(tmp_path, monkeypatch):
    from diagrams3mrai.gate import locate_self_check
    monkeypatch.delenv("DIAGRAM_DESIGN_SELF_CHECK", raising=False)
    _fake_install(tmp_path, "2.6.6")
    newest = _fake_install(tmp_path, "2.6.98")
    _fake_install(tmp_path, "2.6.10")
    assert locate_self_check(tmp_path) == newest


def test_locate_self_check_without_an_install_names_the_plugin(tmp_path, monkeypatch):
    from diagrams3mrai.gate import GateSetupError, locate_self_check
    monkeypatch.delenv("DIAGRAM_DESIGN_SELF_CHECK", raising=False)
    with pytest.raises(GateSetupError, match="diagram-design@diagram-design"):
        locate_self_check(tmp_path)
