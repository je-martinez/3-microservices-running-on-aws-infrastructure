#!/usr/bin/env python3
"""Locate the Pencil MCP server binary and exec it, so `.mcp.json` is portable.

`.mcp.json` is committed, and the Pencil MCP server is a binary shipped INSIDE
the Pen desktop app — at an absolute path whose filename encodes the platform
(`mcp-server-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `win32-x64.exe`). Naming
one of those paths directly in the committed config makes the repo work on
exactly one machine: everyone else gets a server that cannot start, and anybody
who edits the path to suit their box carries a permanently dirty diff.

This resolver keeps `.mcp.json` machine-independent. It searches the known
install locations for the binary matching the current platform, then `exec`s it
so the MCP stdio transport is unaffected — no extra process sits between the
client and the server.

WHY NOT THE `~/.pencil/mcp/cursor/` BINARY. Pencil also installs per-editor
bridges under `~/.pencil/mcp/<editor>/`. The Cursor one accepts a
`--agent claudeCodeCLI` flag and looks like it should work, but every call fails
with "A file needs to be open in the editor" even with the file demonstrably
open — the Pen renderer reports `connectedAgents: []`, so the app never registers
the agent. That cost six failed reconnects to diagnose. Only the bundled binary
run with `--app desktop` talks to the running desktop app. This resolver
deliberately never falls back to the per-editor bridges: a working-looking server
that answers every call with an error is worse than one that fails to start.

Escape hatch: set `PENCIL_MCP_BIN` in `.env` to an absolute path and it is used
verbatim, for installs this does not know about.

Usage (from .mcp.json):
    python3 scripts/pencil_mcp.py [extra args passed through to the server]
"""
from __future__ import annotations

import os
import platform
import sys
from pathlib import Path

# Passed to the bundled server so it attaches to the running desktop app. The
# per-editor bridges take `--app cursor` instead; see the module docstring for
# why those are not usable here.
DESKTOP_ARGS = ["--app", "desktop"]

# Path INSIDE the app bundle, relative to the install root. `app.asar.unpacked`
# is where Electron keeps files that must exist on disk as real files rather
# than inside the asar archive — an executable has to be one of those.
_MACOS_INNER = Path("Contents/Resources/app.asar.unpacked/out")
_LINUX_INNER = Path("resources/app.asar.unpacked/out")


def binary_name() -> str | None:
    """Return the server filename for this platform, or None if unsupported."""
    machine = platform.machine().lower()
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64"
    system = platform.system()
    if system == "Darwin":
        return f"mcp-server-darwin-{arch}"
    if system == "Linux":
        return f"mcp-server-linux-{arch}"
    if system == "Windows":
        return f"mcp-server-win32-{arch}.exe"
    return None


def candidate_paths(name: str) -> list[Path]:
    """Known install locations for the Pen app, most likely first.

    The app is called "Pen" on disk while the product is "Pencil"; both names
    are checked because installers have used each.
    """
    home = Path.home()
    system = platform.system()
    roots: list[Path] = []
    if system == "Darwin":
        for app in ("Pen.app", "Pencil.app"):
            roots += [Path("/Applications") / app / _MACOS_INNER,
                      home / "Applications" / app / _MACOS_INNER]
    elif system == "Linux":
        roots += [Path("/opt/Pen") / _LINUX_INNER,
                  Path("/opt/Pencil") / _LINUX_INNER,
                  Path("/usr/lib/pen") / _LINUX_INNER,
                  home / ".local/share/Pen" / _LINUX_INNER]
    elif system == "Windows":
        for base in filter(None, (os.environ.get("LOCALAPPDATA"),
                                  os.environ.get("PROGRAMFILES"))):
            for app in ("Pen", "Pencil"):
                roots.append(Path(base) / app / "resources/app.asar.unpacked/out")
    return [r / name for r in roots]


def fail(message: str) -> None:
    """Exit non-zero with an explanation on stderr.

    stderr, never stdout: stdout is the MCP stdio channel and anything written
    there would be parsed as a protocol message.
    """
    print(f"pencil-mcp: {message}", file=sys.stderr)
    sys.exit(1)


def resolve() -> Path:
    override = os.environ.get("PENCIL_MCP_BIN")
    if override:
        path = Path(override).expanduser()
        if not path.is_file():
            fail(f"PENCIL_MCP_BIN is set to {path}, which is not a file.")
        return path

    name = binary_name()
    if name is None:
        fail(f"unsupported platform {platform.system()}. "
             "Set PENCIL_MCP_BIN in .env to the server binary's absolute path.")

    candidates = candidate_paths(name)
    for path in candidates:
        if path.is_file():
            return path

    searched = "\n  ".join(str(p) for p in candidates)
    fail("could not find the Pencil MCP server binary.\n"
         "  Install the Pen desktop app from https://pencil.dev, or set\n"
         "  PENCIL_MCP_BIN in .env to its absolute path.\n"
         f"  Searched:\n  {searched}")


def main() -> None:
    binary = resolve()
    if not os.access(binary, os.X_OK):
        fail(f"{binary} is not executable.")
    args = [str(binary), *DESKTOP_ARGS, *sys.argv[1:]]
    # exec rather than subprocess: the MCP client speaks to this process over
    # stdio, and replacing the image hands it the server's own stdin/stdout
    # directly. A wrapper relaying pipes would add a failure mode for no gain.
    os.execv(str(binary), args)


if __name__ == "__main__":
    main()
