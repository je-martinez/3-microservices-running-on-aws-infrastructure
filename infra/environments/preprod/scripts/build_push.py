"""Build (or retag) pre-prod images and push them to Floci's ECR.

CONTRACT: Tags are immutable and unique per content — a reused tag leaves ECS on
the old task definition while the deploy reports success. A tag already in ECR
(a clean tree on a pushed commit) is recorded, never rebuilt or re-pushed.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

from botocore.exceptions import ClientError

from lib3mrai.aws import client
from lib3mrai.console import inf, ok
from lib3mrai.envfile import terraform_output

import preprod_integrations as pi

ROOT = Path(__file__).resolve().parents[4]

BUILDS = {
    "users": (".", "services/users/Dockerfile"),
    "orders": (".", "services/orders/Dockerfile"),
    "tracking": ("services/tracking-go", "services/tracking-go/Dockerfile"),
    "web": (".", "apps/web/Dockerfile"),
    "otel-collector": (".", "observability/collector.Dockerfile"),
}
RETAGS = {
    "openobserve": "public.ecr.aws/zinclabs/openobserve:v0.91.1",
    "mailpit": "axllent/mailpit:v1.20",
}
ALL = list(BUILDS) + list(RETAGS)


def image_tag(sha: str, dirty: bool, now: float, content_hash: str = "") -> str:
    short = sha[:12]
    if not dirty:
        return short
    return f"{short}-dirty-{int(now)}-{content_hash[:8]}"


def web_build_args(ws_url: str, env: dict[str, str]) -> dict[str, str]:
    """CONTRACT: Never a secret key or the Geoapify key — every NG_APP_* is readable in the bundle."""
    stripe = pi.stripe_on(env)
    return {
        "NG_APP_API_GATEWAY_URL": "/v1",
        "NG_APP_WS_URL": ws_url,
        "NG_APP_STRIPE_ENABLED": "true" if stripe else "false",
        "NG_APP_STRIPE_PUBLISHABLE_KEY": env.get("STRIPE_PUBLISHABLE_KEY", "") if stripe else "",
        "NG_APP_GEOCODE_ENABLED": "true" if pi.geoapify_on(env) else "false",
        "NG_APP_RUM_ENABLED": "true",
    }


def config_suffix(build_args: dict[str, str]) -> str:
    digest = hashlib.sha256(json.dumps(sorted(build_args.items())).encode()).hexdigest()
    return f"-cfg{digest[:8]}"


def service_tag(service: str, base: str, build_args: dict[str, str]) -> str:
    """CONTRACT: Web's tag carries its build args — a clean tree tags by SHA alone and a
    tag already in ECR is never rebuilt, so a toggled integration would ship the old bundle."""
    return base + config_suffix(build_args) if service == "web" else base


def commands_for(service: str, url: str, tag: str, build_args: dict[str, str]) -> list[list[str]]:
    ref = f"{url}:{tag}"
    if service in RETAGS:
        src = RETAGS[service]
        return [["docker", "pull", src], ["docker", "tag", src, ref], ["docker", "push", ref]]
    context, dockerfile = BUILDS[service]
    build = ["docker", "build", "-f", dockerfile, "-t", ref]
    for key, value in build_args.items():
        build += ["--build-arg", f"{key}={value}"]
    return [build + [context], ["docker", "push", ref]]


def repository_name(url: str) -> str:
    return url.split("/", 1)[1]


def tag_in_ecr(ecr, repository: str, tag: str) -> bool:
    try:
        return bool(ecr.describe_images(repositoryName=repository,
                                        imageIds=[{"imageTag": tag}])["imageDetails"])
    except ClientError as exc:
        if exc.response["Error"]["Code"] == "ImageNotFoundException":
            return False
        raise


def services_to_push(services: list[str], exists) -> list[str]:
    return [s for s in services if not exists(s)]


def update_tags(path: Path, new: dict[str, str]) -> dict[str, str]:
    current = json.loads(path.read_text())["image_tags"] if path.exists() else {}
    current.update(new)
    path.write_text(json.dumps({"image_tags": current}, indent=2) + "\n")
    return current


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()


def _ecr_login(registry: str) -> None:
    token = client("ecr").get_authorization_token()["authorizationData"][0]["authorizationToken"]
    password = base64.b64decode(token).decode().split(":", 1)[1]
    subprocess.run(["docker", "login", "-u", "AWS", "--password-stdin", registry],
                   input=password, text=True, check=True, capture_output=True)


def _build_args(service: str, tf_dir: Path, env: dict[str, str]) -> dict[str, str]:
    if service == "web":
        return web_build_args(terraform_output(tf_dir, "ws_url"), env)
    if service == "orders":
        has_cache = subprocess.run(["docker", "image", "inspect", "3mrai-nuget-cache:latest"],
                                   capture_output=True).returncode == 0
        return {"SDK_IMAGE": "3mrai-nuget-cache:latest"} if has_cache else {}
    return {}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tf-dir", type=Path, required=True)
    parser.add_argument("--services", default="all")
    args = parser.parse_args(argv)
    services = ALL if args.services == "all" else args.services.split(",")

    urls = json.loads(subprocess.run(
        ["terraform", f"-chdir={args.tf_dir}", "output", "-json", "ecr_repository_urls"],
        capture_output=True, text=True, check=True).stdout)
    dirty = bool(_git("status", "--porcelain"))
    content = hashlib.sha256(_git("diff", "HEAD").encode()).hexdigest() if dirty else ""
    tag = image_tag(_git("rev-parse", "HEAD"), dirty, time.time(), content)
    _ecr_login(next(iter(urls.values())).split("/", 1)[0])

    env = pi.parse(pi.ENV_FILE)
    build_args = {s: _build_args(s, args.tf_dir, env) for s in services}
    tags = {s: service_tag(s, tag, build_args[s]) for s in services}

    ecr = client("ecr")
    to_push = services_to_push(services, lambda s: tag_in_ecr(ecr, repository_name(urls[s]), tags[s]))
    for service in services:
        if service not in to_push:
            inf(f"    {service}:{tags[service]} already in ECR - recording the tag, nothing built")
            continue
        inf(f"    {service} → {urls[service]}:{tags[service]}")
        for cmd in commands_for(service, urls[service], tags[service], build_args[service]):
            subprocess.run(cmd, cwd=ROOT, check=True)
        ok(f"pushed {service}:{tags[service]}")

    update_tags(args.tf_dir / "image-tags.auto.tfvars.json", tags)
    return 0


if __name__ == "__main__":
    sys.exit(main())
