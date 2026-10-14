"""Fail-closed checks for diagram-design sources: skill self_check, icon allowlist, width cap, catalog parity."""

import importlib.util
import os
import re
import sys
import urllib.request
from collections.abc import Callable
from html.parser import HTMLParser
from pathlib import Path

import yaml

from diagrams3mrai.catalog import REPO_ROOT, Entry, load_catalog, select

ICON_PREFIX = "https://cdn.jsdelivr.net/npm/aws-icons@3.2.0/icons/"
DEVICON_PREFIX = "https://cdn.jsdelivr.net/npm/devicon@2.16.0/icons/"
VENDOR_PREFIX = "https://cdn.jsdelivr.net/gh/"
ICONS_PATH = REPO_ROOT / "diagrams" / "icons.yaml"
MAX_WIDTH = 2000
PLUGIN_CACHE = Path.home() / ".claude/plugins/cache/diagram-design/diagram-design"
_SELF_CHECK_REL = Path("skills/diagram-design/scripts/self_check.py")
# CONTRACT: self_check truncates URLs to 80 chars; this filter only drops the error, check_icons validates the full URL.
_TOLERATED = tuple("remote reference on <image>: " + p for p in (ICON_PREFIX, DEVICON_PREFIX, VENDOR_PREFIX))
# icons.yaml section → (pinned package prefix, allowed path shape).
_SECTIONS = {
    "icons": (ICON_PREFIX, re.compile(r"(architecture-service|architecture-group|resource|category)/[A-Za-z0-9]+\.svg")),
    "devicon": (DEVICON_PREFIX, re.compile(r"[a-z0-9]+/[a-z0-9]+-[a-z0-9-]+\.svg")),
    # CONTRACT: a vendor logo is pinned to a release tag or a full commit SHA in the vendor's own repo, never a branch.
    "vendor": (
        VENDOR_PREFIX,
        re.compile(
            r"[A-Za-z0-9-]+/[A-Za-z0-9._-]+@(v?[0-9]+(\.[0-9]+)+|[0-9a-f]{40})"
            r"(/[A-Za-z0-9_-][A-Za-z0-9._-]*)+\.(svg|png)"
        ),
    ),
}


class GateSetupError(RuntimeError):
    pass


def load_icons(path: Path = ICONS_PATH) -> dict[str, str]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    icons: dict[str, str] = {}
    for section, (prefix, shape) in _SECTIONS.items():
        for key, rel in (data.get(section) or {}).items():
            if not shape.fullmatch(rel):
                raise ValueError(f"icons.yaml {section}.{key}: invalid path {rel}")
            if key in icons:
                raise ValueError(f"icons.yaml {key}: key defined in more than one section")
            icons[key] = prefix + rel
    return icons


