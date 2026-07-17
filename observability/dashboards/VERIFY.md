# Verified panel queries

These SQL queries were confirmed live against the OpenObserve `logs` stream
(org `default`) with both `users` and `orders` emitting the snake_case schema.
They are the source queries for the dashboards. Verify via `_search` (NOT the
lagging stream-stats `doc_num` — see the runbook), with `start_time`/`end_time`
in **microseconds**.

## Verified end-to-end (2026-07-16)

Both services land as queryable columns. `duration_ms` and
`http_response_status_code` are real JSON **numbers** (float/int), so percentile
and comparison math works:

| service | count | max status | max duration_ms |
|---|---|---|---|
| users | 29 | 200 | 0.445 (float) |
| orders | 80 | 200 | 57.97 (float) |

`http_route` is the clean route template for both services (e.g. `/v1/health`).

## Per-service panel queries (parameterize `service_name`)

Request rate (timeseries):
```sql
SELECT histogram(_timestamp) AS x_axis_1, COUNT(*) AS y_axis_1
FROM logs
WHERE service_name = '<svc>' AND http_route IS NOT NULL
GROUP BY x_axis_1
```

Errors by status code:
```sql
SELECT http_response_status_code AS x_axis_1, COUNT(*) AS y_axis_1
FROM logs
WHERE service_name = '<svc>' AND http_response_status_code IS NOT NULL
GROUP BY x_axis_1
```

Latency p50 / p95 / p99 (approx_percentile_cont confirmed available):
```sql
SELECT
  approx_percentile_cont(duration_ms, 0.5)  AS p50,
  approx_percentile_cont(duration_ms, 0.95) AS p95,
  approx_percentile_cont(duration_ms, 0.99) AS p99
FROM logs
WHERE service_name = '<svc>' AND duration_ms IS NOT NULL
```

Top routes by volume:
```sql
SELECT http_route AS x_axis_1, COUNT(*) AS y_axis_1
FROM logs
WHERE service_name = '<svc>' AND http_route IS NOT NULL
GROUP BY x_axis_1
ORDER BY y_axis_1 DESC
```

Recent errors (table):
```sql
SELECT _timestamp, http_route, http_response_status_code, error_type, error_message, message
FROM logs
WHERE service_name = '<svc>'
  AND (http_response_status_code >= 400 OR error_type IS NOT NULL)
ORDER BY _timestamp DESC
```

## Global (cross-service) panel queries

Request volume per service:
```sql
SELECT service_name AS x_axis_1, COUNT(*) AS y_axis_1
FROM logs
WHERE http_route IS NOT NULL
GROUP BY x_axis_1
ORDER BY y_axis_1 DESC
```

Error rate / count per service (status >= 400):
```sql
SELECT service_name AS x_axis_1, COUNT(*) AS y_axis_1
FROM logs
WHERE http_response_status_code >= 400
GROUP BY x_axis_1
```

p95 latency per service:
```sql
SELECT service_name AS x_axis_1, approx_percentile_cont(duration_ms, 0.95) AS y_axis_1
FROM logs
WHERE duration_ms IS NOT NULL
GROUP BY x_axis_1
```

Status breakdown per service (last hour):
```sql
SELECT service_name, http_response_status_code, COUNT(*) AS n
FROM logs
WHERE http_response_status_code IS NOT NULL
GROUP BY service_name, http_response_status_code
ORDER BY n DESC
```

## Notes for panel authoring (Tasks 9–10)

- Alias the x/time column `x_axis_1` and the value column `y_axis_1` (matches the
  panel shape captured in `README.md`).
- `queries[].fields.filter` is REQUIRED in the panel JSON even when the SQL
  carries its own `WHERE` — use the empty group from `README.md`.
- Orders emits extra Serilog framework properties (`SourceContext`, `EnvName`) as
  columns — harmless, ignore them in panels.
