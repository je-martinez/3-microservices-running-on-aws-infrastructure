"""Measure a cold `make clean` + `make bootstrap`, one timing per stage.

CONTRACT: The stage list below MIRRORS the `bootstrap` recipe in the Makefile.
When that recipe's order or membership changes, change it here too — a stage
measured in the wrong order still reports an authoritative-looking number.
See [[2026-09-09-makefile-orchestration-invariants]]

Usage:
    .venv/bin/python infra/scripts/measure_bootstrap.py            # clean + bootstrap
    .venv/bin/python infra/scripts/measure_bootstrap.py --no-clean # bootstrap only
    .venv/bin/python infra/scripts/measure_bootstrap.py --runs 3   # repeat, report spread
"""

from __future__ import annotations

import argparse
import json
import platform
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RESULTS_DIR = REPO_ROOT / ".bootstrap-timings"

# The chain `bootstrap` runs, in order. Each entry is (stage-name, make-target).
# `floci-wait` and the phase-2 steps are broken out because they are the ones a
# developer can plausibly act on; the rest are grouped as their make target.
# CONTRACT: `lambda-bundles` is timed on its own BEFORE `infra-up`, which
# declares it a prerequisite. Folded into the apply, its pnpm install and two
# esbuild builds are attributed to terraform. Running it first no-ops the
# prerequisite. See [[2026-09-09-makefile-orchestration-invariants]]
PROVISION_STAGES: list[tuple[str, str]] = [
    ("scripts-setup", "scripts-setup"),
    ("backend-up", "backend-up"),
    ("infra-init", "infra-init"),
    ("observability-up", "observability-up"),
    ("lambda-bundles", "lambda-bundles"),
    ("infra-up", "infra-up"),
]

CONVERGE_STAGES: list[tuple[str, str]] = [
    ("env-file", "env-file"),
    ("migrate", "migrate"),
    ("migrate-tracking", "migrate-tracking"),
    ("post-infra", "post-infra"),
]


@dataclass
class Stage:
    name: str
    seconds: float
    ok: bool
    detail: str = ""


@dataclass
class Run:
    started_at: str
    stages: list[Stage] = field(default_factory=list)

    @property
    def total(self) -> float:
        return sum(s.seconds for s in self.stages)

    @property
    def ok(self) -> bool:
        return all(s.ok for s in self.stages)


def _fmt(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:5.1f}s"
    return f"{int(seconds // 60):d}m{seconds % 60:04.1f}s"


