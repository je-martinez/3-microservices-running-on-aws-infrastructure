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

// The org does not exist on a freshly created OpenObserve volume: it is created
// by the FIRST INGESTION, not by this script, and its identifier is taken from
// the ingest URL (ZO_CREATE_ORG_THROUGH_INGESTION). So after `make clean`, this
// script used to run before any service had logged anything and die with
// "Organization not found" — leaving every dashboard missing until someone
// noticed and re-ran the import by hand.
//
// Seeding it with one throwaway log line is what creates it, deterministically
// and with the identifier we want. POSTing to /api/organizations would NOT
// work: that endpoint generates a RANDOM identifier and ignores any supplied in
// the body, so the org would come out named something like 3HuXDuClKORq… and
// every consumer of /api/3mrai would still 404.
//
// The record lands in a `_bootstrap` stream rather than `logs`, so it never
// pollutes the stream the dashboards read.
async function seedOrg() {
  const res = await fetch(`${BASE}/api/${ORG}/_bootstrap/_json`, {
    method: "POST",
    headers,
    body: JSON.stringify([
      { level: "info", message: "org bootstrap for dashboard import", source: "import-dashboards" },
    ]),
  });
  if (!res.ok) {
    fail(`could not create org "${ORG}" by seeding a log: HTTP ${res.status} ${await res.text()}`);
  }
}

// The list response wraps each dashboard in a v1..v8 envelope; the active object
// lives in the slot named by the top-level `version`, and the id/hash are
// surfaced alongside. Return [{ title, id, hash }].
async function listExisting({ allowSeed = true } = {}) {
  const res = await fetch(endpoint, { headers });
  // 404 here means the org itself is absent, not that there are no dashboards —
  // an existing org with none returns 200 and an empty list. Seed it once and
  // retry; a second 404 is a real failure and falls through to fail() below.
  if (res.status === 404 && allowSeed) {
    console.log(`org "${ORG}" does not exist yet — seeding it with one log line`);
    await seedOrg();
    return listExisting({ allowSeed: false });
  }
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
