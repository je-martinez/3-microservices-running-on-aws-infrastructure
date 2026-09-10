// Parses the committed OpenObserve dashboards into (stream, field) references, so a
// spec can assert every field a panel queries still exists in the stream's schema.
// Each panel's `queries[]` entry holds the literal query in `query`, the stream in
// `fields.stream`, and its type in `fields.stream_type`; `panel.queryType` decides
// whether `query` parses as SQL or PromQL.
//
// CONTRACT: Parse the SQL text — do NOT read field names from `fields.x[]`/`y[]`/
// `z[]`/`breakdown[]`. Those carry the query's OWN output aliases (`x_axis_1`,
// `total`), so asserting on them demands `x_axis_1` exist in the `logs` schema, which
// it never will. See [[logging-context]]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { StreamType } from "./openobserve-client.js";

const dashboardsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "observability",
  "dashboards",
);

export type PanelQuery = {
  /** Dashboard file name, e.g. "orders.dashboard.json" — named in every failure message. */
  dashboard: string;
  /** Panel id, e.g. "orders_top_routes". */
  panelId: string;
  /** Human title, so a failure reads like the UI the person is looking at. */
  panelTitle: string;
  stream: string;
  streamType: StreamType;
  queryType: string;
  query: string;
  /** Field names the query references, already de-aliased and de-keyworded. */
  fields: string[];
};

type RawDashboard = {
  title?: string;
  tabs?: Array<{
    panels?: Array<{
      id?: string;
      title?: string;
      queryType?: string;
      queries?: Array<{
        query?: string;
        fields?: { stream?: string; stream_type?: string };
      }>;
    }>;
  }>;
};

// SQL keywords and the aggregate/scalar functions these dashboards use. Anything
// left after removing these (and the query's own aliases) is a column reference.
// Kept as a literal set rather than a real SQL parser: the dashboard queries are
// simple, hand-written and few, and a full parser would be far more code than
// the thing it guards.
const SQL_RESERVED = new Set([
  "select", "from", "where", "group", "by", "order", "having", "limit", "offset",
  "as", "and", "or", "not", "is", "null", "in", "on", "join", "inner", "left",
  "right", "outer", "full", "union", "all", "distinct", "asc", "desc", "case",
  "when", "then", "else", "end", "like", "ilike", "between", "cast", "true", "false",
  // functions in use across the six dashboards
  "count", "sum", "max", "min", "avg", "coalesce", "histogram",
  "approx_percentile_cont", "date_trunc", "to_timestamp",
]);

/**
 * Extracts the column references from one SQL query.
 *
 * CONTRACT: Keep these steps in order — each removes a real false positive. Blank the
 * string literals (`service_name = 'orders'` must not yield `orders`), then the FROM
 * target (a stream is not one of its own columns), then collect `AS <alias>` names
 * (outputs, not inputs); whatever identifier remains unreserved is a field. Numeric
 * literals never survive: the pattern needs a leading letter or underscore, which is
 * also what keeps `_timestamp`. See [[logging-context]]
 */
export function extractSqlFields(sql: string): string[] {
  const withoutLiterals = sql.replace(/'[^']*'/g, "''");
  const withoutFrom = withoutLiterals.replace(/\bFROM\s+"?[A-Za-z_][A-Za-z0-9_]*"?/gi, "FROM");

  const aliases = new Set(
    [...withoutFrom.matchAll(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map((m) => m[1].toLowerCase()),
  );

  const identifiers = withoutFrom.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? [];
  const fields = new Set<string>();
  for (const raw of identifiers) {
    const id = raw.toLowerCase();
    if (SQL_RESERVED.has(id) || aliases.has(id)) continue;
    fields.add(id);
  }
  return [...fields].sort();
}

/**
 * Extracts the label references from a PromQL expression. A panel names the metric plus
 * label matchers (`{status!=""}`, `by (statusclass)`); the metric maps to the STREAM,
 * not a field, so only the labels are returned — and those do appear in the metrics
 * stream's schema.
 */
export function extractPromqlFields(promql: string): string[] {
  const fields = new Set<string>();

  // Label matchers inside braces: {status!="", service="tracking"}
  for (const matcher of promql.matchAll(/\{([^}]*)\}/g)) {
    for (const label of matcher[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*(?:=~|!~|!=|=)/g)) {
      fields.add(label[1].toLowerCase());
    }
  }

  // Grouping clauses: `by (status)` / `without (le)`
  for (const group of promql.matchAll(/\b(?:by|without)\s*\(([^)]*)\)/gi)) {
    for (const label of group[1].split(",")) {
      const name = label.trim();
      if (name) fields.add(name.toLowerCase());
    }
  }

  return [...fields].sort();
}

/** Reads every `*.dashboard.json` and flattens it to one entry per panel query. */
export function loadDashboardQueries(): PanelQuery[] {
  const files = fs
    .readdirSync(dashboardsDir)
    .filter((f) => f.endsWith(".dashboard.json"))
    .sort();

  const out: PanelQuery[] = [];
  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dashboardsDir, file), "utf8")) as RawDashboard;
    for (const tab of raw.tabs ?? []) {
      for (const panel of tab.panels ?? []) {
        for (const query of panel.queries ?? []) {
          const sql = query.query;
          const stream = query.fields?.stream;
          const streamType = query.fields?.stream_type;
          if (!sql || !stream || !streamType) continue;

          const queryType = panel.queryType ?? "sql";
          out.push({
            dashboard: file,
            panelId: panel.id ?? "(no id)",
            panelTitle: panel.title ?? "(untitled)",
            stream,
            streamType: streamType as StreamType,
            queryType,
            query: sql,
            fields: queryType === "promql" ? extractPromqlFields(sql) : extractSqlFields(sql),
          });
        }
      }
    }
  }
  return out;
}

export { dashboardsDir };
