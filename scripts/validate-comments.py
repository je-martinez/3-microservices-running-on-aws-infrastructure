#!/usr/bin/env python3
"""3MRAI comment-convention linter — enforces docs/shared/conventions/code-comments.md.

Checks: block length, tag vocabulary, See [[vault-id]] references, stale terms,
and narrative markers. A baseline ratchet freezes existing
violations so CI fails only on new ones.

Exit: 0 no new violations, 1 new violations, 2 config/IO error.
Run `--help` for the flags; `--all --update-baseline` regenerates the baseline.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BASELINE = REPO_ROOT / "scripts" / "comment-baseline.json"
DEFAULT_STALE_TERMS = REPO_ROOT / "scripts" / "comment-stale-terms.json"

EXCLUDE_DIR_NAMES = frozenset(
    {
        ".git",
        "node_modules",
        "dist",
        "bin",
        "obj",
        ".venv",
        "__pycache__",
        ".terraform",
        "coverage",
        "playwright-report",
        "test-results",
        "generated",
    }
)

# spike/ is throwaway; .claude/skills/ is vendored skill content, not our source.
# The Python Tracking service was replaced by services/tracking-go/ (#74), so the
# migration exclusion it used to carry is gone and Go is linted like every language.
EXCLUDE_PATH_PREFIXES = ("spike/", ".claude/skills/")

LANG_BY_SUFFIX = {
    ".tf": "hcl",
    ".tfvars": "hcl",
    ".cs": "csharp",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "typescript",
    ".mjs": "typescript",
    ".jsx": "typescript",
    ".py": "python",
    ".go": "go",
}

# One p90 gate for every language: >12 lines is a hard error (see the Length
# section of the convention). Density is an advisory ceiling per language.
MAX_BLOCK_LINES = 12

THRESHOLDS = {
    "hcl": {"density_warn": 0.45, "density_min_lines": 80},
    "csharp": {"density_warn": 0.55, "density_min_lines": 60},
    "typescript": {"density_warn": 0.50, "density_min_lines": 60},
    "python": {"density_warn": 0.45, "density_min_lines": 80},
    "go": {"density_warn": 0.50, "density_min_lines": 60},
}

# Blocks in 7..12 lines are allowed only when load-bearing AND referenced.
SOFT_LIMIT_LINES = 6

# ─── Tag vocabulary — the closed set of five ────────────────────────────────
TAG_RE = re.compile(r"\b(CONTRACT|WORKAROUND|WHY|WARNING|TODO)\b\s*(\([^)]*\))?\s*:")
CONTRACT_TAG_RE = re.compile(r"\bCONTRACT:")
WORKAROUND_TAG_RE = re.compile(r"\bWORKAROUND\(([^)]*)\):")
LOAD_BEARING_TAG_RE = re.compile(r"\b(?:CONTRACT:|WORKAROUND\([a-z-]+\):)")
TODO_TAG_RE = re.compile(r"\bTODO\(([^)]*)\):")
REJECTED_TAG_RE = re.compile(r"\b(FIXME|HACK|XXX|NOTE)\s*:")

# ─── References — `See [[vault-id]]` ────────────────────────────────────────
REFERENCE_RE = re.compile(r"See\s+\[\[([^\]]*)\]\]")
# A malformed pointer that names a docs path without the wikilink form.
LEGACY_REFERENCE_RE = re.compile(r"See\s+(?:@vault\s+)?docs/[^\s)\]]+")

# ─── Narrative markers (warning by default) ─────────────────────────────────
NARRATIVE_MARKER_RE = re.compile(
    r"\b("
    r"used\s+to|previously|no\s+longer|tried|did\s+not\s+work|turned\s+out|"
    r"originally|initially|instead\s+we|eventually|the\s+fix\s+was|now\s+we"
    r")\b",
    re.IGNORECASE,
)

# Runtime/domain prose that contains a loose marker but is not a debugging
# diary. Measured precision of the raw lexicon is ~90% at line level; this
# whitelist removes the recurring legitimate shapes in this repo.
RUNTIME_NARRATIVE_WHITELIST_RE = re.compile(
    r"(?:"
    r"no\s+longer\s+exists?|"
    r"no\s+longer\s+(?:finds?|matches?|moves?|occurs?|reaches?|resolves?|"
    r"sees?|verif(?:y|ies)|works?)|"
    r"(?:can|must)\s+no\s+longer|"
    r"(?:batch\s+span|inlined\s+dependency)\s+is\s+no\s+longer|"
    r"there\s+is\s+no\s+longer\s+a\s+single\s+parent|"
    r"no\s+longer\s+(?:met|ours)|"
    r"account\s+no\s+longer|"
    r"product\s+no\s+longer|"
    r"user\s+no\s+longer|"
    r"caller\s+no\s+longer|"
    r"rows?\s+are\s+no\s+longer|"
    r"cloudfront\s+eventually|"
    r"(?:would\s+eventually\s+trip|eventually\s+lands|"
    r"hardcoded\s+address\s+eventually|somebody\s+eventually\s+mounts)|"
    r"used\s+to\s+(?:build|distinguish|resolve|skip|tell)|"
    r"(?:be\s+tried|tried\s+block)|"
    r"\b(?:is|be|are)\s+retried\b"
    r")",
    re.IGNORECASE,
)

# Exempt shapes: one-line section dividers and tool directives.
SECTION_DIVIDER_RE = re.compile(r"^[#/*\s]*[─\-=_*]{3,}")
TOOL_DIRECTIVE_RE = re.compile(
    r"(?:eslint-|prettier-|ts-(?:ignore|expect-error|nocheck)|tfsec:|checkov:|"
    r"trivy:|noqa|type:\s*ignore|pylint:|mypy:|pragma:|nosec|@ts-|"
    r"biome-ignore|c8\s+ignore|istanbul\s+ignore|codeql\[)"
)


@dataclass
class StaleTerm:
    term_id: str
    pattern: re.Pattern[str]
    since: str
    replacement: str
    vault: str
    note: str


@dataclass
class CommentBlock:
    start_line: int
    end_line: int
    length: int
    text: str
    bodies: list[str]
    has_reference: bool
    has_contract_tag: bool
    has_load_bearing_tag: bool
    is_exempt: bool
    fingerprint: str


@dataclass
class FileReport:
    path: str
    lang: str
    total_lines: int
    comment_lines: int
    density: float
    blocks: list[CommentBlock] = field(default_factory=list)
    violations: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    violation_fingerprints: dict[str, str] = field(default_factory=dict)
    warning_fingerprints: dict[str, str] = field(default_factory=dict)


# ─── Discovery ──────────────────────────────────────────────────────────────


def should_skip(path: Path, root: Path | None = None) -> bool:
    if root is not None:
        try:
            rel = path.resolve().relative_to(root.resolve()).as_posix()
        except ValueError:
            rel = path.as_posix()
    else:
        rel = path.as_posix()
    if rel.startswith(EXCLUDE_PATH_PREFIXES):
        return True
    return any(part in EXCLUDE_DIR_NAMES for part in path.parts)


def classify(path: Path) -> str | None:
    return LANG_BY_SUFFIX.get(path.suffix.lower())


# ─── Comment scanning ───────────────────────────────────────────────────────


PYTHON_DOCSTRING_RE = re.compile(
    r"^(?P<prefix>r|u|b|f|br|rb|fr|rf)?(?P<quote>\"\"\"|''')",
    re.IGNORECASE,
)


def _scan_c_like_comment(line: str, lang: str, state: dict) -> str | None:
    """Extract C-style comments while ignoring delimiters inside strings."""
    bodies: list[str] = []
    cursor = 0
    saw_comment = False

    if state.get("in_block"):
        saw_comment = True
        close = line.find("*/")
        if close == -1:
            return line.strip().lstrip("*").strip()
        bodies.append(line[:close].strip().lstrip("*").strip())
        state["in_block"] = False
        cursor = close + 2

    quote = state.get("string_quote")
    escaped = False
    while cursor < len(line):
        if quote:
            char = line[cursor]
            if escaped:
                escaped = False
            elif char == "\\" and quote != "`":
                escaped = True
            elif char == quote:
                quote = None
            cursor += 1
            continue

        if line.startswith("//", cursor):
            saw_comment = True
            bodies.append(line[cursor + 2 :].strip())
            break
        if lang == "hcl" and line[cursor] == "#":
            saw_comment = True
            bodies.append(line[cursor + 1 :].strip())
            break
        if line.startswith("/*", cursor):
            saw_comment = True
            close = line.find("*/", cursor + 2)
            if close == -1:
                bodies.append(line[cursor + 2 :].strip())
                state["in_block"] = True
                break
            bodies.append(line[cursor + 2 : close].strip())
            cursor = close + 2
            continue

        char = line[cursor]
        if char in ('"', "'") or (char == "`" and lang in ("typescript", "go")):
            quote = char
        cursor += 1

    if quote == "`":
        state["string_quote"] = quote
    else:
        state.pop("string_quote", None)
    return " ".join(body for body in bodies if body) if saw_comment else None


def _scan_python_comment(line: str, state: dict) -> str | None:
    """Extract Python comments and leading docstrings without parsing code."""
    if state.get("python_docstring"):
        quote = state["python_docstring"]
        close = line.find(quote)
        if close == -1:
            return line.strip()
        state.pop("python_docstring", None)
        return line[:close].strip()

    if state.get("python_string"):
        quote = state["python_string"]
        close = line.find(quote)
        if close == -1:
            return None
        state.pop("python_string", None)
        line = line[close + 3 :]

    stripped = line.lstrip()
    docstring = PYTHON_DOCSTRING_RE.match(stripped)
    if docstring:
        quote = docstring.group("quote")
        body = stripped[docstring.end() :]
        close = body.find(quote)
        if close == -1:
            state["python_docstring"] = quote
            return body.strip()
        return body[:close].strip()

    cursor = 0
    quote: str | None = None
    escaped = False
    while cursor < len(line):
        if quote:
            char = line[cursor]
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            cursor += 1
            continue

        if line.startswith(('"""', "'''"), cursor):
            triple = line[cursor : cursor + 3]
            close = line.find(triple, cursor + 3)
            if close == -1:
                state["python_string"] = triple
                return None
            cursor = close + 3
            continue
        if line[cursor] == "#":
            return line[cursor + 1 :].strip()
        if line[cursor] in ('"', "'"):
            quote = line[cursor]
        cursor += 1
    return None