def _run(cmd: list[str], log: Path) -> tuple[float, bool]:
    """Run a command, tee its output to a log file, return (elapsed, ok)."""
    start = time.monotonic()
    with log.open("w") as fh:
        proc = subprocess.Popen(
            cmd,
            cwd=REPO_ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            fh.write(line)
            sys.stdout.write(f"    \033[2m{line.rstrip()}\033[0m\n")
        code = proc.wait()
    return time.monotonic() - start, code == 0


def _floci_wait(log: Path) -> tuple[float, bool]:
    """Start Floci and poll :4566, the way `bootstrap` does inline.

    Timed separately from the compose start because they answer different
    questions: how long the container takes to create, versus how long the
    emulator takes to answer HTTP once it exists.
    """
    start = time.monotonic()
    with log.open("w") as fh:
        up = subprocess.run(
            ["docker", "compose", "up", "-d", "floci"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        fh.write(up.stdout + up.stderr)
        if up.returncode != 0:
            return time.monotonic() - start, False

        for _ in range(120):
            probe = subprocess.run(
                ["curl", "-sf", "-o", "/dev/null", "http://localhost:4566"],
                capture_output=True,
            )
            if probe.returncode == 0:
                fh.write("\nFloci answered :4566\n")
                return time.monotonic() - start, True
            time.sleep(0.5)
        fh.write("\nFloci never answered :4566\n")
        return time.monotonic() - start, False


def _compose_service(name: str, log: Path) -> tuple[float, bool]:
    return _run(["docker", "compose", "up", "-d", "--build", name], log)


def measure(do_clean: bool, run_dir: Path) -> Run:
    run = Run(started_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))

    def record(name: str, fn) -> bool:
        print(f"\n\033[1m▶ {name}\033[0m")
        elapsed, ok = fn(run_dir / f"{name}.log")
        run.stages.append(Stage(name, elapsed, ok))
        marker = "\033[0;32mOK\033[0m" if ok else "\033[0;31mFAIL\033[0m"
        print(f"  {marker}  {name}: {_fmt(elapsed)}")
        return ok

    if do_clean:
        if not record("clean", lambda log: _run(["make", "clean"], log)):
            return run

    if not record("floci-wait", _floci_wait):
        return run

    for name, target in PROVISION_STAGES:
        if not record(name, lambda log, t=target: _run(["make", t], log)):
            return run

    for name, target in CONVERGE_STAGES[:1]:
        if not record(name, lambda log, t=target: _run(["make", t], log)):
            return run

    # Phase 2 interleaves make targets with compose builds; keep the real order.
    if not record("migrate", lambda log: _run(["make", "migrate"], log)):
        return run
    if not record("build-users", lambda log: _compose_service("users", log)):
        return run
    if not record("build-orders", lambda log: _compose_service("orders", log)):
        return run
    if not record("migrate-tracking", lambda log: _run(["make", "migrate-tracking"], log)):
        return run
    if not record("build-tracking", lambda log: _compose_service("tracking", log)):
        return run
    if not record("build-web", lambda log: _compose_service("web", log)):
        return run
    if not record(
        "nginx-alias",
        lambda log: _run(
            [str(REPO_ROOT / ".venv/bin/python"), "infra/environments/local/bootstrap.py"],
            log,
        ),
    ):
        return run
    record("post-infra", lambda log: _run(["make", "post-infra"], log))
    return run


def _environment() -> dict:
    """Capture what the numbers depend on, so two runs can be compared honestly."""
    info = {
        "platform": platform.platform(),
        "cpu_count": __import__("os").cpu_count(),
    }
    docker = shutil.which("docker")
    if docker:
        out = subprocess.run(
            [docker, "info", "--format", "{{.NCPU}} {{.MemTotal}} {{.ServerVersion}}"],
            capture_output=True,
            text=True,
        )
        if out.returncode == 0:
            parts = out.stdout.split()
            if len(parts) == 3:
                info["docker_cpus"] = parts[0]
                info["docker_mem_gb"] = round(int(parts[1]) / 1024**3, 1)
                info["docker_version"] = parts[2]
    return info


def report(runs: list[Run]) -> str:
    lines: list[str] = []
    names: list[str] = []
    for r in runs:
        for s in r.stages:
            if s.name not in names:
                names.append(s.name)

    width = max(len(n) for n in names) if names else 10
    lines.append("")
    lines.append("\033[1m  Cold bootstrap — where the time goes\033[0m")
    lines.append("")

    totals = [r.total for r in runs if r.ok] or [r.total for r in runs]
    grand = sum(totals) / len(totals) if totals else 0.0

    for name in names:
        vals = [s.seconds for r in runs for s in r.stages if s.name == name]
        if not vals:
            continue
        avg = sum(vals) / len(vals)
        pct = (avg / grand * 100) if grand else 0
        bar = "█" * max(1, round(pct / 2))
        spread = ""
        if len(vals) > 1:
            spread = f"  (min {_fmt(min(vals))} / max {_fmt(max(vals))})"
        failed = any(not s.ok for r in runs for s in r.stages if s.name == name)
        mark = " \033[0;31m✗\033[0m" if failed else ""
        lines.append(f"  {name:<{width}}  {_fmt(avg)}  {pct:4.1f}%  {bar}{spread}{mark}")

    lines.append("")
    lines.append(f"  {'TOTAL':<{width}}  {_fmt(grand)}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--no-clean", action="store_true", help="skip `make clean` (warm run)")
    ap.add_argument("--runs", type=int, default=1, help="repeat N times and report the spread")
    args = ap.parse_args()

    RESULTS_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")

    runs: list[Run] = []
    for i in range(args.runs):
        run_dir = RESULTS_DIR / f"{stamp}-run{i + 1}"
        run_dir.mkdir(parents=True, exist_ok=True)
        print(f"\n\033[1m=== run {i + 1}/{args.runs} → {run_dir} ===\033[0m")
        runs.append(measure(not args.no_clean, run_dir))

    out = report(runs)
    print(out)

    payload = {
        "recorded_at": stamp,
        "clean": not args.no_clean,
        "environment": _environment(),
        "runs": [
            {
                "started_at": r.started_at,
                "ok": r.ok,
                "total_seconds": round(r.total, 2),
                "stages": [
                    {"name": s.name, "seconds": round(s.seconds, 2), "ok": s.ok}
                    for s in r.stages
                ],
            }
            for r in runs
        ],
    }
    result_file = RESULTS_DIR / f"{stamp}.json"
    result_file.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"  Raw timings: {result_file.relative_to(REPO_ROOT)}")
    print(f"  Stage logs:  {RESULTS_DIR.relative_to(REPO_ROOT)}/{stamp}-run*/\n")

    return 0 if all(r.ok for r in runs) else 1


if __name__ == "__main__":
    raise SystemExit(main())
