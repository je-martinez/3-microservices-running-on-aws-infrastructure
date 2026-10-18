"""Load and validate diagrams/catalog.yaml, the list of every diagram and what it watches."""

import re
from dataclasses import dataclass
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
CATALOG_PATH = REPO_ROOT / "diagrams" / "catalog.yaml"
GROUPS = ("architecture", "system-context", "flows", "milestones")


@dataclass(frozen=True)
class Entry:
    id: str
    title: str
    src: str
    output: str
    watches: tuple[str, ...]

    @property
    def png(self) -> str:
        return f"{self.output}.png"


def _validate(e: Entry) -> None:
    groups = "|".join(re.escape(g) for g in GROUPS)
    if not re.fullmatch(rf"diagrams/src/({groups})/{re.escape(e.id)}\.html", e.src):
        raise ValueError(f"{e.id}: src must be diagrams/src/<group>/{e.id}.html, got {e.src}")
    if not e.output.startswith("docs/") or Path(e.output).suffix:
        raise ValueError(f"{e.id}: output must be a docs/ path without extension, got {e.output}")


def load_catalog(path: Path = CATALOG_PATH) -> list[Entry]:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    entries = [
        Entry(id=r["id"], title=r["title"], src=r["src"], output=r["output"], watches=tuple(r.get("watches") or ()))
        for r in raw["entries"]
    ]
    ids = [e.id for e in entries]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise ValueError(f"duplicate catalog ids: {dup}")
    for e in entries:
        _validate(e)
    return entries


def select(entries: list[Entry], ids: list[str]) -> list[Entry]:
    if not ids:
        return entries
    by_id = {e.id: e for e in entries}
    unknown = [i for i in ids if i not in by_id]
    if unknown:
        raise KeyError(f"unknown diagram id(s): {', '.join(unknown)}")
    return [by_id[i] for i in ids]
