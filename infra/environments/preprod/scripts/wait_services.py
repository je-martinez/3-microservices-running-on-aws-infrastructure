"""Block until every ECS service in a cluster runs its desired count.

WARNING: runningCount can report 1 with no task container behind it right after
a Floci restart; the wait also requires a container per task. See [[2026-10-02-floci-preprod-environment-design]]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time

from lib3mrai.aws import client
from lib3mrai.console import no, ok


def converged(services: list[dict]) -> list[str]:
    return [s["serviceName"] for s in services if s["runningCount"] < s["desiredCount"]]


def _task_containers_exist(ecs, cluster: str) -> bool:
    ids = [a.rsplit("/", 1)[-1] for a in ecs.list_tasks(cluster=cluster)["taskArns"]]
    names = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                           capture_output=True, text=True).stdout
    return all(f"floci-ecs-{i}-" in names for i in ids)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--timeout", type=int, default=600)
    args = parser.parse_args(argv)
    ecs = client("ecs")
    deadline = time.time() + args.timeout
    lagging: list[str] = []
    while time.time() < deadline:
        arns = ecs.list_services(cluster=args.cluster)["serviceArns"]
        services = ecs.describe_services(cluster=args.cluster, services=arns)["services"] if arns else []
        lagging = converged(services)
        if services and not lagging and _task_containers_exist(ecs, args.cluster):
            ok(f"{len(services)} service(s) running")
            return 0
        time.sleep(5)
    no(f"timed out; still converging: {', '.join(lagging) or 'task containers'}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