def is_comment_line(line: str, lang: str, state: dict) -> bool:
    """Record the extracted comment body in state and report whether it exists."""
    if lang == "python":
        body = _scan_python_comment(line, state)
    elif lang in ("hcl", "typescript", "csharp", "go"):
        body = _scan_c_like_comment(line, lang, state)
    else:
        body = None
    state["comment_body"] = body
    return body is not None or state.get("in_block", False)


def comment_fingerprint(bodies: list[str]) -> str:
    """Return a stable short hash of normalized comment text."""
    normalized = "\n".join(" ".join(body.split()) for body in bodies).strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]


def block_is_exempt(bodies: list[str], raw_lines: list[str]) -> bool:
    """Section dividers and tool directives are exempt from tagging/length."""
    meaningful = [b for b in bodies if b]
    if not meaningful:
        return True
    if len(raw_lines) == 1 and SECTION_DIVIDER_RE.match(raw_lines[0].strip()):
        return True
    if all(TOOL_DIRECTIVE_RE.search(b) for b in meaningful):
        return True
    return False


def extract_blocks(lines: list[str], lang: str) -> tuple[list[CommentBlock], int]:
    state: dict = {}
    comment_line_count = 0
    blocks: list[CommentBlock] = []
    current_start: int | None = None
    current_lines: list[str] = []
    current_bodies: list[str] = []

    def flush(end_idx: int) -> None:
        nonlocal current_start, current_lines, current_bodies
        if current_start is None:
            return
        # Trailing blank lines belong to neither the block nor its length.
        raw = list(current_lines)
        while raw and raw[-1].strip() == "":
            raw.pop()
        if raw:
            bodies = current_bodies[: len(raw)]
            text = "\n".join(bodies)
            blocks.append(
                CommentBlock(
                    start_line=current_start,
                    end_line=current_start + len(raw) - 1,
                    length=len(raw),
                    text=text,
                    bodies=bodies,
                    has_reference=bool(REFERENCE_RE.search(text)),
                    has_contract_tag=bool(CONTRACT_TAG_RE.search(text)),
                    has_load_bearing_tag=bool(LOAD_BEARING_TAG_RE.search(text)),
                    is_exempt=block_is_exempt(bodies, raw),
                    fingerprint=comment_fingerprint(bodies),
                )
            )
        current_start = None
        current_lines = []
        current_bodies = []

    for idx, line in enumerate(lines, start=1):
        if is_comment_line(line, lang, state):
            comment_line_count += 1
            body = state.pop("comment_body", None) or ""
            if current_start is None:
                current_start = idx
                current_lines = [line]
                current_bodies = [body]
            else:
                current_lines.append(line)
                current_bodies.append(body)
        else:
            # A blank line ends the block. Two comments separated by one — the
            # normal shape of consecutive godoc/docstring headers — are two
            # blocks, not one long one, and are counted separately.
            flush(idx - 1)

    flush(len(lines))
    return blocks, comment_line_count


