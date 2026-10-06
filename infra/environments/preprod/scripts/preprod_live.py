"""Refuse `make preprod-up` on a pre-prod that already runs services.

CONTRACT: preprod-up's first apply sets deploy_services=false, which DESTROYS
every ECS service of a live environment before rebuilding it. Run this before
that apply; a from-scratch run (no state, or a cluster with no services) passes.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

from botocore.exceptions import ClientError

from lib3mrai.aws import client
from lib3mrai.console import inf, no


def cluster_name(tf_dir: Path, run=subprocess.run) -> str | None:
    if not (tf_dir / "terraform.tfstate").exists():
        return None
    out = run(["terraform", f"-chdir={tf_dir}", "output", "-raw", "ecs_cluster_name"],
              capture_output=True, text=True)
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def live_services(ecs, cluster: str) -> list[str]:
    try:
        return ecs.list_services(cluster=cluster).get("serviceArns", [])
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ClusterNotFoundException":
            return []
        raise


def check(cluster: str | None, ecs_factory=lambda: client("ecs")) -> int:
    if not cluster or not live_services(ecs_factory(), cluster):
        return 0
    no("pre-prod is already up — use `make preprod-deploy S=<svc>` or `make preprod-down` first")
    inf("    preprod-up rebuilds from scratch; on a live environment it would destroy every service")
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tf-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    return check(cluster_name(args.tf_dir))


if __name__ == "__main__":
    sys.exit(main())
