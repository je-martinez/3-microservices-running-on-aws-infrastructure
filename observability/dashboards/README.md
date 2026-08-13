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
        "x": [
          { "label": "", "alias": "x_axis_1", "column": "x_axis_1", "color": null,
            "isDerived": true, "havingConditions": [], "treatAsNonTimestamp": true }
        ],
        "y": [
          { "label": "requests", "alias": "y_axis_1", "column": "y_axis_1", "color": "#4caf50",
            "isDerived": true, "havingConditions": [], "treatAsNonTimestamp": true }
        ],
        "z": [],
        "breakdown": [],
        "filter": { "filterType": "group", "logicalOperator": "AND", "conditions": [] }
      },
      "config": { "promql_legend": "", "layer_type": "scatter", "weight_fixed": 1 }
    }
  ],
  "layout": { "x": 0, "y": 0, "w": 96, "h": 15, "i": 1 }
}
```

> `w: 96` is HALF a row — the grid is **192** columns wide, not 24. See
> [THE GRID IS 192 COLUMNS WIDE](#the-grid-is-192-columns-wide--not-24) below
> before choosing any `w`.

Notes for authoring panels (Tasks 9–10):

- **`queries[].fields.filter` is REQUIRED** — omitting it fails deserialization
  with `missing field 'filter'`. Use the empty group above when the SQL already
  carries its own `WHERE`.
- With `customQuery: true` the raw `query` SQL drives the panel. Alias the
  x/time column `x_axis_1` and the value column `y_axis_1`.
- `type` is the visualization: `line`, `bar`, `table`, `stat` (verify each new
  type by round-tripping it — the server validates on write).

## THE GRID IS 192 COLUMNS WIDE — not 24

> [!warning] This section corrects a wrong claim that cost a full debugging session
> This file previously stated "`layout.w` max 24". **That is false**, and every
> dashboard in this repo was authored against it. A panel declaring `w: 12` was
> asking for **6%** of the row, and a supposedly full-width `w: 24` asked for
> **12.5%** — which is why panels rendered ~73px and ~153px wide with the rest of
> the viewport empty, and why they looked "too small" no matter what `h` was set
> to.
>
> The real width was established empirically: dragging panels to fill the row in
> the OpenObserve UI and reading the layout back produced spans of `0-70`,
> `70-141`, `141-192` — covering exactly **192**.

**Rules:**

| Panels per row | `w` each | Notes |
|---|---|---|
| 1 | `192` | tables, wide time series |
| 2 | `96` | the default for log dashboards |
| 3 | `64` | 192/3 exactly — no remainder |
| 4 | `48` | only for very simple counters |

- `x` is the column offset: the *n*-th panel in a row starts at `n * w`.
- A row's panels must sum to exactly 192, or the row leaves dead space.
- `h` is in units of **24px** (`rowHeight: 24` in the bundle), so `h: 15` ≈ 360px.
  Increment `y` by the row's `h` for each new row.
- **Verify after importing** by reading the layout back and checking that the
  rightmost edge is 192:
  ```bash
  # every dashboard should print rightmost_edge=192
  curl -s -H "Authorization: Basic $AUTH" \
    "http://localhost:5080/api/default/dashboards" \
  | python3 -c "
  import sys,json
  for x in json.load(sys.stdin).get('dashboards',[]):
      i=x.get('v8') or {}
      ps=i.get('tabs',[{}])[0].get('panels',[])
      if ps: print(i['title'], max(p['layout']['x']+p['layout']['w'] for p in ps))
  "
  ```

## Metrics panels MUST use PromQL, not SQL

A metric stream queried with `queryType: "sql"` renders **"Error Loading Data"**
and **never issues a search request at all** — the access log shows the dashboard
being fetched and then nothing. The UI dispatches on `queryType`
(`usePanelDataLoader.ts` branches on `queryType == "promql"`) and reaches metric
streams through `prometheus/api/v1/query_range`; the SQL path is built for log
streams.

The confusing part: **the SQL is not wrong**. It returns correct rows through the
`_search?type=metrics` API, which is the right way to verify the ingest
pipeline — but it is not the path the dashboard UI uses. Verifying via `_search`
proves the data is there; it does **not** prove the panel will render.

```json
{
  "queryType": "promql",
  "queries": [{
    "query": "max by (dimensions_status) (amazonaws_com_3mrai_orders_by_tracking_status_total)",
    "customQuery": true,
    "fields": { "stream": "amazonaws_com_3mrai_orders_by_tracking_status_total",
                "stream_type": "metrics", "x": [], "y": [], "z": [],
                "filter": { "filterType": "group", "logicalOperator": "AND", "conditions": [] } },
    "config": { "promql_legend": "{dimensions_status}", "layer_type": "scatter", "weight_fixed": 1 }
  }]
}
```

- **Aggregation goes in the PromQL**, not in SQL clauses: `max by (label) (metric)`
  for gauges, `sum by (label) (metric)` for counters. **Summing a gauge adds every
  sample in the window and reports a multiple of the real count.**
- **Legends** come from `config.promql_legend` with `{label}` templating, not from
  a SQL breakdown column. Turn `show_legends` on only where a panel plots more
  than one series. Avoid `legends_position` — the working dashboards do not set
  it, and the legend renders inside the plot area (`legend:{right:0}`).
- **Stream and dimension names are transformed on ingest**: CloudWatch's
  `Service` dimension is queried as `dimensions_service` (prefixed, lowercased),
  and metric `amazonaws.com/3MRAI/orders_total` becomes stream
  `amazonaws_com_3mrai_orders_total`. Guessing either name yields an empty panel
  with no error.

## `fields.x` / `fields.y` are REQUIRED — `customQuery: true` does not exempt them

> [!warning] The single most misleading failure in this whole file
> A chart panel with `"x": [], "y": []` renders **"Error Loading Data"** with the
> detail **"Please select required fields to render the chart"** — even though
> the SQL is correct, the API returns HTTP 200, and the rows are right there. The
> UI validates the panel's *declared* axes before it ever looks at the result.
>
> `customQuery: true` means "use my SQL instead of building one from the fields".
> It does **not** mean "infer the axes from the SQL". Both are required.

Every `line`/`bar` panel must declare one x field and one y field per series,
matching the SELECT aliases in order. The shape below is taken from the template
embedded in OpenObserve's own JS bundle:

```json
"fields": {
  "stream": "logs",
  "stream_type": "logs",
  "x": [
    { "label": "", "alias": "x_axis_1", "column": "x_axis_1",
      "color": null, "isDerived": true, "havingConditions": [],
      "treatAsNonTimestamp": true }
  ],
  "y": [
    { "label": "p50", "alias": "y_axis_1", "column": "y_axis_1",
      "color": "#4caf50", "isDerived": true, "havingConditions": [],
      "treatAsNonTimestamp": true }
  ],
  "z": [], "breakdown": [],
  "filter": { "filterType": "group", "logicalOperator": "AND", "conditions": [] }
}
```

- **`alias` and `column` must equal the SQL's output column name.** With
  `isDerived: true` that name can be anything the query produces — `y_axis_1`,
  `p50`, whatever — as long as the three agree.
- **`label` is what the legend and axis show — never leave it as the alias.**
  Copying the SQL alias into `label` puts a literal **`y_axis_1`** in the legend.
  Name what the series measures (`requests`, `p95`, `errors`), and label the x
  field with its dimension (`time`, `route`, `status code`).
- **Turn `show_legends` off on single-series panels.** One line needs no legend —
  the panel title already names it, and the legend only steals plot width. Turn
  it on where two or more series share a chart.
- **`table` panels take `x: []`, `y: []`** — they render raw columns and declare
  no axes.
- **PromQL panels take no x/y descriptors either** — their series come from the
  metric's labels, and the UI does not run this validation on them.

## "Error Loading Data" ≠ "No Data"

These two messages mean different things, and conflating them sends you looking
in the wrong place:

| Panel shows | Meaning | Where to look |
|---|---|---|
| **No Data** | the query ran and returned zero rows | the data — see the section below |
| **Error Loading Data** | the query failed, OR the result could not be charted | the panel definition |

The usual cause of **Error Loading Data on a query that works** is the section
above: the panel declares no axes. The SQL column names themselves are free —
`isDerived: true` lets a field point at any alias the query produces — so
`AS p50` is fine as long as a `y` field declares `alias: "p50"`.

The repo's panels use `x_axis_1` / `y_axis_N` purely as a convention, not because
the UI requires those names.

Check a panel's shape rather than only its row count:

```bash
# every line/bar panel must return at least one y_axis_N column
curl -s -X POST -H "Authorization: Basic $AUTH" -H "Content-Type: application/json" \
  "http://localhost:5080/api/default/_search?type=logs" \
  -d "{\"query\":{\"sql\":\"<panel sql>\",\"start_time\":$START,\"end_time\":$NOW,\"size\":5}}" \
| python3 -c "import sys,json;h=json.load(sys.stdin)['hits'];print(sorted(h[0].keys()) if h else 'no rows')"
```

## An empty panel usually means no traffic, not a broken dashboard

Before editing a panel that shows nothing, check whether the data exists at all.
Three real causes seen in this repo, none of which were dashboard bugs:

1. **No HTTP traffic against that service.** Every log panel filters
   `http_route IS NOT NULL`, which only matches real inbound requests. A service
   sitting idle still logs plenty — OTel exporter chatter, EF Core `SELECT
   COUNT(*)` from the metrics gauge — but none of it carries `http_route`. Hit
   the service a few times and re-check.
2. **The service started before the collector.** Services log through Docker's
   fluentd driver with `fluentd-async: true`, which means a service that boots
   while the collector is down **silently discards** its logs rather than
   failing. `make observability-up` before generating traffic.
3. **The time range predates the data.** The dashboards set no default range, so
   the UI's own picker decides. A stack rebuilt minutes ago has nothing older
   than the rebuild.

Diagnose with one query rather than guessing:

```sql
SELECT service_name, COUNT(*) AS total, COUNT(http_route) AS with_route
FROM logs GROUP BY service_name
```

`total > 0` with `with_route = 0` is case 1.

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
