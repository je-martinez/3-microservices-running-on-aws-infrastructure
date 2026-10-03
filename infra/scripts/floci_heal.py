"""Recover a Floci stack after a Floci or Docker daemon restart.

Starts Exited DocumentDB/Valkey containers, wakes the ECS reconciler with one
API call, and removes task containers a SIGKILLed Floci left running beside
their replacement. See [[floci-recreate-destroys-backing-containers]]
"""

from __future__ import annotations

import re
import subprocess
import sys

from lib3mrai.aws import client
from lib3mrai.console import inf, no, ok

BACKING_SERVICES = ("docdb", "elasticache")
TASK_CONTAINER = re.compile(r"^floci-ecs-([0-9a-f]+)-")


def docker(*args: str) -> str:
    return subprocess.run(
        ["docker", *args], capture_output=True, text=True, check=False
    ).stdout


def wake_ecs(ecs) -> list[str]:
    return ecs.list_clusters().get("clusterArns", [])


def live_task_ids(ecs, cluster_arns: list[str]) -> set[str]:
    ids: set[str] = set()
    for arn in cluster_arns:
        for task in ecs.list_tasks(cluster=arn).get("taskArns", []):
            ids.add(task.rsplit("/", 1)[-1])
    return ids


def orphan_task_containers(container_names: list[str], live: set[str]) -> list[str]:
    orphans = []
    for name in container_names:
        match = TASK_CONTAINER.match(name)
        if match and match.group(1) not in live:
            orphans.append(name)
    return orphans


def exited_backing_containers(run=docker) -> list[str]:
    names: list[str] = []
    for service in BACKING_SERVICES:
        out = run(
            "ps", "-a",
            "--filter", "status=exited",
            "--filter", f"label=io.floci.service={service}",
            "--format", "{{.Names}}",
        )
        names.extend(n for n in out.split() if n)
    return names


def main(argv: list[str] | None = None) -> int:
    ecs = client("ecs")
    clusters = wake_ecs(ecs)
    ok(f"ECS reconciler woken ({len(clusters)} cluster(s))")

    exited = exited_backing_containers()
    for name in exited:
        docker("start", name)
        ok(f"restarted {name}")
    if not exited:
        inf("    no exited DocumentDB/Valkey containers")

    running = docker("ps", "--format", "{{.Names}}").split()
    orphans = orphan_task_containers(running, live_task_ids(ecs, clusters))
    for name in orphans:
        docker("rm", "-f", name)
        ok(f"removed orphan task container {name}")
    if not orphans:
        inf("    no orphan ECS task containers")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
