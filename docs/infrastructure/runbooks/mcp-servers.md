---
title: MCP servers for local dev (Apidog, drawio)
type: runbook
area: infra
status: active
created: 2026-07-10
updated: 2026-07-10
integration-status: n/a
verified-on: null
verified-by: null
tags: [type/runbook, area/infra, status/active]
related:
  - local-dev-ministack
  - local-dev
  - git-workflow
---

# MCP servers for local dev (Apidog, drawio)

## When to run this

Consult this runbook when setting up Claude Code MCP servers for this repo, when the
`apidog` MCP server fails to connect, or when mapping the Users API (or another
service's API) into Apidog. It documents why the `apidog` server loads the repo `.env`
itself instead of relying on `${VAR}` substitution, and how to use the integration day
to day.

See [[local-dev-ministack]] and [[local-dev]] for the rest of the local-dev stack this
tooling sits alongside.

## Context

MCP servers for this repo are declared in `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "drawio": {
      "command": "npx",
      "args": ["-y", "@drawio/mcp"]
    },
    "apidog": {
      "command": "sh",
      "args": [
        "-c",
        "set -a && [ -f .env ] && . ./.env; set +a; exec npx -y apidog-mcp-server@latest --project-id=\"$APIDOG_PROJECT_ID\""
      ]
    }
  }
}
```

- **`drawio`** — `npx -y @drawio/mcp`, no secrets required.
- **`apidog`** — needs two secrets, `APIDOG_PROJECT_ID` and `APIDOG_ACCESS_TOKEN`. These
  live **only in the repo `.env`** (gitignored), never exported in a developer's shell
  profile.

## Why `apidog` sources `.env` itself

### The bug we hit

The `apidog` entry originally used `${APIDOG_PROJECT_ID:-}` / `${APIDOG_ACCESS_TOKEN:-}`
placeholders in `.mcp.json`. Claude Code resolves `${VAR}` substitutions against **its
own process environment** — not against the repo `.env`. Since the vars were not
exported in the shell that launched Claude Code, the server started with an **empty**
project-id and token and failed to initialize with error `-32000` ("Failed to reconnect
to apidog"). Running `/mcp` showed the server as failing.

### The fix

The `apidog` entry now launches via a `sh -c` wrapper that sources `.env` itself before
exec'ing the server:

```bash
set -a && [ -f .env ] && . ./.env; set +a; exec npx -y apidog-mcp-server@latest --project-id="$APIDOG_PROJECT_ID"
```

| Part | Purpose |
|---|---|
| `set -a` | Auto-export everything defined next, so the child `npx` process inherits `APIDOG_ACCESS_TOKEN` via the environment (the server reads the token from the env; project-id comes from the `--project-id` flag). |
| `[ -f .env ] && . ./.env` | Source the repo `.env` **only if it exists** — doesn't break in an environment without one, e.g. CI. |
| `set +a` | Stop auto-exporting. |
| `exec npx …` | Replace the shell with the server process so stdin/stdout (the MCP stdio transport) are wired directly, with no lingering `sh` parent. |

`--project-id` is resolved from `.env` inside the shell; the token travels via the
environment — that's why there is no separate `env` block in the `.mcp.json` entry.

> [!info] Why this design
> It makes secret resolution **self-contained in the repo**: any developer with a
> populated `.env` gets a working `apidog` MCP server without remembering to `source
> .env` before launching Claude Code, and without exporting Apidog secrets globally in
> their shell profile. The `.env` stays the single source for these secrets.

> [!warning] Portability trade-off
> The wrapper uses POSIX `sh` (`set -a`, `.`), so it works on macOS/Linux but not
> native Windows (no `sh`). This repo targets Darwin. It also depends on Claude Code
> launching MCP servers with the repo root as the working directory (which it does),
> since `.env` is referenced by the relative path `./.env`.

## Operational notes

- **Editing `.mcp.json` does not hot-reload servers.** After changing it, reconnect via
  the `/mcp` command (or restart the Claude Code session).
- Because `.mcp.json` is a project-trusted file, Claude Code may prompt to re-approve it
  after edits.

## Using the Apidog MCP integration

The Apidog MCP server is **read-only**. It exposes 3 tools over the project's OpenAPI
spec (tool names are suffixed with a per-session id):

- `read_project_oas*` — read the OpenAPI spec.
- `read_project_oas_ref_resources*` — resolve `$ref`s.
- `refresh_project_oas*` — re-download the latest spec from Apidog's server.

There is **no** tool to create or write endpoints or environments — those are authored
in Apidog's UI, or by **importing an OpenAPI spec** (Import Data → OpenAPI).

### Mapping the Users API into Apidog

A hand-maintained OpenAPI spec lives at `services/users/openapi.yaml` (7 paths / 8
operations, including the E2E-only routes, plus a `servers:` entry
`http://localhost:3000` for the local Floci/docker-compose environment).

To map the endpoints and a local environment in Apidog:

1. In Apidog, **Import Data → OpenAPI** and point it at `services/users/openapi.yaml`.
2. Back in Claude Code, run the `refresh_project_oas*` tool so the read-only tools serve
   the newly imported spec.

Repeat the same pattern for other services once they gain a hand-maintained
`openapi.yaml`.

## Verification

- `/mcp` shows both `drawio` and `apidog` as connected (no `-32000` error for `apidog`).
- `read_project_oas*` returns the Users API spec content (not empty).
- After editing `services/users/openapi.yaml` and re-importing in Apidog,
  `refresh_project_oas*` followed by `read_project_oas*` reflects the updated spec.

## Related

- [[local-dev-ministack]]
- [[local-dev]]
- [[git-workflow]]
