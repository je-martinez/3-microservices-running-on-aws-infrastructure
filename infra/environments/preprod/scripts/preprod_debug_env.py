#!/usr/bin/env python3
"""Write .env.preprod.debug: every host-reachable URL plus the OpenObserve login.

CONTRACT: Loaded by NOTHING — a developer copies a value out. The file holds the
random OpenObserve password, so it is written mode 0o600 and `preprod-down` deletes it.
CONTRACT: No database URLs — pre-prod does not publish the RDS proxy ports to the host.
WARNING: Prints status lines only, never a value. See [[preprod]]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Callable

from e2e_env import OPENOBSERVE_USER
from lib3mrai.console import no, ok
from lib3mrai.envfile import MissingValue, terraform_output, write_env_file

ROOT = Path(__file__).resolve().parents[4]
FILE_NAME = ".env.preprod.debug"
HEADER = (
    "HOST-reachable browser URLs, ALB listeners and the OpenObserve login for pre-prod. "
    "No database URLs: the RDS proxy ports are not published. Loaded by nothing."
)
OUTPUTS = ("openobserve_root_password", "api_gateway_url", "ws_url")

ReadOutput = Callable[[Path, str], str]


def build(tf_dir: Path, read_output: ReadOutput) -> dict[str, str]:
    o = {name: read_output(tf_dir, name) for name in OUTPUTS}
    return {
        "WEB_URL": "http://localhost:9090",
        "OPENOBSERVE_URL": "http://localhost:5080",
        "OPENOBSERVE_USER": OPENOBSERVE_USER,
        "OPENOBSERVE_PASSWORD": o["openobserve_root_password"],
        "MAILPIT_URL": "http://localhost:8025",
        "USERS_URL": "http://localhost:9101",
        "ORDERS_URL": "http://localhost:9102",
        "TRACKING_URL": "http://localhost:9103",
        "API_GATEWAY_URL": o["api_gateway_url"],
        "WS_URL": o["ws_url"],
    }


def main(argv: list[str] | None = None, read_output: ReadOutput = terraform_output,
         root: Path = ROOT) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tf-dir", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        generated = build(args.tf_dir, read_output)
    except MissingValue:
        no("pre-prod Terraform outputs are missing — run `make preprod-up` first")
        return 1
    write_env_file(root / FILE_NAME, header=HEADER, generated=generated, mode=0o600)
    ok(f"{FILE_NAME} written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