# ─── Stale-term config ──────────────────────────────────────────────────────


def load_stale_terms(path: Path) -> list[StaleTerm]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Cannot read stale-terms config {path}: {exc}") from exc
    terms: list[StaleTerm] = []
    for entry in raw.get("terms", []):
        try:
            pattern = re.compile(entry["pattern"])
        except (KeyError, re.error) as exc:
            raise SystemExit(
                f"Invalid stale-term entry {entry.get('id', '?')} in {path}: {exc}"
            ) from exc
        terms.append(
            StaleTerm(
                term_id=entry["id"],
                pattern=pattern,
                since=entry.get("since", ""),
                replacement=entry.get("replacement", ""),
                vault=entry.get("vault", ""),
                note=entry.get("note", ""),
            )
        )
    return terms


# ─── Checks ─────────────────────────────────────────────────────────────────


def check_length(block: CommentBlock) -> list[str]:
    if block.is_exempt:
        return []
    if block.length > MAX_BLOCK_LINES:
        return [
            f"L{block.start_line}: length: block {block.length} lines exceeds hard "
            f"max {MAX_BLOCK_LINES}; move narrative to the vault"
        ]
    if block.length > SOFT_LIMIT_LINES:
        if not block.has_load_bearing_tag:
            return [
                f"L{block.start_line}: length: block {block.length} lines "
                f"(> {SOFT_LIMIT_LINES}) must be tagged CONTRACT: or "
                f"WORKAROUND(<scope>):"
            ]
        if not block.has_reference:
            return [
                f"L{block.start_line}: length: block {block.length} lines "
                f"(> {SOFT_LIMIT_LINES}) must carry a See [[vault-id]] reference"
            ]
    return []


