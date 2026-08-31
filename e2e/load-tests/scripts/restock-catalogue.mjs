#!/usr/bin/env node
// Restores the Orders catalogue to its seeded stock BEFORE a Gatling run.
//
// ## Why the load suite needs this MORE than the Playwright suite does
//
// Load simulations deliberately send neither `x-e2e-source` nor `x-test-mode` (see
// e2e/CLAUDE.md §4), so their data persists like real traffic. That has a
// consequence which is easy to miss: nothing tags their orders, so nothing ever
// cleans them up — and every order they place decrements product stock permanently.
// The Playwright suite at least restocks in its teardown; a load run has no
// teardown at all and simply drains the catalogue, run after run, until order
// creation starts failing for want of stock and the run measures error handling
// instead of the flow it was written to measure.
//
// Restocking at SETUP fixes both that and the Playwright case (a suite killed by
// Ctrl-C or a timeout never reaches its teardown): the invariant becomes "the
// catalogue is full when a run starts" rather than "the catalogue was left full by
// whoever ran last".
//
// ## Why a pre-run script and not a step inside the simulation
//
// Two reasons, both structural rather than stylistic:
//   1. A simulation runs in GraalVM, not Node — `process` does not exist there, and
//      config comes from `getEnvironmentVariable`. More importantly, anything placed
//      in a scenario executes PER VIRTUAL USER, so a restock would fire hundreds of
//      times mid-run, repeatedly refilling stock while the run is trying to observe
//      what sustained traffic does to it. A `before`-style hook that runs exactly
//      once is not part of the JS SDK's surface.
//   2. The restock must not appear in the report. It is setup, not traffic; a row
//      for it would sit in the same percentile tables as the endpoints under test.
//
// So it runs here, in ordinary Node, before the CLI is invoked — wired into the
// `pnpm` scripts so every simulation gets it, and therefore into the Makefile
// targets that call them.
//
// JS rather than the repo's Python-first default because this task already lives in
// the Node ecosystem: it is a pnpm script inside the load-tests package, in the same
// spirit as scripts/*.mjs. See docs/shared/conventions/scripting-language.md.

const ordersBaseUrl = process.env.ORDERS_BASE_URL ?? "http://localhost:3001";
const url = `${ordersBaseUrl}/v1/orders/e2e-cleanup`;

// The internal key when available. This route does NOT require it today —
// `PublicRoutes.IsPublic` exempts the path from the x-user-id guard and the handler
// checks no key (the key-protected neighbour is DELETE /v1/orders/by-user). Sent
// anyway so this caller stays correct if the route is ever hardened; its absence is
// explicitly not an error.
const headers = {};
if (process.env.GRPC_API_KEY) headers["x-api-key"] = process.env.GRPC_API_KEY;

// Fails the whole command on any problem, so `pnpm run load` stops rather than
// generating traffic against a catalogue it could not verify. A setup step that
// quietly skips is the silent-skip failure mode this repo has been bitten by
// repeatedly (see the TRACKING_DATABASE_URL trap in services/tracking-go/CLAUDE.md
// §6 — eleven tests skipped silently while the package reported ok).
function fail(message) {
  console.error(`[restock] ${message}`);
  process.exit(1);
}

let res;
try {
  res = await fetch(url, { method: "DELETE", headers });
} catch (err) {
  fail(
    `Could not reach the Orders E2E cleanup route at ${url} — ${err.message}. ` +
      "This step restores catalogue stock to the seed quantities before the simulation " +
      "runs; load tests never clean up after themselves, so without it the catalogue " +
      "drains run after run until order creation fails for lack of stock and the run " +
      "measures error handling instead of the flow. Is the stack up (`make bootstrap`)?",
  );
}

// 404/405 mean the route is not mounted, i.e. E2E_TESTING_ENABLED is off for Orders.
// A configuration state rather than a transient fault, so it is named rather than
// retried past.
if (res.status === 404 || res.status === 405) {
  fail(
    `The Orders E2E cleanup route is not mounted at ${url} (${res.status}). It is only ` +
      "mapped when E2E_TESTING_ENABLED is set for the Orders service. Enable it in " +
      ".env.local.orders and restart Orders (`docker compose up -d --force-recreate orders`).",
  );
}

if (!res.ok) {
  fail(
    `The Orders E2E cleanup route at ${url} answered ${res.status}: ${await res.text()}. ` +
      "Catalogue stock was NOT restored, so order creation in this run may fail for lack " +
      "of stock rather than under genuine contention.",
  );
}

const body = await res.json();

// Reported, never asserted. `restocked: 0` is the healthy steady state (every product
// already at its seeded quantity); a non-zero count says the previous run left the
// catalogue drained and this step repaired it — one line of output instead of an
// invisible condition.
console.log(
  `[restock] orders: deleted ${body.deleted} order(s), ${body.deletedDetails} detail row(s), ` +
    `restocked ${body.restocked} product(s)` +
    (body.restocked === 0
      ? " — catalogue was already at seed quantities."
      : " — the previous run left the catalogue drained; it has been restored."),
);
