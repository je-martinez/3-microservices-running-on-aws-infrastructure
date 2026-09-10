// Restores the Orders catalogue to its seeded stock BEFORE a run, calling the same
// flag-guarded route the global teardown calls afterwards.
//
// CONTRACT: Keep this at SETUP even though teardown restocks too. Teardown only runs
// on a clean finish, so a suite killed by Ctrl-C or an early hard failure leaves the
// NEXT run against a drained catalogue, failing specs that have nothing to do with
// stock ("no product with stock in the catalogue"). The invariant must be "the
// catalogue is full when a run starts", not "whoever ran last left it full". Cheap to
// run unconditionally: the restock predicate is `WHERE UnitsInStock < seedUnits`, so a
// full catalogue matches no rows and reports `restocked: 0`. See [[testing]]

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
 * CONTRACT: THROW here, unlike the teardown, which swallows. Everything after this
 * depends on the catalogue having stock, so a cleanup that silently did not happen
 * surfaces as confusing 409 / "no product with stock" failures several specs later,
 * attributed to the wrong code. An unreachable service, a 404/405 (E2E_TESTING_ENABLED
 * off) and any non-2xx all fail loudly, naming what was attempted and why it matters.
 * See [[testing]]
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
