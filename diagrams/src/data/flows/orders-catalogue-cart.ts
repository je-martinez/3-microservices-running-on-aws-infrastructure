import type { FlowData } from "../../schema";

export const ordersCatalogueCart: FlowData = {
  title: "Browse the catalogue and edit the cart",
  subtitle: "Orders owns the cart and every figure; the web app renders what it is sent",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "orders", label: "Orders service", kind: "compute", aws: "ecs" },
    { id: "cache", label: "Response cache", kind: "data", aws: "elasticache" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
    { id: "db", label: "Orders DB", kind: "data", aws: "aurora" },
  ],
  steps: [
    { from: "web", to: "orders", label: "List products", caption: "The home page loads the catalogue once; category chips and search filter in the browser" },
    { from: "orders", to: "cache", label: "Catalogue key", caption: "One key shared by every buyer, 10-minute TTL; a miss reads the products table" },
    { from: "web", to: "orders", label: "Read cart", caption: "The drawer reads the cart on open; a buyer with no cart gets an empty one, never a 404" },
    { from: "orders", to: "users", label: "Resolve user id", caption: "Per-user keys need the user id: the identity cache first, else Users over gRPC" },
    { from: "orders", to: "cache", label: "Cart key", caption: "A per-user key with a 60-second TTL; a hit returns the stored body without the handler" },
    { from: "orders", to: "db", label: "Price lines", caption: "On a miss one catalogue query prices every line and flags unavailable ones" },
    { from: "web", to: "orders", label: "Replace cart", caption: "Stepper clicks debounce per product and queue, so a burst becomes one full replacement" },
    { from: "orders", to: "db", label: "Sync lines", caption: "One transaction; no live lines deletes the cart; a lost create race retries once" },
    { from: "orders", to: "cache", label: "Invalidate", caption: "After the commit, the caller's whole per-user key index is swept" },
    { from: "orders", to: "web", label: "Priced cart", caption: "Totals count available lines only; canCheckout gates the drawer's Continue button" },
  ],
};