def check_tags(block: CommentBlock) -> list[str]:
    if block.is_exempt:
        return []
    violations: list[str] = []

    rejected = REJECTED_TAG_RE.search(block.text)
    if rejected:
        violations.append(
            f"L{block.start_line}: tag: '{rejected.group(1)}:' is not in the closed "
            f"set (CONTRACT, WORKAROUND(<scope>), WHY, WARNING, TODO(JE-<id>))"
        )

    for match in WORKAROUND_TAG_RE.finditer(block.text):
        scope = match.group(1)
        if not re.fullmatch(r"[a-z][a-z-]*", scope):
            violations.append(
                f"L{block.start_line}: tag: WORKAROUND scope '{scope}' must be "
                f"lowercase (local, provider, runtime)"
            )

    for match in TODO_TAG_RE.finditer(block.text):
        owner = match.group(1)
        if not re.fullmatch(r"JE-\d+", owner):
            violations.append(
                f"L{block.start_line}: tag: TODO({owner}) must reference a Linear "
                f"issue as TODO(JE-<id>)"
            )
    if re.search(r"\bTODO\s*:", block.text):
        violations.append(
            f"L{block.start_line}: tag: bare 'TODO:' must carry a Linear issue as "
            f"TODO(JE-<id>)"
        )

    return violations


