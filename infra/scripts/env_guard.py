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


def refuse_if_other_runs(target: str, *, run=docker) -> int:
    """Gate a teardown of `target` whose sweeps would also hit the other environment.

    CONTRACT: Do NOT tear down while the other environment runs — the
    `name=^floci-` / `label=floci=true` sweeps match its Floci containers and
    volumes too, and its databases come back as phantoms reported `available`.
    """
    other = next(name for name in ENVIRONMENTS if name != target)
    project, teardown = ENVIRONMENTS[other]
    if not running(project, run):
        return 0
    no(f"{other} is running; refusing to tear down {target}: the sweep would delete {other}'s Floci containers and volumes.")
    inf(f"    run `make {teardown}` first if you meant to drop {other} too, then retry")
    return 1


USAGE = "usage: env_guard.py <dev|preprod>  |  env_guard.py --check-other <dev|preprod>"

if __name__ == "__main__":
    argv = sys.argv[1:]
    if len(argv) == 2 and argv[0] == "--check-other" and argv[1] in ENVIRONMENTS:
        sys.exit(refuse_if_other_runs(argv[1]))
    if len(argv) != 1 or argv[0] not in ENVIRONMENTS:
        no(USAGE)
        sys.exit(2)
    sys.exit(guard(argv[0]))
