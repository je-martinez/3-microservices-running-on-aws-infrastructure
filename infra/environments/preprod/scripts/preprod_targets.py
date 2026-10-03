"""Deregister (or, with --check, report) ALB targets of stopped ECS tasks.

WORKAROUND(local): Floci never deregisters a stopped task's IP. After a Floci
restart every target group keeps the dead IP beside the new one, and the
listener answers 503 until health checks catch up; the dead IP then stays
`unhealthy` for good, and Docker may hand it to another task.
See [[2026-10-02-floci-preprod-environment-design]]
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

from lib3mrai.aws import client
from lib3mrai.console import inf, no, ok

DESCRIBE_BATCH = 100


def run_docker(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["docker", *args], capture_output=True, text=True)


def stale_targets(descriptions: list[dict], live_ips: set[str]) -> list[dict]:
    """Targets on no live task. Empty `live_ips` judges nothing: never strand a service."""
    if not live_ips:
        return []
    return [{"Id": d["Target"]["Id"], "Port": d["Target"]["Port"]}
            for d in descriptions if d["Target"]["Id"] not in live_ips]


def task_ip(networks: dict, network: str) -> str | None:
    return (networks.get(network) or {}).get("IPAddress") or None


def live_task_ids(ecs, cluster: str, service: str) -> list[str] | None:
    """Ids of every task not STOPPED, or None when describe_tasks cannot see one.

    WORKAROUND(local): Floci's list_tasks also returns STOPPED tasks, so liveness
    comes from describe_tasks; PENDING and PROVISIONING tasks count as live.
    """
    arns = ecs.list_tasks(cluster=cluster, serviceName=service, desiredStatus="RUNNING")["taskArns"]
    ids: list[str] = []
    for start in range(0, len(arns), DESCRIBE_BATCH):
        reply = ecs.describe_tasks(cluster=cluster, tasks=arns[start:start + DESCRIBE_BATCH])
        if reply.get("failures"):
            return None
        ids += [t["taskArn"].rsplit("/", 1)[-1] for t in reply.get("tasks", [])
                if t.get("lastStatus") != "STOPPED"]
    return ids


def live_ips(ecs, cluster: str, service: str, container: str, network: str, run=run_docker) -> set[str] | None:
    """IPs of every live task, or None when any one of them does not resolve.

    CONTRACT: Do NOT return a partial set — an unresolved live task's target
    would then be judged stale and deregistered.
    """
    ids = live_task_ids(ecs, cluster, service)
    if ids is None:
        return None
    ips = set()
    for task_id in ids:
        name = f"floci-ecs-{task_id}-{container}"
        nets = json.loads(run("inspect", name, "-f", "{{json .NetworkSettings.Networks}}").stdout or "{}")
        ip = task_ip(nets, network)
        if not ip:
            return None
        ips.add(ip)
    return ips


def main(argv: list[str] | None = None, run=run_docker) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--network", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    ecs, elb = client("ecs"), client("elbv2")
    known = {tg["TargetGroupArn"] for tg in elb.describe_target_groups()["TargetGroups"]}
    arns = ecs.list_services(cluster=args.cluster)["serviceArns"]
    services = ecs.describe_services(cluster=args.cluster, services=arns)["services"] if arns else []
    failures = 0
    for svc in services:
        for lb in svc.get("loadBalancers", []):
            tg = lb["targetGroupArn"]
            if tg not in known:
                continue
            ips = live_ips(ecs, args.cluster, svc["serviceName"], lb["containerName"], args.network, run)
            if not ips:
                msg = f"{svc['serviceName']}: a live task has no resolvable IP; {tg.split('/')[-2]} left untouched"
                if args.check:
                    no(msg)
                    failures += 1
                else:
                    inf(f"    {msg}")
                continue
            stale = stale_targets(elb.describe_target_health(TargetGroupArn=tg)["TargetHealthDescriptions"], ips)
            if not stale:
                continue
            ids = [t["Id"] for t in stale]
            if args.check:
                no(f"ALB {tg.split('/')[-2]}: stale targets {ids} - run make preprod-heal")
                failures += 1
                continue
            elb.deregister_targets(TargetGroupArn=tg, Targets=stale)
            ok(f"ALB {tg.split('/')[-2]}: deregistered stale targets {ids}")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
