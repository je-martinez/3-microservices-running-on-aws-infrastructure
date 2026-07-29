"""The committed gRPC stubs must match `proto/tracking.proto`.

Committing generated code buys reproducibility and a reviewable diff, at the cost
of the stubs going stale when someone edits the .proto and forgets to regenerate.
This closes that: the codegen is re-run into a temp directory and compared byte for
byte with what is checked in.

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
    PROTO_FILE,
    generate,
)

#: Codegen needs grpcio-tools, which is a dev dependency. Skip rather than fail
#: where only the runtime deps are installed (e.g. inside the built image).
pytestmark = pytest.mark.skipif(
    importlib.util.find_spec("grpc_tools") is None,
    reason="grpcio-tools not installed; stub-freshness check needs the codegen tool",
)


def test_proto_source_exists() -> None:
    """The stubs are generated from the SHARED root proto, not a service copy."""
    assert PROTO_FILE.exists(), f"missing {PROTO_FILE}"


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
    """protoc emits a flat `import tracking_pb2`, which only resolves when the
    generated directory itself is on sys.path — the rewrite is what makes the
    package importable from anywhere, including the container."""
    source = (OUTPUT_DIR / "tracking_pb2_grpc.py").read_text()
    assert "from . import tracking_pb2 as tracking__pb2" in source
    assert "\nimport tracking_pb2 as tracking__pb2" not in source
