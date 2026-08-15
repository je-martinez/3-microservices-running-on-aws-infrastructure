#!/usr/bin/env python
"""Generate `services/tracking/openapi.yaml` from the live FastAPI routes.

The contract imported into Apidog, at parity with `services/users/openapi.yaml`
and `services/orders/openapi.yaml`. Both of those are generated from their
frameworks' route definitions rather than hand-written, for the reason
[[users-openapi-autogen]] records: a hand-maintained spec drifts from the real
routes the moment a router changes, and nothing catches it until a consumer does.

Run it from the repo root, inside the tracking image (see "Why the container"):

    docker compose run --rm --no-deps \\
        -e E2E_TESTING_ENABLED=true \\
        -v "$PWD/services/tracking:/app" \\
        --entrypoint python tracking scripts/generate_openapi.py

## Why the container, and not a host venv

`services/tracking` has no `.venv` and the repo-root `make` targets never create
one — `migrate-tracking` runs Alembic inside a one-off `tracking` container for
exactly this reason. The image already carries FastAPI and Pydantic, so the
container needs no second toolchain; a host venv would be a parallel dependency
set that can disagree with the one the service actually runs.

## Why the `-v` mount is not optional

`Dockerfile` copies `src/`, `alembic/` and the configs — **not** `scripts/`, which
is build/dev tooling the runtime image has no use for. Without the mount the
container starts fine and then cannot find this file. The mount also puts the
written `openapi.yaml` on the host, where it belongs; a run without it would write
into the container's filesystem and vanish with it.

## No database, no environment

`create_app()` builds the routers and nothing else — there is no `lifespan`, no
engine is constructed at import, and `openapi()` only walks the route table. The
REST tests already build the real app this way (`tests/test_app_factory.py`), so
this script needs no DB, no Cognito, and no valid `Settings`: the settings object
is resolved per request, through a dependency, and no request is ever made here.

## `E2E_TESTING_ENABLED` is set ON, deliberately

The flag decides whether `DELETE /v1/trackings/e2e-cleanup` is *registered*
(`src/main.py`), so with it off the route is absent from the document. The spec
should describe the full contract — including the test-only surface and the fact
that it is flag-guarded — which is what Users' generator does for its own cleanup
routes. Turning it on here documents the route; it does not turn it on anywhere a
request can reach.

## The output is a COMMITTED build artifact

Like the gRPC stubs next door, `openapi.yaml` is checked in and regenerated
deliberately. Any Tracking route or schema change must re-run this script and
commit the result in the same change — `tests/test_openapi_spec.py` fails when
the committed file no longer matches the live routes, so the drift surfaces in CI
rather than in Apidog.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

import yaml

# services/tracking/scripts/generate_openapi.py -> services/tracking
SERVICE_ROOT = Path(__file__).resolve().parents[1]

OUTPUT_FILE = SERVICE_ROOT / "openapi.yaml"

# `python scripts/generate_openapi.py` puts scripts/ on sys.path, not the service
# root, so `import src.main` fails however the container is invoked. Derived from
# __file__ rather than assuming a cwd, so the script runs from anywhere.
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))


def build_spec() -> dict[str, Any]:
    """Return the OpenAPI document for the FULL contract, cleanup route included.

    The flag is set BEFORE `create_app` is imported, not after: `src.main` reads
    it through `e2e_testing_enabled()` while the factory runs, and the factory is
    called at module scope (`app = create_app()`) as the import's last statement.
    Setting it afterwards would leave the module-level app — and any app built
    from a module already imported — without the cleanup route.
    """
    os.environ["E2E_TESTING_ENABLED"] = "true"

    from src.main import create_app

    return create_app().openapi()


def dump(spec: dict[str, Any]) -> str:
    """Serialize to YAML with a stable, diff-friendly shape.

    `sort_keys=False` preserves FastAPI's insertion order, so `openapi`/`info`/
    `paths` read top-down and routes keep their registration order instead of
    being alphabetized into a shape that has nothing to do with the service.
    `default_flow_style=False` keeps everything block-style — a spec with inline
    `{...}` maps is one nobody can review a diff of.
    """
    return yaml.dump(
        spec,
        sort_keys=False,
        default_flow_style=False,
        allow_unicode=True,
        width=88,
    )


def main() -> None:
    OUTPUT_FILE.write_text(dump(build_spec()))
    print(f"Wrote {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
