"""The committed `openapi.yaml` still describes the routes the app really serves.

`scripts/generate_openapi.py` writes that file, and it is a COMMITTED build
artifact — the contract consumers import into Apidog. A committed artifact can go
stale, which is the failure this module exists to catch: a route added, renamed or
re-tagged without re-running the generator leaves a spec that is confidently wrong,
and nothing downstream notices until a consumer builds against it.

The same guard `tests/test_grpc_stubs.py` puts on the generated stubs, and the same
one Users puts on its spec (`tests/features/users/http/routes.test.ts`, "openapi
spec generation").

## Two different assertions, and both earn their place

`TestSpecIsCurrent` regenerates and compares against the committed bytes — it
catches everything, including changes nobody thought to write an assertion for.
`TestContractInvariants` pins the handful of facts that must hold no matter what
the routers say; those would still pass a byte comparison if the generator and the
routes drifted *together* (a route deleted, spec regenerated, both agree — and the
gateway 404s). Pinning the paths by hand is what makes that visible.

No database, no environment, and deliberately NOT marked `integration`: the OpenAPI
document is a routing-table fact, so these run in every suite — including the one
that runs when no MySQL is reachable, which is when a wiring mistake is likeliest to
go unnoticed.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest
import yaml

SERVICE_ROOT = Path(__file__).resolve().parents[1]
COMMITTED_SPEC = SERVICE_ROOT / "openapi.yaml"

#: Written once so a failure prints the command that fixes it — including the `-v`
#: mount, which is required because the image does not copy `scripts/`.
REGENERATE_HINT = (
    'from the repo root: `docker compose run --rm --no-deps '
    '-e E2E_TESTING_ENABLED=true -v "$PWD/services/tracking:/app" '
    "--entrypoint python tracking scripts/generate_openapi.py`"
)

# The generator lives under scripts/, which is not a package and is not on the
# path during a test run.
sys.path.insert(0, str(SERVICE_ROOT / "scripts"))

import generate_openapi  # noqa: E402


@pytest.fixture(scope="module")
def committed() -> dict[str, Any]:
    """The spec as committed, parsed."""
    return yaml.safe_load(COMMITTED_SPEC.read_text())


@pytest.fixture(scope="module")
def generated() -> dict[str, Any]:
    """The spec the live routes produce right now."""
    return generate_openapi.build_spec()


class TestSpecIsCurrent:
    """The committed file matches what the routes generate today."""

    def test_committed_spec_exists(self) -> None:
        """Fail loudly rather than with a confusing parse error downstream."""
        assert COMMITTED_SPEC.exists(), (
            f"{COMMITTED_SPEC} is missing — run {REGENERATE_HINT}"
        )

    def test_committed_spec_matches_the_live_routes(
        self, committed: dict[str, Any], generated: dict[str, Any]
    ) -> None:
        """Regenerate and compare.

        Compared as PARSED documents, not as raw text: a YAML formatting change
        (a re-wrapped description, a different quoting style) is not a contract
        change, and failing on one would train everyone to regenerate on red
        without reading why.
        """
        assert committed == generated, (
            "openapi.yaml is stale — the routes changed without regenerating it. "
            "Re-run `docker compose run --rm --no-deps "
            "-e E2E_TESTING_ENABLED=true --entrypoint python tracking "
            "scripts/generate_openapi.py` and commit the result."
        )


class TestContractInvariants:
    """Facts that must hold however the routers are edited."""

    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("get", "/v1/health"),
            ("post", "/v1/trackings/init-tracking"),
            ("get", "/v1/trackings"),
            ("get", "/v1/trackings/{order_id}"),
            ("put", "/v1/trackings/{order_id}/status"),
            # Present because the generator sets E2E_TESTING_ENABLED — the spec
            # documents the full contract including the flag-guarded surface.
            ("delete", "/v1/trackings/e2e-cleanup"),
        ],
    )
    def test_endpoint_is_documented(
        self, generated: dict[str, Any], method: str, path: str
    ) -> None:
        assert method in generated["paths"].get(path, {})

    def test_the_document_carries_the_local_server(
        self, generated: dict[str, Any]
    ) -> None:
        """Port 3002, matching docker-compose's host mapping.

        Users' spec carries the same key at its own port. Wrong here means every
        consumer that imports the file gets a base URL that connects to Users or
        Orders instead — a failure that looks like a Tracking bug.
        """
        assert generated["servers"] == [
            {
                "url": "http://localhost:3002",
                "description": "Local (docker compose / Floci)",
            }
        ]

    def test_every_route_carries_a_tag(self, generated: dict[str, Any]) -> None:
        """An untagged route is one Apidog files under a default bucket."""
        declared = {tag["name"] for tag in generated["tags"]}
        for path, operations in generated["paths"].items():
            for method, operation in operations.items():
                tags = operation.get("tags", [])
                assert tags, f"{method.upper()} {path} declares no tag"
                assert set(tags) <= declared, (
                    f"{method.upper()} {path} uses a tag missing from the "
                    f"document's tag list: {set(tags) - declared}"
                )


class TestAuthIsDocumentedPerRoute:
    """The three auth schemes are visible in the spec, and stay distinct.

    Tracking has no global security scheme on purpose — each surface declares its
    own header (`services/tracking/CLAUDE.md` §5a), so the spec documents them as
    per-route header parameters. A consumer reading the file must be able to tell
    which credential a route wants; conflating them is how an external carrier key
    ends up presented to a user-scoped read.
    """

    def _headers(self, operation: dict[str, Any]) -> set[str]:
        return {
            parameter["name"]
            for parameter in operation.get("parameters", [])
            if parameter.get("in") == "header"
        }

    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("post", "/v1/trackings/init-tracking"),
            ("get", "/v1/trackings"),
            ("get", "/v1/trackings/{order_id}"),
        ],
    )
    def test_user_scoped_routes_document_x_user_id(
        self, generated: dict[str, Any], method: str, path: str
    ) -> None:
        assert "x-user-id" in self._headers(generated["paths"][path][method])

    def test_the_carrier_put_documents_its_own_key_and_no_user_identity(
        self, generated: dict[str, Any]
    ) -> None:
        """The carrier PUT takes `x-api-key` and must NOT take `x-user-id`.

        It is `auth = false` at the gateway, so no `x-user-id` is ever injected
        (§5a). A spec claiming otherwise would tell an integrator to send a header
        that never arrives, and hint the endpoint is user-scoped when it scopes by
        `order_id` alone.
        """
        headers = self._headers(
            generated["paths"]["/v1/trackings/{order_id}/status"]["put"]
        )
        assert "x-api-key" in headers
        assert "x-user-id" not in headers

    @pytest.mark.parametrize(
        ("method", "path"),
        [
            ("get", "/v1/health"),
            ("delete", "/v1/trackings/e2e-cleanup"),
        ],
    )
    def test_the_unauthenticated_routes_document_no_credential(
        self, generated: dict[str, Any], method: str, path: str
    ) -> None:
        """Health and the E2E cleanup take neither header, deliberately (§5a)."""
        headers = self._headers(generated["paths"][path][method])
        assert not headers & {"x-user-id", "x-api-key"}

    def test_the_user_scoped_reads_document_their_401(
        self, generated: dict[str, Any]
    ) -> None:
        """A missing `x-user-id` is a `401`, and the spec says so.

        FastAPI infers only the success shape: the `401` comes from a dependency
        raising, so it appears in the document only because the routes declare it.
        Both reads shipped without it — the spec showed a `200`-or-`422` surface
        for endpoints that reject an anonymous caller outright.
        """
        for path in ("/v1/trackings", "/v1/trackings/{order_id}"):
            assert "401" in generated["paths"][path]["get"]["responses"]
