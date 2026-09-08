#!/usr/bin/env python3
"""Attach a STABLE Docker-DNS alias to the nginx ECS container.

WORKAROUND(local): Floci recreates this container on every apply with a new name
and IP, and neither Route53 nor Cloud Map resolves there — the constant alias
`nginx-stable` is the only address the API GW integrations can hold.
CONTRACT: The health poll is ADVISORY. Failing on it aborts `make bootstrap`
and skips every later step. See [[two-phase-terraform-apply]]

Idempotent: run once after each `terraform apply`.
Usage: .venv/bin/python infra/environments/local/bootstrap.py
"""

import os
import subprocess
import sys
import time

from lib3mrai.console import inf, no, ok

NETWORK = "3mrai_3mrai-network"
ALIAS = os.environ.get("NGINX_STABLE_ALIAS", "nginx-stable")

# WORKAROUND(local): Do NOT pin an IP by default. Floci recreates its network on
# a different subnet across runs, so a hardcoded address eventually falls outside
# it and `docker network connect --ip` fails with "no configured subnet contains
# ...". A stable NAME is all the integrations need. NGINX_STABLE_IP opts back in.
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


def proxies_to_users(
    container: str, attempts: int = 20, sleep_s: int = 3
) -> tuple[bool, str]:
    """Poll users' health endpoint through the alias. Returns (healthy, detail).

    CONTRACT: Do NOT collapse this into a single probe behind a fixed sleep.
    `users` has no compose healthcheck, so `up -d --build users` returns before
    Node has bound :3000; one probe against a cold boot is a coin flip.
    """
    detail = ""
    for attempt in range(1, attempts + 1):
        result = docker(
            "exec",
            container,
            "sh",
            "-c",
            f"wget -qO- --timeout=5 http://{ALIAS}{HEALTH_PATH}",
        )
        if HEALTHY_BODY in result.stdout:
            return True, result.stdout
        # CONTRACT: Keep stderr here. It separates "bad address 'nginx-stable'"
        # (alias does not resolve) from "connection refused" (alias fine, users
        # still booting); dropping it leaves the operator an empty string.
        detail = (result.stdout or result.stderr).strip()[:160]
        if attempt < attempts:
            inf(f"waiting for {ALIAS}{HEALTH_PATH} (attempt {attempt}/{attempts})… {detail}")
            time.sleep(sleep_s)
    return False, detail


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

    healthy, detail = proxies_to_users(nginx)
    if not healthy:
        # CONTRACT: Do NOT return non-zero here. attach_alias already exited on
        # its own if Docker refused, so this only reports that a DIFFERENT
        # container (`users`, no compose healthcheck) is not answering yet. Make
        # halts the chain on any non-zero exit, skipping `orders`,
        # `migrate-tracking` and `tracking` — which is how Tracking's tables end
        # up uncreated ("Table 'tracking.tracking' doesn't exist"). Re-running is
        # no remedy either: it re-enters phase-1 apply, which Floci fails on
        # UpdateTags. See [[floci-rds-apigw-limits]]
        no(f"alias attached, but {HEALTH_PATH} never returned {HEALTHY_BODY} (last: '{detail}')")
        inf("the alias itself is attached — this is users not answering yet, not a broken alias.")
        inf(f"  check: docker exec {nginx} wget -qO- http://{ALIAS}{HEALTH_PATH}")
        inf("  check: docker compose logs users --tail 50")
        return 0

    ok(f'alias \'{ALIAS}\' resolves and proxies → users {HEALTH_PATH} {{"status":"ok"}}')
    print()
    print(f"  API GW per-route integrations already target http://{ALIAS}/<path> — no patch needed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
