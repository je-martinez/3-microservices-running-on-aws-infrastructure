"""Render diagram-design sources to PNG beside their vault notes (static frame, opaque paper background)."""

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

from diagrams3mrai import gate
from diagrams3mrai.catalog import REPO_ROOT, load_catalog, select

MAX_BYTES = 2 * 1024 * 1024
_PIN_SVG_SIZE = (
    "() => { const s = document.querySelector('svg');"
    " const [, , w, h] = s.getAttribute('viewBox').split(/[\\s,]+/).map(Number);"
    " Object.assign(s.style, { width: w + 'px', height: h + 'px', maxWidth: 'none' }); }"
)


class RenderError(RuntimeError):
    pass


def render_png(src: Path, out: Path, scale: int = 2) -> None:
    failures: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(device_scale_factor=scale)
        page.on("requestfailed", lambda r: failures.append(f"{r.url} ({r.failure})"))
        page.on("response", lambda r: r.status >= 400 and failures.append(f"{r.url} (HTTP {r.status})"))
        page.goto(f"{src.resolve().as_uri()}?motion=static")
        page.wait_for_load_state("networkidle")
        page.evaluate("document.fonts.ready.then(() => true)")
        frame = page.evaluate("document.querySelector('[data-motion-root]')?.getAttribute('data-frame') ?? null")
        if frame not in (None, "static"):
            browser.close()
            raise RenderError(f"{src}: motion root has data-frame={frame!r}, expected 'static'")
        if failures:
            browser.close()
            raise RenderError(f"{src}: failed requests: {'; '.join(failures)}")
        # CONTRACT: pin the SVG to its viewBox size so the PNG is viewBox × scale, not stretched to the viewport.
        page.evaluate(_PIN_SVG_SIZE)
        out.parent.mkdir(parents=True, exist_ok=True)
        # WHY: opaque paper background — a transparent PNG with dark ink is unreadable in Obsidian's dark theme.
        page.locator("svg").first.screenshot(path=str(out), omit_background=False)
        browser.close()


def main(argv: list[str] | None = None) -> int:
    ids = list(sys.argv[1:] if argv is None else argv)
    if gate.main(ids) != 0:
        print("diagrams-render: gate failed; nothing rendered")
        return 1
    failed = 0
    for e in select(load_catalog(), ids):
        out = REPO_ROOT / e.png
        try:
            render_png(REPO_ROOT / e.src, out)
        except RenderError as exc:
            print(f"FAIL {e.id}: {exc}")
            failed += 1
            continue
        size = out.stat().st_size
        warn = f"  (warning: {size / 1048576:.1f} MB > 2 MB)" if size > MAX_BYTES else ""
        print(f"OK   {e.id} → {e.png}{warn}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
