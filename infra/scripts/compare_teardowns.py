"""Compare teardown strategies across the real edit-teardown-rebuild cycle.

CONTRACT: Arm C exists because B overstates the win — with no source change
every build is a pure cache hit, which is not the cycle a developer runs. C
invalidates the source COPY layer only, and reverts in a finally block.
Arms run INTERLEAVED, never grouped: machine state drifts over an hour, and
grouping confounds that drift with the effect under test.
See [[2026-09-09-makefile-orchestration-invariants]]
"""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
RESULTS_DIR = REPO_ROOT / ".bootstrap-timings"

# One entrypoint per service, each sitting behind its Dockerfile's source COPY
# so touching it invalidates the build but not the dependency install.
TOUCH_TARGETS: list[tuple[Path, str]] = [
    (REPO_ROOT / "services/users/src/main.ts", "//"),
    (REPO_ROOT / "services/orders/src/Orders.Api/Program.cs", "//"),
    (REPO_ROOT / "services/tracking-go/cmd/server/main.go", "//"),
    (REPO_ROOT / "apps/web/src/main.ts", "//"),
]

ARMS = {
    "A-clean": ("clean", False),
    "B-clean-state": ("clean-state", False),
    "C-clean-state-edit": ("clean-state", True),
}


@dataclass
class Iteration:
    arm: str
    index: int
    teardown_s: float
    bootstrap_s: float
    ok: bool

    @property
    def total(self) -> float:
        return self.teardown_s + self.bootstrap_s


@dataclass
class Results:
    started_at: str
    iterations: list[Iteration] = field(default_factory=list)


def _fmt(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:5.1f}s"
    return f"{int(seconds // 60)}m{seconds % 60:04.1f}s"


def _run(cmd: list[str], log: Path, env_extra: dict | None = None) -> tuple[float, bool]:
    import os

    env = {**os.environ, **(env_extra or {})}
    start = time.monotonic()
    with log.open("w") as fh:
        proc = subprocess.run(
            cmd, cwd=REPO_ROOT, stdout=fh, stderr=subprocess.STDOUT, text=True, env=env
        )
    return time.monotonic() - start, proc.returncode == 0


def touch_sources(marker: str) -> dict[Path, str]:
    """Append a marker comment to each entrypoint; return the originals."""
    originals: dict[Path, str] = {}
    for path, comment in TOUCH_TARGETS:
        if not path.exists():
            print(f"    WARNING: {path} missing, skipping touch", file=sys.stderr)
            continue
        originals[path] = path.read_text()
        path.write_text(originals[path] + f"\n{comment} build-cache-probe {marker}\n")
    return originals


def restore_sources(originals: dict[Path, str]) -> None:
    for path, content in originals.items():
        path.write_text(content)


def run_iteration(arm: str, index: int, run_dir: Path) -> Iteration:
    target, do_touch = ARMS[arm]
    tag = f"{arm}-{index}"
    print(f"\n\033[1m▶ {tag}\033[0m  ({target}{', with source edits' if do_touch else ''})")

    originals: dict[Path, str] = {}
    try:
        if do_touch:
            originals = touch_sources(datetime.now().strftime("%H%M%S"))
            print(f"    touched {len(originals)} source files")

        td, td_ok = _run(["make", target], run_dir / f"{tag}-teardown.log")
        print(f"    teardown  {_fmt(td)}  {'ok' if td_ok else 'FAILED'}")
        if not td_ok:
            return Iteration(arm, index, td, 0.0, False)

        bs, bs_ok = _run(["make", "bootstrap"], run_dir / f"{tag}-bootstrap.log")
        print(f"    bootstrap {_fmt(bs)}  {'ok' if bs_ok else 'FAILED'}")
        return Iteration(arm, index, td, bs, bs_ok)
    finally:
        if originals:
            restore_sources(originals)


def report(results: Results) -> str:
    lines = ["", "\033[1m  Teardown strategies — full edit/rebuild cycle\033[0m", ""]
    by_arm: dict[str, list[Iteration]] = {}
    for it in results.iterations:
        by_arm.setdefault(it.arm, []).append(it)

    lines.append(f"  {'arm':<20} {'n':>2}  {'mean':>9}  {'median':>9}  {'min':>9}  {'max':>9}")
    lines.append(f"  {'-' * 68}")
    baseline: float | None = None
    for arm in ARMS:
        its = [i for i in by_arm.get(arm, []) if i.ok]
        if not its:
            lines.append(f"  {arm:<20}  0  (no successful runs)")
            continue
        totals = [i.total for i in its]
        mean = statistics.mean(totals)
        if baseline is None:
            baseline = mean
        lines.append(
            f"  {arm:<20} {len(its):>2}  {_fmt(mean):>9}  {_fmt(statistics.median(totals)):>9}"
            f"  {_fmt(min(totals)):>9}  {_fmt(max(totals)):>9}"
        )

    lines.append("")
    if baseline:
        for arm in list(ARMS)[1:]:
            its = [i for i in by_arm.get(arm, []) if i.ok]
            if not its:
                continue
            mean = statistics.mean([i.total for i in its])
            saved = baseline - mean
            lines.append(
                f"  {arm} vs A-clean: {_fmt(saved)} faster ({saved / baseline * 100:.1f}%)"
            )

    lines.append("")
    lines.append("  Teardown vs bootstrap split:")
    for arm in ARMS:
        its = [i for i in by_arm.get(arm, []) if i.ok]
        if not its:
            continue
        td = statistics.mean([i.teardown_s for i in its])
        bs = statistics.mean([i.bootstrap_s for i in its])
        lines.append(f"    {arm:<20} teardown {_fmt(td)}  bootstrap {_fmt(bs)}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Arms: A clean (cache pruned); B clean-state (cache kept); "
        "C clean-state with one entrypoint per service touched."
    )
    ap.add_argument("--iterations", type=int, default=5, help="iterations per arm")
    args = ap.parse_args()

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir = RESULTS_DIR / f"compare-{stamp}"
    run_dir.mkdir(parents=True, exist_ok=True)

    results = Results(started_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))
    total_runs = args.iterations * len(ARMS)
    print(f"\n\033[1m{total_runs} runs ({args.iterations} per arm), interleaved\033[0m")
    print(f"Logs: {run_dir.relative_to(REPO_ROOT)}\n")

    done = 0
    for i in range(1, args.iterations + 1):
        for arm in ARMS:
            it = run_iteration(arm, i, run_dir)
            results.iterations.append(it)
            done += 1
            print(f"    [{done}/{total_runs}] cumulative {_fmt(sum(x.total for x in results.iterations))}")
            # Persist after every run so a crash or interrupt keeps the data.
            (run_dir / "results.json").write_text(
                json.dumps(
                    {
                        "started_at": results.started_at,
                        "environment": {
                            "platform": platform.platform(),
                            "cpu_count": __import__("os").cpu_count(),
                        },
                        "iterations": [
                            {
                                "arm": x.arm,
                                "index": x.index,
                                "teardown_s": round(x.teardown_s, 2),
                                "bootstrap_s": round(x.bootstrap_s, 2),
                                "total_s": round(x.total, 2),
                                "ok": x.ok,
                            }
                            for x in results.iterations
                        ],
                    },
                    indent=2,
                )
                + "\n"
            )

    print(report(results))
    print(f"  Raw: {(run_dir / 'results.json').relative_to(REPO_ROOT)}\n")
    return 0 if all(i.ok for i in results.iterations) else 1


if __name__ == "__main__":
    raise SystemExit(main())
