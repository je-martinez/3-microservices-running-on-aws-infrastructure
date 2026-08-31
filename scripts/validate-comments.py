#!/usr/bin/env python3
"""3MRAI comment-convention linter — enforces docs/shared/conventions/code-comments.md.

Checks: block length, tag vocabulary, See [[vault-id]] references, stale terms
(error), narrative markers (warning). A baseline ratchet freezes existing
violations so CI fails only on new ones.

Exit: 0 no new violations, 1 new violations, 2 config/IO error.
Run `--help` for the flags; `--all --update-baseline` regenerates the baseline.
"""
from __future__ import annotations

import argparse
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
    r"account\s+no\s+longer|"
    r"product\s+no\s+longer|"
    r"user\s+no\s+longer|"
    r"caller\s+no\s+longer|"
    r"rows?\s+are\s+no\s+longer|"
    r"cloudfront\s+eventually|"
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


def is_comment_line(line: str, lang: str, state: dict) -> bool:
    stripped = line.strip()
    if not stripped:
        return state.get("in_block", False)

    if lang == "hcl":
        return stripped.startswith("#") or stripped.startswith("//")

    if lang == "python":
        if state.get("in_block"):
            quote = state.get("quote", '"""')
            if quote in stripped:
                state["in_block"] = False
                state.pop("quote", None)
            return True
        if stripped.startswith("#"):
            return True
        for quote in ('"""', "'''"):
            if stripped.startswith(quote) or stripped.startswith(f"r{quote}"):
                body = stripped[stripped.index(quote) + 3 :]
                if quote not in body:
                    state["in_block"] = True
                    state["quote"] = quote
                return True
        return False

    if lang in ("typescript", "csharp", "go"):
        if state.get("in_block"):
            if "*/" in stripped:
                state["in_block"] = False
            return True
        if stripped.startswith("//"):
            return True
        if stripped.startswith("/*"):
            if "*/" not in stripped:
                state["in_block"] = True
            return True
        return False

    return False


def strip_comment_prefix(line: str) -> str:
    """Return the readable body of a single comment line."""
    s = line.strip()
    for prefix in ("///", "//", "/**", "/*", "*/", "*", "#", '"""', "'''"):
        if s.startswith(prefix):
            s = s[len(prefix) :].strip()
            break
    if s.endswith("*/"):
        s = s[:-2].strip()
    return s


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

    def flush(end_idx: int) -> None:
        nonlocal current_start, current_lines
        if current_start is None:
            return
        # Trailing blank lines belong to neither the block nor its length.
        raw = list(current_lines)
        while raw and raw[-1].strip() == "":
            raw.pop()
        if raw:
            text = "\n".join(raw)
            bodies = [strip_comment_prefix(line) for line in raw]
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
                )
            )
        current_start = None
        current_lines = []

    for idx, line in enumerate(lines, start=1):
        if is_comment_line(line, lang, state):
            comment_line_count += 1
            if current_start is None:
                current_start = idx
                current_lines = [line]
            else:
                current_lines.append(line)
        else:
            if line.strip() == "" and current_start is not None:
                current_lines.append(line)
            else:
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
        if RUNTIME_NARRATIVE_WHITELIST_RE.search(body):
            continue
        match = NARRATIVE_MARKER_RE.search(body)
        if not match:
            continue
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
    strict_narrative: bool = False,
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

    for block in blocks:
        report.violations.extend(check_length(block))
        report.violations.extend(check_tags(block))
        report.violations.extend(check_references(block))
        report.violations.extend(check_stale_terms(block, stale_terms))
        narrative = check_narrative(block)
        if strict_narrative:
            report.violations.extend(narrative)
        else:
            report.warnings.extend(narrative)

    thresholds = THRESHOLDS[lang]
    min_lines = thresholds["density_min_lines"]
    if total >= min_lines and density > thresholds["density_warn"]:
        report.violations.append(
            f"density: {density:.0%} ({comment_lines}/{total}) exceeds "
            f"{thresholds['density_warn']:.0%} for {lang}"
        )

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
        return {"version": 1, "violations": {}}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Cannot read baseline {path}: {exc}") from exc


def save_baseline(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def violation_key(path: str, violation: str) -> str:
    return f"{path}::{violation}"


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
        action="store_true",
        help="Promote narrative-marker warnings to errors",
    )
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
        save_baseline(args.baseline, {"version": 1, "violations": all_violations})
        total = sum(len(v) for v in all_violations.values())
        print(f"Baseline updated: {len(all_violations)} files, {total} violations")
        return 0

    baseline = load_baseline(args.baseline)
    baselined: set[str] = set()
    for path, viols in baseline.get("violations", {}).items():
        for v in viols:
            baselined.add(violation_key(path, v))

    new_violations: list[tuple[str, str]] = []
    current_keys: set[str] = set()
    for path, viols in all_violations.items():
        for v in viols:
            key = violation_key(path, v)
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
