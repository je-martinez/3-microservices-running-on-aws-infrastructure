/** Minimal catalogue row shape from `GET /v1/products`. */
export type CatalogueProduct = { id: string; unitsInStock: number };

/**
 * Pick one in-stock product for a single-unit order.
 *
 * Random rather than `catalogue.find(p => p.unitsInStock > 0)`, and this was
 * measured rather than assumed: with 10 Playwright workers all pinning to the
 * first in-stock row, a 25-unit product drained under a full suite and unrelated
 * specs failed with `409 insufficient_stock` — including gateway
 * `realtime-tracking.spec.ts`, which never reached its websocket assertions.
 *
 * Spreading across the catalogue models real shopping and keeps parallel workers
 * from contending on one row. The load-test Orders scenario uses the same idea
 * (`findRandom()` in `load-tests/src/scenarios/orders.ts`).
 */
export function pickProductWithStock(
  catalogue: CatalogueProduct[],
  options?: { minStock?: number },
): CatalogueProduct {
  const minStock = options?.minStock ?? 1;
  const inStock = catalogue.filter((p) => p.unitsInStock >= minStock);
  if (inStock.length === 0) {
    throw new Error(
      `no product with at least ${minStock} unit(s) in stock — the catalogue is ` +
        "drained or the stack is down. Run `make bootstrap`; if a previous run died " +
        "before teardown, global-setup restock should repair it on the next run.",
    );
  }
  return inStock[Math.floor(Math.random() * inStock.length)]!;
}
