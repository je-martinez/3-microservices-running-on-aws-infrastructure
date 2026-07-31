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
polls exactly that, rather than trusting that the alias attached.

That verification is ADVISORY: it warns but does not fail the script. Attaching
the alias is this script's job and `attach_alias` already exits non-zero on its
own if Docker refuses; the health poll only reports whether a *different*
container is answering yet. Conflating the two is what made a passing
precondition abort `make bootstrap` and skip every later step (JE-112).

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


def proxies_to_users(
    container: str, attempts: int = 20, sleep_s: int = 3
) -> tuple[bool, str]:
    """Poll users' health endpoint through the alias. Returns (healthy, detail).

    Same attempts/sleep_s budget as find_nginx_container above, and for the same
    reason: both wait on a container someone else started asynchronously. This
    one used to be a SINGLE probe behind a fixed one-second sleep, which is what
    made JE-112 reproduce on every cold bootstrap — `users` has no compose
    healthcheck, so the preceding `up -d --build users` returns when the
    container starts, not when Node has validated COGNITO_* and bound :3000.
    One second against a cold boot is a coin flip.

    60s is a deliberate ceiling, not a round number: a service that has not
    answered its own health endpoint a minute after starting is broken, not
    slow, and waiting longer only delays the diagnosis.

    stderr is kept rather than discarded — it is what distinguishes
    "bad address 'nginx-stable'" (the alias genuinely does not resolve) from
    "connection refused" (alias fine, users still booting). Both used to render
    as an empty string, which told the operator nothing.
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
        # NOT fatal, and that is the fix for JE-112.
        #
        # attach_alias() above already succeeded — it exits(1) itself when
        # `docker network connect` fails — so by this point Docker has confirmed
        # the alias IS attached and this script's own job is done. What just
        # failed is a check on a DIFFERENT container: `users`, started by the
        # previous make step, which has no compose healthcheck.
        #
        # Returning 1 here meant reporting someone else's readiness as this
        # script's failure, and because `make` halts a chain on any non-zero
        # exit, it skipped every later step — `orders`, `migrate-tracking`,
        # `tracking`. That is how a passing precondition left Tracking's tables
        # uncreated and produced "Table 'tracking.tracking' doesn't exist".
        # The advice it printed ("re-run after it is up") could not be followed
        # either: a re-run re-enters phase-1 apply, which Floci fails on
        # UpdateTags (JE-113).
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
