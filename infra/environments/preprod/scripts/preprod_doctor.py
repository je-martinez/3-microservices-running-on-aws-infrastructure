"""Diagnose pre-prod: ECS vs containers, ALB targets, aliases, phantom stores.

WARNING: Floci leaves target health at `initial` indefinitely while routing
traffic; only `unhealthy` is a failure here.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from lib3mrai.aws import client
from lib3mrai.console import no, ok

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from doctor import backing_state  # noqa: E402


def unhealthy_targets(descriptions: list[dict]) -> list[str]:
    return [d["Target"]["Id"] for d in descriptions if d["TargetHealth"]["State"] == "unhealthy"]


def remedy_for(state: str) -> str:
    return "make preprod-heal" if state == "exited" else "make preprod-down && make preprod-up"


def run_check(script: str, *args: str) -> int:
    sys.stdout.flush()
    return subprocess.run([sys.executable, str(Path(__file__).with_name(script)), *args]).returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cluster", required=True)
    parser.add_argument("--network", required=True)
    parser.add_argument("--redis-host", required=True)
    parser.add_argument("--docdb-host", required=True)
    parser.add_argument("--aliases", default="mailpit")
    args = parser.parse_args(argv)
    failures = 0

    ecs = client("ecs")
    ecs.list_clusters()  # WORKAROUND(local): wakes Floci's lazy ECS reconciler.
    arns = ecs.list_services(cluster=args.cluster)["serviceArns"]
    services = ecs.describe_services(cluster=args.cluster, services=arns)["services"] if arns else []
    for svc in services:
        line = f"ECS {svc['serviceName']}: {svc['runningCount']}/{svc['desiredCount']}"
        if svc["runningCount"] < svc["desiredCount"]:
            no(line)
            failures += 1
        else:
            ok(line)

    elb = client("elbv2")
    for tg in elb.describe_target_groups()["TargetGroups"]:
        health = elb.describe_target_health(TargetGroupArn=tg["TargetGroupArn"])
        bad = unhealthy_targets(health["TargetHealthDescriptions"])
        if bad:
            no(f"ALB {tg['TargetGroupName']}: unhealthy {bad}")
            failures += 1

    for host in (args.redis_host, args.docdb_host):
        state = backing_state(host)
        if state == "running":
            ok(f"{host} running")
        else:
            no(f"{host} is {state} - {remedy_for(state)}")
            failures += 1

    common = ["--cluster", args.cluster, "--network", args.network, "--check"]
    failures += run_check("preprod_targets.py", *common)
    failures += run_check("preprod_aliases.py", *common, "--aliases", args.aliases)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
