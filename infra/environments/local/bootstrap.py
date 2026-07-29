#!/usr/bin/env python3
"""Attach a STABLE Docker-DNS alias to the nginx ECS container.

WHY THIS EXISTS ────────────────────────────────────────────────────────────
Floci launches the nginx ECS task as a Docker container whose name and IP
change on every `terraform apply` (the task is recreated). Instead of patching
the API Gateway integration URI with a volatile IP each run, we attach a
CONSTANT network alias (`nginx-stable`) to whatever nginx container is running.
The API GW's per-route integrations in main.tf point at
http://nginx-stable/<route-path> (the path is baked in because Floci drops the
request path), and `nginx-stable` never changes. So the integration URIs are
correct at apply time, Terraform state never drifts, and re-running just
re-points the same alias.

Floci's Route53 is management-plane only (no resolution) and ECS tasks aren't
registered in Cloud Map, so a Docker-native alias is the working approach —
Docker's embedded DNS at 127.0.0.11 resolves it, including from Floci's API GW
container.

The API GW integration proxies to the REAL `users` service, whose health
endpoint returns {"status":"ok"} at /v1/health. The verification step below
checks exactly that, rather than trusting that the alias attached.

NOTE ON SCOPE: this script used to also create the least-privilege app DB users
(Postgres `users_app` / MySQL `orders_app`). Those steps moved to the PHASE-2
post-effects Terraform apply (`make infra-up-post`) — cleaner, secret-only, and
idempotent. See docs/superpowers/specs/2026-07-15-two-phase-post-effects-design.md
for that design and for why the MySQL app-user stays gated off on Floci.

Idempotent: safe to run repeatedly. Run once after each `terraform apply`.

Usage: .venv/bin/python infra/environments/local/bootstrap.py
"""

import os
import subprocess
import sys
import time

from lib3mrai.console import inf, no, ok

NETWORK = "3mrai_3mrai-network"
ALIAS = os.environ.get("NGINX_STABLE_ALIAS", "nginx-stable")

# Empty by default: attach the alias only and let Docker assign the IP. The API
# GW per-route integrations target http://nginx-stable/<path>, so a stable NAME
# is all that is required; pinning an IP only adds a failure mode, because Floci
# recreates its network with a different subnet across runs (observed
# 192.168.155.0/24 -> 192.168.148.0/24), so any hardcoded address eventually
# falls outside it and `docker network connect --ip` fails with
# "no configured subnet contains ...". Set NGINX_STABLE_IP=<addr> to opt back in.
FIXED_IP = os.environ.get("NGINX_STABLE_IP", "")

HEALTH_PATH = "/v1/health"
HEALTHY_BODY = '"status":"ok"'


def docker(*args: str) -> subprocess.CompletedProcess:
    """Run a docker command, capturing output. Never raises on non-zero."""
    return subprocess.run(["docker", *args], capture_output=True, text=True)


def find_nginx_container(attempts: int = 20, sleep_s: int = 3) -> str | None:
    """The running nginx ECS container Floci launched, or None after retries.

    Floci brings the task up asynchronously after apply, so this polls rather
    than assuming the container is already there.
    """
    for attempt in range(1, attempts + 1):
        for name in docker("ps", "--format", "{{.Names}}").stdout.split():
            lowered = name.lower()
            if "floci-ecs" in lowered and "nginx" in lowered:
                return name
        inf(f"waiting for nginx ECS container (attempt {attempt}/{attempts})…")
        time.sleep(sleep_s)
    return None


def container_with_alias(alias: str) -> str | None:
    """The container currently answering to `alias` on the compose network."""
    listed = docker("ps", "--filter", f"network={NETWORK}", "--format", "{{.Names}}")
    for name in listed.stdout.split():
        aliases = docker(
            "inspect",
            name,
            "--format",
            "{{range .NetworkSettings.Networks}}{{range .Aliases}}{{.}} {{end}}{{end}}",
        ).stdout.split()
        if alias in aliases:
            return name
    return None


def attach_alias(container: str) -> None:
    """(Re)attach the alias to `container`.

    Docker requires disconnect+connect to (re)set an alias or IP on an existing
    network membership; the disconnect is no-op-safe if not connected.
    """
    inf(
        f"attaching alias '{ALIAS}'"
        + (f" and IP {FIXED_IP}" if FIXED_IP else "")
        + f" on {NETWORK} ..."
    )
    docker("network", "disconnect", NETWORK, container)

    if FIXED_IP:
        pinned = docker(
            "network", "connect", "--alias", ALIAS, "--ip", FIXED_IP, NETWORK, container
        )
        if pinned.returncode == 0:
            return
        no(f"fixed IP {FIXED_IP} unavailable ({pinned.stderr.strip()}); retrying alias-only…")

    result = docker("network", "connect", "--alias", ALIAS, NETWORK, container)
    if result.returncode != 0:
        no(f"failed to attach alias '{ALIAS}': {result.stderr.strip()}")
        sys.exit(1)


def proxies_to_users(container: str) -> str:
    """The body the alias returns for users' health endpoint (may be empty)."""
    return docker(
        "exec",
        container,
        "sh",
        "-c",
        f"wget -qO- --timeout=5 http://{ALIAS}{HEALTH_PATH} 2>/dev/null",
    ).stdout


def main() -> int:
    print("== bootstrap: stable DNS alias for the nginx ECS container ==")

    nginx = find_nginx_container()
    if not nginx:
        no("no nginx ECS container found. Is Floci up and 'terraform apply' done?")
        return 1
    ok(f"nginx container: {nginx}")

    # Idempotent: if the alias already resolves to the running container, done.
    if container_with_alias(ALIAS) == nginx:
        ok(f"alias '{ALIAS}' already attached to the current nginx container — nothing to do.")
        return 0

    attach_alias(nginx)
    time.sleep(1)

    body = proxies_to_users(nginx)
    if HEALTHY_BODY not in body:
        no(f"alias attached but {HEALTH_PATH} did not return the expected body (got: '{body[:80]}')")
        inf("the users container may not be ready yet; re-run after it is up.")
        return 1

    ok(f'alias \'{ALIAS}\' resolves and proxies → users {HEALTH_PATH} {{"status":"ok"}}')
    print()
    print(f"  API GW per-route integrations already target http://{ALIAS}/<path> — no patch needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
