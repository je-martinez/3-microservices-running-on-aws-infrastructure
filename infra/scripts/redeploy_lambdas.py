#!/usr/bin/env python
"""Redeploy every local Lambda from the current source.

WHY THIS EXISTS
---------------
A Lambda does NOT rebuild with `docker compose`. The services do — edit a file,
`docker compose up -d --build users`, done — so the habit the whole local stack
teaches you is wrong for exactly the four functions that need it most.

That gap shipped a real, silent bug. The Cognito CUSTOM_AUTH trigger was fixed to
emit `severity_text`/`severity_number` instead of a hardcoded `level: "info"`;
the source was correct, its tests passed, and the deployed function kept running
the version from days earlier. Every `otp_challenge_rejected` — a wrong one-time
code, the line someone looks for when investigating a failed login or a
brute-force attempt — kept arriving at severity 0, indistinguishable from an INFO
on every dashboard. Nothing anywhere reported a problem: the code said one thing,
the running function did another, and only reading the deployed zip revealed it.

`terraform apply` would also redeploy these (archive_file's hash triggers the
update), but a second phase-1 apply fails against Floci on UpdateTags — see
[[floci-rds-apigw-limits]] — so it is not the loop to reach for after a code
edit. This script does the one thing that is needed and nothing else.

WHAT IT DOES NOT DO
-------------------
It does not BUILD. The two bundled functions must be built first — the Makefile
target does that — because building here would hide which step failed and would
make a redeploy of unchanged code silently rebuild it.
"""

from __future__ import annotations

import io
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from lib3mrai.aws import client  # noqa: E402
from lib3mrai.console import inf, no, ok  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[2]

#: function name -> the files that make up its zip.
#:
#: The paths mirror what Terraform's archive_file packages, and the SHAPE of each
#: zip matters as much as its contents: every function's entrypoint must sit at
#: the ZIP ROOT (`handler.handler`, `index.handler`), never nested in a
#: directory, or the runtime cannot resolve it.
#:
#: The Cognito functions deliberately ship a BARE index.mjs with no package.json
#: beside it — that is what makes the nodejs runtime treat it as ESM/CJS the way
#: each expects. The otp-challenge directory is also a pnpm workspace so its tests
#: run, which adds node_modules and a package.json that must NOT ship; the
#: explicit file list below is what keeps them out, mirroring the `excludes` on
#: its archive_file.
LAMBDAS: dict[str, list[Path]] = {
    "3mrai-local-events": [
        REPO_ROOT / "functions/events-pipeline/dist/handler.js",
    ],
    "3mrai-local-realtime-ws-authorizer": [
        REPO_ROOT / "functions/realtime-events/dist/authorizer.js",
    ],
    "3mrai-local-realtime-ws-connect": [
        REPO_ROOT / "functions/realtime-events/dist/connect.js",
    ],
    "3mrai-local-realtime-ws-disconnect": [
        REPO_ROOT / "functions/realtime-events/dist/disconnect.js",
    ],
    "3mrai-local-realtime-ws-default": [
        REPO_ROOT / "functions/realtime-events/dist/default.js",
    ],
    "3mrai-local-cognito-otp-challenge": [
        REPO_ROOT / "infra/modules/cognito/otp-challenge-lambda/index.mjs",
    ],
    "3mrai-local-cognito-pretoken": [
        REPO_ROOT / "infra/modules/cognito/pre-token-lambda/index.mjs",
    ],
}


def build_zip(files: list[Path]) -> bytes:
    """Zip `files` at the archive ROOT, in memory.

    Deterministic timestamps are deliberately NOT set: the zip is uploaded, never
    compared, and Lambda computes its own code hash from the bytes.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, arcname=path.name)
    return buffer.getvalue()


def main() -> int:
    lambda_client = client("lambda")

    missing = {
        name: [p for p in paths if not p.exists()]
        for name, paths in LAMBDAS.items()
    }
    missing = {name: paths for name, paths in missing.items() if paths}
    if missing:
        # A missing dist/ means the build did not run. Failing here, naming the
        # file, beats uploading a stale zip and reporting success — which is the
        # exact failure mode this script exists to remove.
        for name, paths in missing.items():
            no(f"{name}: missing {', '.join(str(p.relative_to(REPO_ROOT)) for p in paths)}")
        no("build the functions first (make redeploy-lambdas does this for you)")
        return 1

    failed = False
    for name, paths in LAMBDAS.items():
        try:
            response = lambda_client.update_function_code(
                FunctionName=name,
                ZipFile=build_zip(paths),
            )
            ok(f"{name} -> {response.get('LastModified', 'updated')}")
        except Exception as exc:  # noqa: BLE001 - report every function, fail at the end
            # Carry on rather than aborting: one function missing from the
            # emulator must not leave the other six on stale code.
            no(f"{name}: {exc}")
            failed = True

    if failed:
        no("some functions were not updated — see above")
        return 1

    inf("all functions now run the current source")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
