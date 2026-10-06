---
title: MCP servers for local dev (pencil)
type: runbook
area: infra
status: active
created: 2026-07-10
updated: 2026-10-06
integration-status: n/a
verified-on: null
verified-by: null
tags: [type/runbook, area/infra, status/active]
related:
  - local-dev-floci
  - local-dev
  - git-workflow
  - package-manager
---

# MCP servers for local dev (pencil)

## When to run this

Consult this runbook when setting up the project's MCP servers, when one of them fails to
connect, or when adding a new server that needs a secret. It documents why a server that
needs configuration loads the repo's env file itself instead of relying on `${VAR}`
substitution.

See [[local-dev-floci]] and [[local-dev]] for the rest of the local-dev stack this
tooling sits alongside.

## Context

MCP servers for this repo are declared in `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "pencil": {
      "command": "sh",
      "args": [
        "-c",
        "set -a && [ -f .env ] && . ./.env; set +a; exec python3 scripts/pencil_mcp.py"
      ]
    }
  }
}
```

- **`pencil`** — a stdio server behind `scripts/pencil_mcp.py`, which resolves the Pen
  desktop binary per platform. Its optional `PENCIL_MCP_BIN` override lives in an env
  file (gitignored), never exported in a developer's shell profile.

The same set is projected to the other AI providers — `.cursor/mcp.json`,
`.vscode/mcp.json`, `.gemini/settings.json`, `.codex/config.toml`, `.ai/settings.json`
and `opencode.json` — from `.ai/.lnai-projection.yml`. Adding or removing a server means
updating every one of them, or `make ai-sync-check` drifts silently.

## Why a server sources its env file itself

### The failure mode

A server entry that uses `${VAR:-}` placeholders in `.mcp.json` gets those substitutions
resolved against Claude Code's **own process environment** — not against the repo's env
file. When the vars are not exported in the shell that launched Claude Code, the server
starts with an **empty** value and fails to initialize with error `-32000` ("Failed to
reconnect to <server>"). Running `/mcp` shows the server as failing.

### The pattern that works

Launch via a `sh -c` wrapper that sources the env file itself before exec'ing the server:

```bash
set -a && [ -f .env ] && . ./.env; set +a; exec <server command>
```

| Part | Purpose |
|---|---|
| `set -a` | Auto-export everything defined next, so the child process inherits the values via the environment. |
| `[ -f .env ] && . ./.env` | Source the env file **only if it exists** — doesn't break in an environment without one, e.g. CI. |
| `set +a` | Stop auto-exporting. |
| `exec …` | Replace the shell with the server process so stdin/stdout (the MCP stdio transport) are wired directly, with no lingering `sh` parent. |

> [!info] Why this design
> It makes secret resolution **self-contained in the repo**: any developer with a
> populated env file gets a working server without remembering to `source` it before
> launching Claude Code, and without exporting the values globally in their shell
> profile. The env file stays the single source for these values.

> [!warning] Portability trade-off
> The wrapper uses POSIX `sh` (`set -a`, `.`), so it works on macOS/Linux but not
> native Windows (no `sh`). This repo targets Darwin. It also depends on Claude Code
> launching MCP servers with the repo root as the working directory (which it does),
> since the env file is referenced by a relative path.

> [!warning] The root `.env` no longer exists
> A server wrapper still written against `./.env` sources nothing. Each service owns its
> own env file now — see [[env-files]]. A new server needing configuration must point at
> the file that actually holds its value.

## Operational notes

- **Editing `.mcp.json` does not hot-reload servers.** After changing it, reconnect via
  the `/mcp` command (or restart the Claude Code session).
- Because `.mcp.json` is a project-trusted file, Claude Code may prompt to re-approve it
  after edits.

## Verification

- `/mcp` shows every declared server as connected (no `-32000` errors).
- `python3 -c "import json;json.load(open('.mcp.json'))"` parses, and the same check
  passes for each projected provider config.

## Related

- [[local-dev-floci]]
- [[local-dev]]
- [[env-files]]
- [[package-manager]]
- [[git-workflow]]
