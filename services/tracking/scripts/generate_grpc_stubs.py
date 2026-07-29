#!/usr/bin/env python
"""Regenerate the Python gRPC stubs from `proto/tracking.proto`.

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
2. **The proto lives OUTSIDE the service.** `proto/tracking.proto` is at the repo
   root, shared with the .NET client in Orders. `services/tracking/Dockerfile` has
   the service directory as its build context, so a build-time generation step
   would need the context widened to the repo root — a change with blast radius
   well beyond this service.
3. **A contract change is reviewable.** The stubs are a diff in the PR that
   changes the .proto, so a wire-breaking edit is visible rather than implied.

The cost is that they can go stale. `tests/test_grpc_stubs.py` closes that: it
regenerates into a temp dir and fails if the committed output differs.

## The import rewrite

`protoc` emits `import tracking_pb2` (flat) into `tracking_pb2_grpc.py`, which only
resolves when the generated directory itself is on `sys.path`. That is exactly the
kind of implicit path requirement that works in tests and breaks in the container,
so this script rewrites it to a package-relative `from . import tracking_pb2`.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

# services/tracking/scripts/generate_grpc_stubs.py -> services/tracking
SERVICE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SERVICE_ROOT.parents[1]

PROTO_DIR = REPO_ROOT / "proto"
PROTO_FILE = PROTO_DIR / "tracking.proto"
OUTPUT_DIR = SERVICE_ROOT / "src" / "shared" / "grpc" / "generated"

#: What protoc writes, and what this script rewrites/normalizes afterwards.
GENERATED_FILES = ("tracking_pb2.py", "tracking_pb2.pyi", "tracking_pb2_grpc.py")

_FLAT_IMPORT = "import tracking_pb2 as tracking__pb2"
_RELATIVE_IMPORT = "from . import tracking_pb2 as tracking__pb2"


def generate(output_dir: Path, *, python: str | None = None) -> None:
    """Run protoc into `output_dir` and fix up the generated imports."""
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
            str(PROTO_FILE),
        ],
        check=True,
        cwd=REPO_ROOT,
    )
    _rewrite_imports(output_dir)


def _rewrite_imports(output_dir: Path) -> None:
    """Turn protoc's flat `import tracking_pb2` into a package-relative import."""
    grpc_module = output_dir / "tracking_pb2_grpc.py"
    source = grpc_module.read_text()
    if _FLAT_IMPORT not in source:
        raise SystemExit(
            f"expected {_FLAT_IMPORT!r} in {grpc_module}; protoc's output shape "
            "changed and this rewrite needs revisiting"
        )
    grpc_module.write_text(source.replace(_FLAT_IMPORT, _RELATIVE_IMPORT))


def main() -> None:
    generate(OUTPUT_DIR)
    print(f"generated {', '.join(GENERATED_FILES)} into {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
