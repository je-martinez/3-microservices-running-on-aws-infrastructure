"""Attach stable Docker-network aliases to pre-prod ECS task containers.

WORKAROUND(local): Floci names ECS task containers randomly and Cloud Map does
not resolve them. Non-HTTP clients (Floci's SES relay to Mailpit SMTP, gRPC to
Users when `users_grpc_via_alb` is false) need a fixed name; without it they
fail with a DNS lookup error. A self-healed task loses its alias until this
runs again. The reconnect pins the task's original IP: the ALB target group
registered that IP, and a new one leaves the target unhealthy (503 at :9101). See [[2026-10-02-floci-preprod-environment-design]]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

from lib3mrai.aws import client
from lib3mrai.console import no, ok

ALIASES = {"mailpit": ("mailpit", "mailpit"), "users-grpc": ("users", "users")}


def run_docker(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True)


def container_for(task_ids: set[str], names: list[str], container: str) -> str | None:
    for name in names:
        if name.endswith(f"-{container}") and name.split("-")[2] in task_ids:
            return name
    return None


def newest_running(tasks: list[dict]) -> set[str]:
    """Id of the RUNNING task with the latest startedAt; the rollout survivor."""
    live = [t for t in tasks if t.get("lastStatus") == "RUNNING"]
    if not live:
        return set()
    newest = max(live, key=lambda t: t["startedAt"])
    return {newest["taskArn"].rsplit("/", 1)[-1]}


def missing_aliases(current: dict[str, list[str]], wanted: list[str]) -> list[str]:
    return [a for a in wanted if a not in current.get(a, [])]


def main(argv: list[str] | None = None, run=run_docker) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--network", required=True)
    parser.add_argument("--aliases", default="mailpit")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    ecs = client("ecs")
    names = run("ps", "--format", "{{.Names}}").stdout.split()
    failures = 0
    for alias in args.aliases.split(","):
        service, container = ALIASES[alias]
        arns = ecs.list_tasks(cluster=args.cluster, serviceName=service, desiredStatus="RUNNING")["taskArns"]
        tasks = ecs.describe_tasks(cluster=args.cluster, tasks=arns)["tasks"] if arns else []
        target = container_for(newest_running(tasks), names, container)
        if target is None:
            no(f"{alias}: no running task for service {service}")
            failures += 1
            continue
        nets = json.loads(run("inspect", target, "-f", "{{json .NetworkSettings.Networks}}").stdout or "{}")
        current = {alias: (nets.get(args.network) or {}).get("Aliases") or []}
        if not missing_aliases(current, [alias]):
            ok(f"{alias} -> {target}")
            continue
        if args.check:
            no(f"{alias} missing on {target} - run make preprod-aliases")
            failures += 1
            continue
        ip = (nets.get(args.network) or {}).get("IPAddress")
        run("network", "disconnect", args.network, target)
        connect = run("network", "connect", "--alias", alias, *(["--ip", ip] if ip else []), args.network, target)
        if connect.returncode != 0:
            no(f"{alias}: docker network connect failed on {target}: {connect.stderr.strip()}")
            failures += 1
            continue
        ok(f"{alias} attached to {target}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
