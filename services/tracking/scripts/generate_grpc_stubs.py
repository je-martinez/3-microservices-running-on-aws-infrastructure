#!/usr/bin/env python
"""Regenerate the Python gRPC stubs from the shared protos.

ONE contract, OUTBOUND (JE-101):

* `proto/users.proto` — the surface this service **calls** (`GetUserById`, to
  resolve a Cognito sub to the internal `usr_` id, mirroring Orders'
  `UserDirectoryGrpcClient`). Only the client half of that stub is used here; the
  servicer base class protoc also emits is never subclassed.

There used to be a second entry, `proto/tracking.proto` — the surface this service
**served**. It went away with the gRPC server itself (JE-108): creation is
`POST /v1/trackings/init-tracking` and the reads are user-scoped REST. The list
below is still a list, and the generation is still a loop over it, so restoring a
second contract remains a one-line edit rather than a second script that could
drift to different codegen flags.

Run from anywhere:

    services/tracking/.venv/bin/python services/tracking/scripts/generate_grpc_stubs.py

## Why the output is COMMITTED

The generated modules under `src/shared/grpc/generated/` are checked in, unlike
Users, which loads `proto/users.proto` at runtime with `@grpc/proto-loader` and
therefore needs no build step at all. Python has no equivalent: protobuf/gRPC
codegen is mandatory, so the only question is *when* it runs.

Committing it wins on three counts here:

1. **The image needs no toolchain.** `grpcio-tools` pulls in `protoc` and pins a
   `protobuf` major version; generating at image build would put a compiler in the
   runtime image (or force a multi-stage build) for an artifact that changes only
   when the .proto does.
2. **The proto lives OUTSIDE the service.** `proto/users.proto` is at the repo
   root, owned by Users and shared with the .NET side in Orders.
   `services/tracking/Dockerfile` has the service directory as its build context,
   so a build-time generation step would need the context widened to the repo root
   — a change with blast radius well beyond this service.
3. **A contract change is reviewable.** The stubs are a diff in the PR that
   changes the .proto, so a wire-breaking edit is visible rather than implied.

The cost is that they can go stale. `tests/test_grpc_stubs.py` closes that: it
regenerates into a temp dir and fails if the committed output differs — for every
proto listed below, so adding one here automatically extends that guard.

## The import rewrite

`protoc` emits `import users_pb2` (flat) into `users_pb2_grpc.py`, which only
resolves when the generated directory itself is on `sys.path`. That is exactly the
kind of implicit path requirement that works in tests and breaks in the container,
so this script rewrites it to a package-relative `from . import users_pb2`.
"""

from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path

# services/tracking/scripts/generate_grpc_stubs.py -> services/tracking
SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]

PROTO_DIR = REPO_ROOT / "proto"
OUTPUT_DIR = SERVICE_ROOT / "src" / "shared" / "grpc" / "generated"

# Running this file directly puts scripts/ on sys.path, not the service root, so
# `from src.shared…` in main() would not resolve. Derived from __file__ rather
# than assuming a cwd, matching generate_openapi.py.
if str(SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVICE_ROOT))

#: The protos this service generates stubs for, by base name. `users` is the
#: surface it CALLS (JE-101), and the only one left since JE-108 removed the served
#: surface. Adding an entry is the only edit needed — the file list, the generation
#: and the import rewrite are all derived from it.
PROTO_STEMS: tuple[str, ...] = ("users",)

PROTO_FILES: tuple[Path, ...] = tuple(
    PROTO_DIR / f"{stem}.proto" for stem in PROTO_STEMS
)

#: What protoc writes, and what this script rewrites/normalizes afterwards.
GENERATED_FILES: tuple[str, ...] = tuple(
    f"{stem}_pb2{suffix}"
    for stem in PROTO_STEMS
    for suffix in (".py", ".pyi", "_grpc.py")
)


def _flat_import(stem: str) -> str:
    """What protoc emits into `<stem>_pb2_grpc.py` — a top-level import."""
    return f"import {stem}_pb2 as {stem}__pb2"


def _relative_import(stem: str) -> str:
    """What we rewrite it to, so the package imports from anywhere."""
    return f"from . import {stem}_pb2 as {stem}__pb2"


def generate(output_dir: Path, *, python: str | None = None) -> None:
    """Run protoc into `output_dir` and fix up the generated imports.

    All protos are passed in a SINGLE protoc invocation so they share one
    descriptor pool pass — and so a new contract cannot accidentally be generated
    with different flags than the existing one.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            python or sys.executable,
            "-m",
            "grpc_tools.protoc",
            f"-I{PROTO_DIR}",
            f"--python_out={output_dir}",
            f"--grpc_python_out={output_dir}",
            f"--pyi_out={output_dir}",
            *(str(proto) for proto in PROTO_FILES),
        ],
        check=True,
        cwd=REPO_ROOT,
    )
    _rewrite_imports(output_dir)


def _rewrite_imports(output_dir: Path) -> None:
    """Turn protoc's flat `import <stem>_pb2` into a package-relative import."""
    for stem in PROTO_STEMS:
        grpc_module = output_dir / f"{stem}_pb2_grpc.py"
        source = grpc_module.read_text()
        flat = _flat_import(stem)
        if flat not in source:
            raise SystemExit(
                f"expected {flat!r} in {grpc_module}; protoc's output shape "
                "changed and this rewrite needs revisiting"
            )
        grpc_module.write_text(source.replace(flat, _relative_import(stem)))


def main() -> None:
    # The SERVICE's logger, matching generate_openapi.py next door.
    #
    # This one runs from the host venv rather than inside the container, so its
    # stdout is NOT shipped to the collector the way that script's is — but it
    # uses the same mechanism anyway. A reader comparing the two should not have
    # to work out which invocation path each takes to know why they differ, and
    # the next script copied from either one inherits the correct shape by
    # default. `service_name` names the SCRIPT: this is tooling, and attributing
    # its output to `tracking` would mix codegen noise into the service's logs.
    from src.shared.logging.config import configure_logging

    configure_logging(service_name="tracking-grpc-stub-generator")
    logger = logging.getLogger(__name__)

    generate(OUTPUT_DIR)
    logger.info(
        "grpc_stubs_generated",
        extra={
            "app_event": "grpc_stubs_generated",
            "output_dir": str(OUTPUT_DIR),
            "generated_files": list(GENERATED_FILES),
        },
    )


if __name__ == "__main__":
    main()
