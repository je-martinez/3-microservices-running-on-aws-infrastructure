#!/usr/bin/env node
// Idempotently import/update the OpenObserve dashboards under
// observability/dashboards/*.dashboard.json.
//
// OpenObserve v0.91.1 (see observability/dashboards/README.md): dashboardId is
// server-assigned on create, so idempotency keys on `title` — we list existing
// dashboards, match by title, and PUT (with the current ?hash=) to update or
// POST to create. Logs-only per ADR-0018; the panels are derived from the logs
// stream. Local dev creds fall back to the runbook value.
//
// Node built-ins only (fs, path, fetch) — no dependencies. Run via
// `make observability-dashboards` (which runs `nvm use` first).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AUTH = process.env.O2_BASIC_AUTH ?? "YWRtaW5AM21yYWkubG9jYWw6Q29tcGxleHBhc3MjMTIz";
const BASE = process.env.O2_URL ?? "http://localhost:5080";
const ORG = process.env.O2_ORG ?? "default";

const here = dirname(fileURLToPath(import.meta.url));
const dashboardsDir = resolve(here, "..", "observability", "dashboards");
const endpoint = `${BASE}/api/${ORG}/dashboards`;
const headers = { Authorization: `Basic ${AUTH}`, "Content-Type": "application/json" };

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(1);
}

// The list response wraps each dashboard in a v1..v8 envelope; the active object
// lives in the slot named by the top-level `version`, and the id/hash are
// surfaced alongside. Return [{ title, id, hash }].
async function listExisting() {
  const res = await fetch(endpoint, { headers });
  if (!res.ok) fail(`list dashboards failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  return (body.dashboards ?? []).map((entry) => {
    const inner = entry[`v${entry.version}`] ?? {};
    return {
      title: inner.title ?? entry.title,
      id: entry.dashboard_id ?? inner.dashboardId,
      hash: entry.hash,
    };
  });
}

async function createDashboard(doc) {
  const res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(doc) });
  if (!res.ok) fail(`create "${doc.title}" failed: HTTP ${res.status} ${await res.text()}`);
}

async function updateDashboard(doc, existing) {
  const url = `${endpoint}/${existing.id}?hash=${encodeURIComponent(existing.hash)}`;
  const res = await fetch(url, { method: "PUT", headers, body: JSON.stringify(doc) });
  if (!res.ok) fail(`update "${doc.title}" failed: HTTP ${res.status} ${await res.text()}`);
}

async function main() {
  const files = readdirSync(dashboardsDir)
    .filter((f) => f.endsWith(".dashboard.json"))
    .sort();
  if (files.length === 0) fail(`no *.dashboard.json files in ${dashboardsDir}`);

  const existing = await listExisting();
  const byTitle = new Map(existing.map((e) => [e.title, e]));

  for (const file of files) {
    const doc = JSON.parse(readFileSync(join(dashboardsDir, file), "utf8"));
    const match = byTitle.get(doc.title);
    if (match) {
      await updateDashboard(doc, match);
      console.log(`updated  ${doc.title}  (${file})`);
    } else {
      await createDashboard(doc);
      console.log(`created  ${doc.title}  (${file})`);
    }
  }
  console.log(`\ndone — ${files.length} dashboard(s) imported to ${BASE}/api/${ORG}`);
}

await main();
