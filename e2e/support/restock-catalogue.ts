// Restores the Orders catalogue to its seeded stock BEFORE a run, by calling the
// same flag-guarded route the global teardown calls afterwards.
//
// ## Why a SETUP step exists when teardown already restocks
//
// `DELETE /v1/orders/e2e-cleanup` soft-deletes the tagged orders and resets every
// product to `ProductSeed.SeedStock`. That already fixed the original failure: a
// soft-delete does not give back the stock an order consumed, so the catalogue
// drained a little every run until all three products hit 0 and the suite began
// failing with "no product with stock in the catalogue" — including specs about
// ownership and carrier auth whose fixtures merely need to place an order first.
//
// The hole it leaves is the EXIT PATH. Teardown only runs when a run finishes
// cleanly; a suite killed by Ctrl-C, a timeout, or an early hard failure never
// reaches it, and the NEXT run then starts against a drained catalogue and fails
// in specs that have nothing to do with stock. Restocking at setup makes the
// previous run's exit path irrelevant — the invariant becomes "the catalogue is
// full when a run starts" rather than "the catalogue was left full by whoever ran
// last".
//
// It is idempotent and therefore cheap to run unconditionally: the endpoint's
// restock predicate is `WHERE UnitsInStock < seedUnits`, so on an already-full
// catalogue it matches no rows and reports `restocked: 0`.

/** The shape `DELETE /v1/orders/e2e-cleanup` answers with. */
export type OrdersCleanupResult = {
  deleted: number;
  deletedDetails: number;
  restocked: number;
};

export const ordersCleanupUrl = (): string =>
  `${process.env.ORDERS_BASE_URL ?? "http://localhost:3001"}/v1/orders/e2e-cleanup`;

/**
 * Calls the Orders E2E cleanup route to restore seed stock.
 *
 * ## This THROWS rather than warning — deliberately, and unlike the teardown
 *
 * The teardown swallows its failures because by then the run's verdict is already
 * decided and leftover local rows are untidy rather than harmful. Setup is the
 * opposite: everything after it depends on the catalogue having stock, so a
 * cleanup that did not happen turns into confusing 409/"no product with stock"
 * failures several specs later, attributed to the wrong code.
 *
 * A setup step that quietly skips is the failure mode this repo has been bitten by
 * repeatedly — see the TRACKING_DATABASE_URL trap in services/tracking-go/CLAUDE.md
 * §6, where eleven tests skipped silently while the package reported ok. So an
 * unreachable service, a 404/405 (E2E_TESTING_ENABLED off), or any non-2xx all
 * fail loudly and name both what was attempted and why it matters.
 */
export async function restockCatalogue(): Promise<OrdersCleanupResult> {
  const url = ordersCleanupUrl();

  // The internal key when it is available. This route does NOT require it today —
  // `PublicRoutes.IsPublic` exempts the path from the x-user-id guard and the
  // handler checks no key (the key-protected neighbour is DELETE /v1/orders/by-user,
  // the account-deletion cascade). Sent anyway because it is ignored when unused
  // and keeps this caller correct if the route is ever hardened; its ABSENCE is
  // explicitly not an error, so an internal-only run without the var still works.
  const headers: Record<string, string> = {};
  if (process.env.GRPC_API_KEY) headers["x-api-key"] = process.env.GRPC_API_KEY;

  let res: Response;
  try {
    res = await fetch(url, { method: "DELETE", headers });
  } catch (err) {
    throw new Error(
      `[restock] Could not reach the Orders E2E cleanup route at ${url} — ` +
        `${(err as Error).message}. This step restores catalogue stock to the seed ` +
        "quantities before the suite runs; without it a previous run that died before " +
        "its teardown (Ctrl-C, timeout, early hard failure) leaves the catalogue " +
        "drained, and specs whose fixtures merely place an order fail with " +
        '"no product with stock in the catalogue". Is the stack up (`make bootstrap`)?',
    );
  }

  // 404/405 mean the route is not mounted, i.e. E2E_TESTING_ENABLED is off for
  // Orders. Named as its own case because it is a CONFIGURATION state, not a
  // transient fault — retrying or warning past it would leave the suite running
  // against a catalogue nothing can ever refill.
  if (res.status === 404 || res.status === 405) {
    throw new Error(
      `[restock] The Orders E2E cleanup route is not mounted at ${url} (${res.status}). ` +
        "It is only mapped when E2E_TESTING_ENABLED is set for the Orders service, which " +
        "is also what the global teardown needs. Enable it in .env.local.orders and " +
        "restart Orders (`docker compose up -d --force-recreate orders`).",
    );
  }

  if (!res.ok) {
    throw new Error(
      `[restock] The Orders E2E cleanup route at ${url} answered ${res.status}: ` +
        `${await res.text()}. Catalogue stock was NOT restored, so any spec that places ` +
        "an order may fail for lack of stock rather than for a real defect.",
    );
  }

  const body = (await res.json()) as OrdersCleanupResult;

  // Reported, never asserted. `restocked: 0` is the HEALTHY steady state — it means
  // every product was already at its seeded quantity — while a non-zero count is the
  // interesting one: it says the previous run died dirty and this step just repaired
  // it. Logging the line is what turns that from an invisible condition into one line
  // of output.
  console.log(
    `[restock] orders: deleted ${body.deleted} order(s), ${body.deletedDetails} detail row(s), ` +
      `restocked ${body.restocked} product(s)` +
      (body.restocked === 0
        ? " — catalogue was already at seed quantities."
        : " — the previous run left the catalogue drained; it has been restored."),
  );

  return body;
}
