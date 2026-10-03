"""Block until every ECS service in a cluster runs its desired count.

WARNING: runningCount includes the old task during a rollout and can report 1
with no container after a Floci restart. Count RUNNING tasks per service (== desired)
created after the PRIMARY deployment, each with a container. See [[2026-10-02-floci-preprod-environment-design]]
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time

from lib3mrai.aws import client
from lib3mrai.console import no, ok


def converged(services: list[dict], running: dict[str, list[str]]) -> list[str]:
    """Services whose RUNNING task count differs from desiredCount (overlap included)."""
    return [s["serviceName"] for s in services
            if len(running.get(s["serviceName"], [])) != s["desiredCount"]]


def current_running(tasks: list[dict], service: dict) -> list[str]:
    """RUNNING tasks created at or after the PRIMARY deployment, i.e. not the pre-deploy task."""
    primary = [d for d in service.get("deployments", []) if d.get("status") == "PRIMARY"]
    since = primary[0]["createdAt"] if primary else None
    return [t["taskArn"].rsplit("/", 1)[-1] for t in tasks
            if t["lastStatus"] == "RUNNING" and (since is None or t["createdAt"] >= since)]


def running_task_ids(ecs, cluster: str, services: list[dict]) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for svc in services:
        name = svc["serviceName"]
        arns = ecs.list_tasks(cluster=cluster, serviceName=name, desiredStatus="RUNNING")["taskArns"]
        tasks = ecs.describe_tasks(cluster=cluster, tasks=arns)["tasks"] if arns else []
        out[name] = current_running(tasks, svc)
    return out


def _containers_exist(task_ids: list[str]) -> bool:
    names = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                           capture_output=True, text=True).stdout
    return all(f"floci-ecs-{i}-" in names for i in task_ids)


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
        running = running_task_ids(ecs, args.cluster, services)
        lagging = converged(services, running)
        if services and not lagging and _containers_exist([i for ids in running.values() for i in ids]):
            ok(f"{len(services)} service(s) running")
            return 0
        time.sleep(5)
    no(f"timed out; still converging: {', '.join(lagging) or 'task containers'}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
