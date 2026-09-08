#!/usr/bin/env node
// Idempotently import/update the OpenObserve dashboards under
// observability/dashboards/*.dashboard.json.
//
// CONTRACT: Key idempotency on `title`, not dashboardId — the server assigns
// the id on create, so a re-import would otherwise duplicate every dashboard.
// Node built-ins only, no dependencies. Run via `make observability-dashboards`.

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

// CONTRACT: Seed the org with a throwaway log line; do NOT POST to
// /api/organizations. The org is created by the first INGESTION and takes its
// identifier from the ingest URL, while that endpoint generates a RANDOM
// identifier and ignores the body — every consumer of /api/3mrai would still
// 404. Without the seed, a run after `make clean` dies with "Organization not
// found". The record lands in a `_bootstrap` stream, not the dashboards' one.
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
