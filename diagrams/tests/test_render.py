import os
from pathlib import Path

import pytest

from diagrams3mrai.render import RenderError, render_png

FIX = Path(__file__).parent / "fixtures"
pytestmark = pytest.mark.skipif(os.environ.get("DIAGRAMS_OFFLINE") == "1", reason="needs network for jsDelivr icons")


def test_render_writes_png(tmp_path):
    out = tmp_path / "ok.png"
    render_png(FIX / "ok.html", out)
    assert out.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_render_fails_on_missing_icon(tmp_path):
    with pytest.raises(RenderError, match="DoesNotExist.svg"):
        render_png(FIX / "missing-icon.html", tmp_path / "x.png")


def test_render_static_frame(tmp_path):
    html = (FIX / "ok.html").read_text().replace(
        "<svg ", '<div data-motion-root data-frame="step-2"></div><svg ', 1
    )
    src = tmp_path / "motion.html"
    src.write_text(html)
    with pytest.raises(RenderError, match="data-frame"):
        render_png(src, tmp_path / "m.png")


def test_png_width_is_view_box_width_times_scale(tmp_path):
    out = tmp_path / "ok.png"
    render_png(FIX / "ok.html", out, scale=2)
    width = int.from_bytes(out.read_bytes()[16:20], "big")  # PNG IHDR width
    assert width == 400 * 2