def check_references(block: CommentBlock) -> list[str]:
    violations: list[str] = []

    for match in REFERENCE_RE.finditer(block.text):
        target = match.group(1).strip()
        if not target:
            violations.append(
                f"L{block.start_line}: reference: empty See [[]] target"
            )
            continue
        if "#" in target:
            violations.append(
                f"L{block.start_line}: reference: See [[{target}]] must not carry a "
                f"#anchor — anchors are never validated and rot silently"
            )
        stem = target.split("#", 1)[0].strip()
        if stem.endswith(".md"):
            violations.append(
                f"L{block.start_line}: reference: See [[{target}]] must not end in "
                f".md — use the bare note basename"
            )
        if target.startswith("docs/"):
            violations.append(
                f"L{block.start_line}: reference: See [[{target}]] must not carry a "
                f"leading docs/ — use the bare note basename"
            )

    if not block.is_exempt:
        legacy = LEGACY_REFERENCE_RE.search(block.text)
        if legacy:
            violations.append(
                f"L{block.start_line}: reference: '{legacy.group(0)}' must be an "
                f"Obsidian wikilink: See [[vault-id]]"
            )

    return violations


def check_stale_terms(
    block: CommentBlock, stale_terms: list[StaleTerm]
) -> list[str]:
    violations: list[str] = []
    for offset, body in enumerate(block.bodies):
        if not body:
            continue
        for term in stale_terms:
            if term.pattern.search(body):
                line_no = block.start_line + offset
                suffix = f" — See [[{term.vault}]]" if term.vault else ""
                replacement = term.replacement or "the current component"
                violations.append(
                    f"L{line_no}: stale-term: '{term.term_id}' was decommissioned "
                    f"{term.since or '(date unrecorded)'}; use {replacement}{suffix}"
                )
    return violations


def check_narrative(block: CommentBlock) -> list[str]:
    if block.is_exempt:
        return []
    warnings: list[str] = []
    for offset, body in enumerate(block.bodies):
        if not body:
            continue
        context = " ".join(block.bodies[offset : offset + 2])
        whitelist_spans = [
            match.span() for match in RUNTIME_NARRATIVE_WHITELIST_RE.finditer(context)
        ]
        matches = [
            match
            for match in NARRATIVE_MARKER_RE.finditer(body)
            if not any(
                start <= match.start() and match.end() <= end
                for start, end in whitelist_spans
            )
        ]
        if not matches:
            continue
        match = matches[0]
        line_no = block.start_line + offset
        warnings.append(
            f"L{line_no}: narrative-marker: '{match.group(0)}' narrates history; "
            f"describe the current state and move the story to the vault"
        )
    return warnings


# ─── File analysis ──────────────────────────────────────────────────────────


def analyze_file(
    path: Path,
    root: Path,
    *,
    stale_terms: list[StaleTerm],
    strict_narrative: bool = True,
) -> FileReport | None:
    lang = classify(path)
    if lang is None:
        return None
    try:
        content = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise SystemExit(f"Cannot read {path}: {exc}") from exc

    lines = content.splitlines()
    blocks, comment_lines = extract_blocks(lines, lang)
    total = len(lines)
    density = comment_lines / total if total else 0.0
    try:
        rel = path.resolve().relative_to(root).as_posix()
    except ValueError:
        rel = path.as_posix()

    report = FileReport(
        path=rel,
        lang=lang,
        total_lines=total,
        comment_lines=comment_lines,
        density=density,
        blocks=blocks,
    )

    def record(messages: list[str], fingerprint: str, *, warning: bool = False) -> None:
        target = report.warnings if warning else report.violations
        fingerprints = (
            report.warning_fingerprints if warning else report.violation_fingerprints
        )
        target.extend(messages)
        for message in messages:
            fingerprints[message] = fingerprint

    for block in blocks:
        record(check_length(block), block.fingerprint)
        record(check_tags(block), block.fingerprint)
        record(check_references(block), block.fingerprint)
        record(check_stale_terms(block, stale_terms), block.fingerprint)
        narrative = check_narrative(block)
        if strict_narrative:
            record(narrative, block.fingerprint)
        else:
            record(narrative, block.fingerprint, warning=True)

    thresholds = THRESHOLDS[lang]
    min_lines = thresholds["density_min_lines"]
    if total >= min_lines and density > thresholds["density_warn"]:
        message = (
            f"density: {density:.0%} ({comment_lines}/{total}) exceeds "
            f"{thresholds['density_warn']:.0%} for {lang}"
        )
        bodies = [body for block in blocks for body in block.bodies]
        record([message], comment_fingerprint(bodies))

    return report