class _Images(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []
        self.view_box: str | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "image":
            href = a.get("href") or a.get("xlink:href")
            if href:
                self.hrefs.append(href)
        elif tag == "svg" and self.view_box is None:
            self.view_box = a.get("viewbox")


def _parse(html: str) -> _Images:
    p = _Images()
    p.feed(html)
    return p


def image_hrefs(html: str) -> list[str]:
    return _parse(html).hrefs


def check_icons(html: str, allowed: set[str]) -> list[str]:
    return [f"icon not in diagrams/icons.yaml: {h}" for h in image_hrefs(html) if h not in allowed]


def view_box_width(html: str) -> float | None:
    vb = _parse(html).view_box
    return float(vb.replace(",", " ").split()[2]) if vb else None


def filter_self_check(errors: list[str]) -> list[str]:
    return [e for e in errors if not e.startswith(_TOLERATED)]


def _version_key(name: str) -> tuple[int, ...]:
    return tuple(int(part) for part in name.split(".") if part.isdigit())


def locate_self_check(cache: Path = PLUGIN_CACHE) -> Path:
    override = os.environ.get("DIAGRAM_DESIGN_SELF_CHECK")
    if override:
        candidates = [Path(override)] if Path(override).is_file() else []
    else:
        installs = [d for d in cache.glob("*") if (d / _SELF_CHECK_REL).is_file()]
        candidates = [max(installs, key=lambda d: _version_key(d.name)) / _SELF_CHECK_REL] if installs else []
    if not candidates:
        raise GateSetupError(
            f"diagram-design self_check.py not found under {override or cache}. Install the plugin "
            "diagram-design@diagram-design (declared in .claude/settings.json) or set DIAGRAM_DESIGN_SELF_CHECK."
        )
    return candidates[0]


def self_check_available() -> bool:
    try:
        locate_self_check()
        return True
    except GateSetupError:
        return False


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_verify() -> Callable[[Path], list[str]]:
    self_check = locate_self_check()
    # CONTRACT: verify-geometry and verify-motion ship at the plugin root, three levels above skills/diagram-design/scripts/.
    scripts = self_check.parents[3] / "scripts"
    for name in ("verify-geometry.py", "verify-motion.py"):
        if not (scripts / name).is_file():
            raise GateSetupError(f"diagram-design {name} not found at {scripts}")
    verify = _load(self_check, "diagram_design_self_check").verify
    geometry = _load(scripts / "verify-geometry.py", "diagram_design_verify_geometry").check
    motion = _load(scripts / "verify-motion.py", "diagram_design_verify_motion").verify

    def run(path: Path) -> list[str]:
        errors = [*verify(path), *geometry(path)]
        # WHY: verify-motion requires a motion root, so a static diagram would always fail it.
        if "data-motion-root" in path.read_text(encoding="utf-8"):
            errors += [e for e in motion(path) if e not in errors]
        return errors

    return run


def check_entry(entry: Entry, allowed: set[str], verify: Callable[[Path], list[str]], root: Path = REPO_ROOT) -> list[str]:
    src = root / entry.src
    if not src.is_file():
        return [f"{entry.id}: missing source {entry.src}"]
    html = src.read_text(encoding="utf-8")
    errors = [*filter_self_check(verify(src)), *check_icons(html, allowed)]
    width = view_box_width(html)
    if width is None:
        errors.append("no <svg viewBox>")
    elif width > MAX_WIDTH:
        errors.append(f"viewBox width {width:g} exceeds {MAX_WIDTH}")
    return [f"{entry.id}: {e}" for e in errors]


def orphans(entries: list[Entry], root: Path = REPO_ROOT) -> list[str]:
    known = {e.src for e in entries}
    found = sorted(p.relative_to(root).as_posix() for p in (root / "diagrams/src").glob("*/*.html"))
    return [f"{p} has no catalog entry" for p in found if p not in known]


def missing_renders(entries: list[Entry], root: Path = REPO_ROOT) -> list[str]:
    # WHY: a source without its PNG is reported by missing source, not twice.
    return [
        f"{e.id}: missing render {e.png} (make diagrams-render ID={e.id})"
        for e in entries
        if (root / e.src).is_file() and not (root / e.png).is_file()
    ]


def unreachable(urls: list[str]) -> list[str]:
    bad = []
    for url in urls:
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method="HEAD"), timeout=10) as r:
                if r.status != 200:
                    bad.append(f"icon URL answered {r.status}: {url}")
        except Exception as exc:
            bad.append(f"icon URL unreachable ({exc}): {url}")
    return bad


def main(argv: list[str] | None = None) -> int:
    ids = list(sys.argv[1:] if argv is None else argv)
    try:
        entries = load_catalog()
        chosen = select(entries, ids)
        icons = load_icons()
        verify = load_verify()
        print(f"diagrams-gate: diagram-design {locate_self_check().parents[3].name}")
    except (GateSetupError, KeyError, ValueError) as exc:
        print(f"diagrams-gate: {exc}")
        return 1
    errors = [] if ids else [*orphans(entries), *missing_renders(entries)]
    if os.environ.get("DIAGRAMS_OFFLINE") != "1":
        errors += unreachable(sorted(set(icons.values())))
    allowed = set(icons.values())
    for e in chosen:
        errs = check_entry(e, allowed, verify)
        print(("FAIL " if errs else "OK   ") + e.id)
        errors += errs
    for line in errors:
        print(f"  - {line}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
