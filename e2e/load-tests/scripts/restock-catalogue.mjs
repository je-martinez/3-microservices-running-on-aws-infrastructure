#!/usr/bin/env node
// Restores the Orders catalogue to its seeded stock BEFORE a Gatling run. Load
// simulations send neither `x-e2e-source` nor `x-test-mode`, so nothing tags their
// orders and nothing cleans them up, while every order permanently decrements stock —
// a load run simply drains the catalogue until creation fails for want of it.

// CONTRACT: Keep this a pre-run Node script, NOT a step inside a simulation. A
// simulation runs in GraalVM where `process` does not exist, and anything in a
// scenario executes PER VIRTUAL USER — a restock would fire hundreds of times mid-run,
// refilling stock while the run tries to observe what traffic does to it. It would
// also earn a row in the percentile tables beside the endpoints under test.
// See [[scripting-language]]

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
