# OpenObserve Dashboards (as code)

Version-controlled dashboard definitions for the local OpenObserve backend, plus
the import contract. All panels are derived from the structured `logs` stream
(logs-only per ADR-0018 — no metrics/traces).

The dashboard JSON schema below was **captured empirically** against the pinned
image `openobserve:v0.91.1` (not invented) by round-tripping a probe dashboard
through the API. Its panel query was confirmed to return live data.

## Import contract

Base URL (local): `http://localhost:5080`, org `default`.
Auth: HTTP Basic. Local dev value (base64 of `admin@3mrai.local:Complexpass#123`):

```
Authorization: Basic YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz
```

Endpoints (org `default`):

| Action | Method + path |
|---|---|
| List | `GET /api/default/dashboards` → `{ "dashboards": [ { v8, hash, dashboard_id, ... } ] }` |
| Create | `POST /api/default/dashboards` with the dashboard body (see below) |
| Update | `PUT /api/default/dashboards/{dashboardId}?hash={hash}` with the full body |
| Get one | `GET /api/default/dashboards/{dashboardId}` |
| Delete | `DELETE /api/default/dashboards/{dashboardId}` |

**Idempotency:** `dashboardId` is **server-assigned** on create (the value you
send is ignored). To update in place you must (1) list dashboards, (2) match by
`title`, (3) read its `dashboard_id` and current `hash`, (4) `PUT` with
`?hash={hash}`. Matching on `title` is how the bootstrap script avoids
duplicates. The `hash` is an optimistic-concurrency token — a stale hash is
rejected.

## Response envelope

The API wraps the dashboard in versioned slots `v1`..`v8`; **only the slot named
by the top-level `version` is populated** (currently `v8`). Read/write the
object from/to that slot. List responses also flatten a few fields
(`dashboard_id`, `title`, `folder_id`) alongside the envelope for convenience.

## v8 dashboard body (create/update)

The `POST`/`PUT` body is the inner v8 object:

```json
{
  "version": 8,
  "dashboardId": "",
  "title": "<unique title — used for idempotent match>",
  "description": "",
  "role": "",
  "owner": "admin@3mrai.local",
  "created": "2026-07-16T00:00:00Z",
  "tabs": [
    {
      "tabId": "default",
      "name": "Default",
      "panels": [ /* see panel shape */ ]
    }
  ],
  "variables": { "list": [] }
}
```

Panels live **inside a tab**, not at the dashboard root. There is no root-level
`panels`/`layouts` array in v8 — each panel carries its own `layout`.

## Panel shape (confirmed accepted + renders data)

```json
{
  "id": "panel_1",
  "type": "line",
  "title": "req rate",
  "description": "",
  "config": { "show_legends": true, "decimals": 2 },
  "queryType": "sql",
  "queries": [
    {
      "query": "SELECT histogram(_timestamp) as x_axis_1, count(*) as y_axis_1 FROM logs GROUP BY x_axis_1",
      "customQuery": true,
      "fields": {
        "stream": "logs",
        "stream_type": "logs",
        "x": [],
        "y": [],
        "z": [],
        "filter": { "filterType": "group", "logicalOperator": "AND", "conditions": [] }
      },
      "config": { "promql_legend": "", "layer_type": "scatter", "weight_fixed": 1 }
    }
  ],
  "layout": { "x": 0, "y": 0, "w": 24, "h": 9, "i": 1 }
}
```

Notes for authoring panels (Tasks 9–10):

- **`queries[].fields.filter` is REQUIRED** — omitting it fails deserialization
  with `missing field 'filter'`. Use the empty group above when the SQL already
  carries its own `WHERE`.
- With `customQuery: true` the raw `query` SQL drives the panel. Alias the
  x/time column `x_axis_1` and the value column `y_axis_1` (grid layout uses `w`
  up to 24 columns).
- `type` is the visualization: `line`, `bar`, `table`, `stat` (verify each new
  type by round-tripping it — the server validates on write).
- Grid: `layout.w` max 24; stack panels by incrementing `layout.y` and `i`.

## Verifying a panel's query

Before committing a panel, confirm its SQL returns rows via `_search` (NOT the
lagging stream-stats `doc_num` — see the runbook). Example that returned live
data during schema capture:

```bash
AUTH="YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz"
NOW=$(python3 -c 'import time;print(int(time.time()*1_000_000))')
START=$(python3 -c 'import time;print(int((time.time()-600)*1_000_000))')
curl -s -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
  "http://localhost:5080/api/default/_search?type=logs" \
  -d "{\"query\":{\"sql\":\"SELECT histogram(_timestamp) as x_axis_1, count(*) as y_axis_1 FROM logs GROUP BY x_axis_1\",\"start_time\":$START,\"end_time\":$NOW}}"
```
