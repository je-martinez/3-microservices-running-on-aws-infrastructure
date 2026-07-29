"""The committed gRPC stubs must match `proto/users.proto`.

Committing generated code buys reproducibility and a reviewable diff, at the cost
of the stubs going stale when someone edits the .proto and forgets to regenerate.
This closes that: the codegen is re-run into a temp directory and compared byte for
byte with what is checked in.

`users.proto` is OWNED BY USERS and consumed by both Orders and Tracking, which is
what makes this guard matter more than usual here: the contract can change in a
service that has no way to know these stubs exist.

A failure here means exactly one thing — run:

    services/tracking/.venv/bin/python services/tracking/scripts/generate_grpc_stubs.py
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.generate_grpc_stubs import (  # noqa: E402
    GENERATED_FILES,
    OUTPUT_DIR,
    PROTO_FILES,
    generate,
)

#: Codegen needs grpcio-tools, which is a dev dependency. Skip rather than fail
#: where only the runtime deps are installed (e.g. inside the built image).
pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("grpc_tools") is None,
    reason="grpcio-tools not installed; stub-freshness check needs the codegen tool",
)


def test_proto_sources_exist() -> None:
    """The stubs are generated from the SHARED root protos, not service copies."""
    missing = [str(proto) for proto in PROTO_FILES if not proto.exists()]
    assert not missing, f"missing {', '.join(missing)}"


def test_only_the_outbound_users_contract_is_generated() -> None:
    """Tracking serves no gRPC (JE-108), so it generates no served contract.

    Pinning the list rather than merely checking `users` is present: a served
    surface reappearing here would be a transport decision, and it should not be
    reachable by adding a string to a tuple without anyone noticing.
    """
    assert [proto.name for proto in PROTO_FILES] == ["users.proto"]


def test_committed_stubs_match_the_proto() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        fresh = Path(tmp)
        generate(fresh)

        stale = [
            name
            for name in GENERATED_FILES
            if (OUTPUT_DIR / name).read_bytes() != (fresh / name).read_bytes()
        ]

    assert not stale, (
        f"committed gRPC stubs are stale: {', '.join(stale)}. Regenerate with "
        "`.venv/bin/python scripts/generate_grpc_stubs.py` and commit the result."
    )


def test_generated_grpc_module_uses_a_relative_import() -> None:
    """protoc emits a flat `import users_pb2`, which only resolves when the
    generated directory itself is on sys.path — the rewrite is what makes the
    package importable from anywhere, including the container."""
    source = (OUTPUT_DIR / "users_pb2_grpc.py").read_text()
    assert "from . import users_pb2 as users__pb2" in source
    assert "\nimport users_pb2 as users__pb2" not in source