def iter_source_files(root: Path) -> Iterator[Path]:
    for path in sorted(root.rglob("*")):
        if not path.is_file() or should_skip(path, root):
            continue
        if classify(path):
            yield path


def git_changed_files(root: Path, diff_ref: str) -> list[Path]:
    cmd = ["git", "diff", "--name-only", "--diff-filter=ACMR", diff_ref, "--"]
    result = subprocess.run(cmd, cwd=root, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise SystemExit(f"git diff failed: {result.stderr.strip()}")
    files: list[Path] = []
    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        p = root / line.strip()
        if p.is_file() and classify(p) and not should_skip(p, root):
            files.append(p)
    return files


# ─── Baseline ───────────────────────────────────────────────────────────────


def load_baseline(path: Path) -> dict:
    if not path.exists():
        return {"version": 2, "violations": {}}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Cannot read baseline {path}: {exc}") from exc


def save_baseline(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def violation_key(path: str, violation: str, fingerprint: str) -> str:
    stable_message = re.sub(r"^L\d+: ", "", violation)
    return f"{path}::{stable_message}::{fingerprint}"


def check_name(message: str) -> str:
    """Rule name from a violation message, for the per-check breakdown."""
    body = message.split(": ", 1)[-1] if message.startswith("L") else message
    name = body.split(":", 1)[0].strip()
    known = {
        "length",
        "tag",
        "reference",
        "stale-term",
        "narrative-marker",
        "density",
    }
    return name if name in known else "other"


# ─── Entry point ────────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description="3MRAI comment convention linter")
    parser.add_argument("--root", type=Path, default=REPO_ROOT)
    parser.add_argument("--all", action="store_true", help="Scan entire repo")
    parser.add_argument("--diff", metavar="REF", help="Scan files changed vs git ref")
    parser.add_argument(
        "--baseline",
        type=Path,
        default=DEFAULT_BASELINE,
        help="Baseline JSON for ratchet mode",
    )
    parser.add_argument(
        "--update-baseline",
        action="store_true",
        help="Rewrite baseline with current violations (run on cleanup PRs)",
    )
    parser.add_argument(
        "--stale-terms",
        type=Path,
        default=DEFAULT_STALE_TERMS,
        help="JSON denylist of decommissioned names in comments",
    )
    parser.add_argument(
        "--strict-narrative",
        dest="strict_narrative",
        action="store_true",
        help="Reject narrative markers (the default)",
    )
    parser.add_argument(
        "--allow-narrative",
        dest="strict_narrative",
        action="store_false",
        help="Escape hatch: demote narrative-marker errors to warnings",
    )
    parser.set_defaults(strict_narrative=True)
    parser.add_argument(
        "--json", action="store_true", help="Emit machine-readable report"
    )
    parser.add_argument(
        "paths",
        nargs="*",
        type=Path,
        help="Explicit files to scan (overrides --all/--diff)",
    )
    args = parser.parse_args()
    root = args.root.resolve()
    stale_terms = load_stale_terms(args.stale_terms)

    if args.paths:
        paths = [p.resolve() for p in args.paths if p.is_file() and classify(p)]
    elif args.all:
        paths = list(iter_source_files(root))
    elif args.diff:
        paths = git_changed_files(root, args.diff)
    else:
        # Default: diff against origin/main if available, else the last commit.
        try:
            subprocess.run(
                ["git", "rev-parse", "--verify", "origin/main"],
                cwd=root,
                capture_output=True,
                check=True,
            )
            paths = git_changed_files(root, "origin/main...HEAD")
        except subprocess.CalledProcessError:
            paths = git_changed_files(root, "HEAD")

    reports: list[FileReport] = []
    for path in sorted(paths):
        report = analyze_file(
            path,
            root,
            stale_terms=stale_terms,
            strict_narrative=args.strict_narrative,
        )
        if report and (report.violations or report.warnings):
            reports.append(report)

    all_violations: dict[str, list[str]] = {
        r.path: r.violations for r in reports if r.violations
    }
    all_warnings: dict[str, list[str]] = {
        r.path: r.warnings for r in reports if r.warnings
    }

    if args.update_baseline:
        # CONTRACT: The baseline is rewritten wholesale, so it may only be
        # regenerated from a whole-repo scan. Doing it from --diff or explicit
        # paths would discard every violation outside that scan and silently
        # un-ratchet the rest of the repo.
        if not args.all or args.paths:
            print(
                "--update-baseline requires --all: a partial scan would drop "
                "every baseline entry outside it.",
                file=sys.stderr,
            )
            return 2
        baseline_violations = {
            report.path: [
                {
                    "message": message,
                    "fingerprint": report.violation_fingerprints[message],
                }
                for message in report.violations
            ]
            for report in reports
            if report.violations
        }
        save_baseline(
            args.baseline,
            {"version": 2, "violations": baseline_violations},
        )
        total = sum(len(v) for v in all_violations.values())
        print(f"Baseline updated: {len(all_violations)} files, {total} violations")
        return 0

    baseline = load_baseline(args.baseline)
    baselined: set[str] = set()
    for path, entries in baseline.get("violations", {}).items():
        for entry in entries:
            if isinstance(entry, str):
                message = entry
                fingerprint = ""
            else:
                message = entry.get("message", "")
                fingerprint = entry.get("fingerprint", "")
            baselined.add(violation_key(path, message, fingerprint))

    new_violations: list[tuple[str, str]] = []
    current_keys: set[str] = set()
    reports_by_path = {report.path: report for report in reports}
    for path, viols in all_violations.items():
        report = reports_by_path[path]
        for v in viols:
            key = violation_key(path, v, report.violation_fingerprints[v])
            current_keys.add(key)
            if key not in baselined:
                new_violations.append((path, v))

    # Only a whole-repo scan can tell a fixed violation from an unscanned one:
    # in --diff/explicit-path mode every baseline entry outside the scan looks
    # "missing". Reporting it there would advise --update-baseline on a partial
    # scan, which silently drops the rest of the baseline.
    scanned_whole_repo = args.all and not args.paths
    fixed_count = len(baselined - current_keys) if scanned_whole_repo else 0

    breakdown: dict[str, int] = {}
    for viols in all_violations.values():
        for v in viols:
            breakdown[check_name(v)] = breakdown.get(check_name(v), 0) + 1
    warning_count = sum(len(v) for v in all_warnings.values())
    if warning_count:
        breakdown["narrative-marker (warning)"] = warning_count

    if args.json:
        payload = {
            "scanned_files": len(paths),
            "files_with_violations": len(all_violations),
            "total_violations": sum(len(v) for v in all_violations.values()),
            "breakdown": breakdown,
            "new_violations": [{"path": p, "message": m} for p, m in new_violations],
            "warnings": [
                {"path": p, "message": m}
                for p, msgs in sorted(all_warnings.items())
                for m in msgs
            ],
            "fixed_baseline_entries": fixed_count,
            "reports": [
                {
                    "path": r.path,
                    "lang": r.lang,
                    "density": round(r.density, 3),
                    "violations": r.violations,
                    "warnings": r.warnings,
                    "max_block": max((b.length for b in r.blocks), default=0),
                }
                for r in reports
            ],
        }
        print(json.dumps(payload, indent=2))
    else:
        print(f"Scanned {len(paths)} file(s)")
        for path, msg in sorted(new_violations):
            print(f"{path}: {msg}")
        for path in sorted(all_warnings):
            for msg in all_warnings[path]:
                print(f"{path}: warning: {msg}")
        total = sum(len(v) for v in all_violations.values())
        if total:
            print(f"\nTotal violations (including baselined): {total} in "
                  f"{len(all_violations)} files")
            for name in sorted(breakdown):
                print(f"  {name}: {breakdown[name]}")
        if new_violations:
            print(f"\n{len(new_violations)} new violation(s)")
        else:
            print("\nOK — no new violations")
        if warning_count:
            print(f"{warning_count} narrative-marker warning(s) (non-blocking)")
        if fixed_count:
            print(f"{fixed_count} baseline violation(s) fixed — run --update-baseline")

    return 1 if new_violations else 0


if __name__ == "__main__":
    sys.exit(main())
