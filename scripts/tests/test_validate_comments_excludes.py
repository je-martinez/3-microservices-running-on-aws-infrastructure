"""Tests for the explicit-path exclusion in validate-comments.py.

CONTRACT: Vendored skill content is skipped even when passed as an explicit
path. The pre-commit hook always passes explicit temp paths, so an exclusion
honoured only by `--all`/`--diff` still blocks commits on third-party code.
"""
import importlib.util
import subprocess
import sys
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / "validate-comments.py"

_spec = importlib.util.spec_from_file_location("validate_comments", SCRIPT)
validate_comments = importlib.util.module_from_spec(_spec)
sys.modules["validate_comments"] = validate_comments
_spec.loader.exec_module(validate_comments)

# An untagged block over the 12-line budget: always a violation.
LONG_COMMENT = "".join(f"// line {i} of a long untagged block\n" for i in range(15))
SOURCE = LONG_COMMENT + "export const x = 1;\n"


def _lint(root: Path, rel: str) -> subprocess.CompletedProcess:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(SOURCE)
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--root", str(root), str(target)],
        capture_output=True,
        text=True,
    )


def test_explicit_claude_skills_path_is_skipped(tmp_path):
    result = _lint(tmp_path, ".claude/skills/x/a.mjs")
    assert result.returncode == 0, result.stdout + result.stderr


def test_explicit_ai_skills_mirror_is_skipped(tmp_path):
    result = _lint(tmp_path, ".ai/skills/x/a.mjs")
    assert result.returncode == 0, result.stdout + result.stderr


def test_every_skill_mirror_prefix_is_excluded(tmp_path):
    for prefix in (".cursor", ".gemini", ".windsurf", ".github", ".agents"):
        path = tmp_path / prefix / "skills" / "x" / "a.mjs"
        assert validate_comments.should_skip(path, tmp_path), prefix


def test_explicit_normal_path_is_still_reported(tmp_path):
    result = _lint(tmp_path, "diagrams/x.ts")
    assert result.returncode != 0
    assert "x.ts" in result.stdout + result.stderr
