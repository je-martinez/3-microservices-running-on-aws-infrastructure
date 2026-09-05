#!/usr/bin/env python3
"""Locate the Pencil MCP server binary and exec it, so `.mcp.json` is portable.

The binary ships inside the Pen desktop app at a platform-specific absolute path,
so naming one in the committed config works on exactly one machine. This searches
the known install locations and `exec`s the match, leaving the MCP stdio transport
untouched; `PENCIL_MCP_BIN` overrides the search with an absolute path, verbatim.
CONTRACT: Do NOT fall back to the per-editor bridges under `~/.pencil/mcp/`. They
start cleanly, then fail every call with "A file needs to be open in the editor"
while the renderer reports `connectedAgents: []`. Only the bundled binary run
with `--app desktop` reaches the running app. See [[pencil-design-extraction]]
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
