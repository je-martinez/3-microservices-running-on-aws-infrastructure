"""Refuse to start one local environment while the other one runs.

CONTRACT: Dev and pre-prod both need host port 4566 and the fixed-name
`floci-ecr-registry` container; ECR URIs always point at :4566, so with both up
the daemon pulls images from the WRONG Floci (observed: NoSuchBucket on pull).
Without a TTY this aborts — it never drops an environment nobody confirmed.
See [[environment-exclusivity]]
"""

from __future__ import annotations

import subprocess
import sys

from lib3mrai.console import inf, no, ok

ENVIRONMENTS = {"dev": ("3mrai", "clean"), "preprod": ("3mrai-preprod", "preprod-down")}


def docker(*args: str) -> str:
    return subprocess.run(["docker", *args], capture_output=True, text=True).stdout


def run_make(target: str) -> None:
    subprocess.run(["make", "--no-print-directory", target], check=True)


def running(project: str, run=docker) -> bool:
    out = run("ps", "-q", "--filter", f"label=com.docker.compose.project={project}")
    return bool(out.strip())


def guard(target: str, *, run=docker, ask=input, isatty=sys.stdin.isatty, make=run_make) -> int:
    other = next(name for name in ENVIRONMENTS if name != target)
    project, teardown = ENVIRONMENTS[other]
    if not running(project, run):
        return 0
    if not isatty():
        no(f"{other} is running; refusing to start {target} without a TTY to confirm.")
        inf(f"    run `make {teardown}` first, then retry")
        return 1
    answer = ask(f"{other} is running. [d]rop {other} and start {target}, or do [n]othing? ")
    if answer.strip().lower().startswith("d"):
        make(teardown)
        ok(f"{other} dropped")
        return 0
    inf(f"    nothing done; {other} left running")
    return 1


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ENVIRONMENTS:
        no("usage: env_guard.py <dev|preprod>")
        sys.exit(2)
    sys.exit(guard(sys.argv[1]))
