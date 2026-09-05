/**
 * Contract types for every gateway response this app consumes, transcribed
 * from the services' openapi.yaml. Fixtures and API services both speak these.
 *
 * CONTRACT: Field names mirror the wire EXACTLY, including the camelCase
 * (Orders) / snake_case (embedded tracking) split. Normalising it here hides a
 * real contract inconsistency until phase 2 hits it at runtime.
 * See [[openapi-specs]]
 */

/**
 * Orders is a .NET service whose int64/uint32 fields serialise as
 * `type: [integer, string]` — a value may arrive as 12345 OR "12345".
 * Every numeric field from Orders uses this type.
 */
export type IntLike = number | string;

/** Coerce an IntLike to a number. Throws rather than yielding NaN silently. */
export function toInt(value: IntLike): number {
  const n = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new Error(`toInt: not an integer: ${String(value)}`);
  return n;
}

/**
 * services/orders/openapi.yaml — Money. Every HTTP amount is this object.
 *
 * CONTRACT: Render `formatted` verbatim. Do NOT re-round, re-derive or
 * recompute a display string from `cents`/`amount` — the server rounds tax per
 * line, so a client that rounds once over a subtotal shows a total a cent away
 * from what checkout actually charges. `cents` is the authoritative value and
 * is for arithmetic the server does not do (e.g. a local quantity preview).
 * See [[money-representation]]
 */
export interface Money {
  cents: IntLike;
  amount: string;
  formatted: string;
  currency: string;
}

/** services/orders/openapi.yaml — ProductImageDto. Note: `uri`, not `url`. */
export interface ProductImage {
  uri: string;
  width: IntLike;
  height: IntLike;
  blurhash: string;
}

/** services/orders/openapi.yaml — ProductDto. */
export interface Product {
  id: string;
  name: string;
  description: string;
  unitPrice: Money;
  unitsInStock: IntLike;
  categories: string[];
  image: ProductImage | null;
}

/**
 * Why a cart line cannot be bought.
 *
 * CONTRACT: snake_case — the ONLY snake_case values Orders sends, and unlike
 * every other Orders string these are an enum the service pins in
 * Orders.Application.Carts.UnavailableReason. The openapi.yaml types the field
 * as a bare `string`, so nothing generated will catch a drift here.
 * See [[openapi-specs]]
 */
export type UnavailableReason = "unknown_product" | "out_of_stock" | "insufficient_stock";

/**
 * services/orders/openapi.yaml — CartLineDto. All nine keys always present.
 *
 * CONTRACT: `available: false` does NOT imply an unpriced line. Only the
 * `unknown_product` reason nulls `name`/`unitPrice`/`subtotal`/`image`; an
 * out_of_stock or insufficient_stock line is fully priced and renders normally
 * with a badge. Guard on the field you read, not on `available` — treating the
 * two as equivalent blanks the price of every low-stock line.
 * `unavailableReason` is non-null exactly when `available` is false.
 * See [[money-representation]]
 */
export interface CartLine {
  productId: string;
  name: string | null;
  quantity: IntLike;
  unitsInStock: IntLike;
  available: boolean;
  unitPrice: Money | null;
  subtotal: Money | null;
  image: ProductImage | null;
  unavailableReason: UnavailableReason | null;
}

/**
 * services/orders/openapi.yaml — CartDto.
 * `id` is null for a user who has never had a cart persisted.
 */
export interface Cart {
  id: string | null;
  items: CartLine[];
  subtotal: Money;
  tax: Money;
  shipping: Money;
  total: Money;
  canCheckout: boolean;
}

/**
 * services/orders/openapi.yaml — OrderLineDto.
 * Carries ONLY productId: no name, image, or unit price. Rendering a line
 * requires joining against the product catalogue (see joinOrderLine).
 *
 * CONTRACT: A line has NO `shipping` — only the order does. A line total is
 * therefore its own subtotal + tax, and summing the lines of an order yields
 * less than `order.total` by exactly the shipping. Do NOT reconcile the two by
 * inventing a per-line shipping share. See [[money-representation]]
 */
export interface OrderLine {
  productId: string;
  quantity: IntLike;
  subtotal: Money;
  tax: Money;
  total: Money;
}

/** services/orders/openapi.yaml — OrderDto. No status field on the wire. */
export interface Order {
  id: string;
  userId: string;
  cognitoSub: string;
  subtotal: Money;
  tax: Money;
  shipping: Money;
  total: Money;
  createdAt: string;
  lines: OrderLine[];
}

/**
 * The five delivery statuses.
 *
 * CONTRACT: These are NOT in any openapi.yaml — Tracking types `status` as a
 * bare string on the wire, so nothing generated will catch a drift here. The
 * source of truth is services/tracking-go/internal/domain/status.go; the design
 * frame `Status Badge — States` (UOHCo) lists exactly these.
 * See [[openapi-specs]]
 */
export type TrackingStatus =
  | "PLACED"
  | "PROCESSING"
  | "SHIPPED"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED";

export const TRACKING_STATUSES: readonly TrackingStatus[] = [
  "PLACED",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const;

/** snake_case: Tracking is FastAPI, and Orders copies its shape verbatim. */
export interface TrackingHistoryEntry {
  tracking_id: string;
  user_id: string;
  order_id: string;
  status: TrackingStatus;
  datetime: string;
}

/** Keys itself as `id` while history entries key it as `tracking_id`. */
export interface Tracking {
  id: string;
  user_id: string;
  order_id: string;
  status: TrackingStatus;
  datetime: string;
  history: TrackingHistoryEntry[];
}

/**
 * GET /orders/my-orders returns an array of THESE only when the request carries
 * `includeTracking=true`.
 *
 * CONTRACT: That parameter defaults to FALSE, and without it the same route
 * answers 200 with an array of bare `Order`s. Nothing throws — every
 * `entry.order` reads undefined and the list renders as if the user had no
 * orders. OrdersApi is what pins the parameter on; see orders-api.ts.
 * See [[openapi-specs]]
 */
export interface OrderWithTracking {
  order: Order;
  tracking: Tracking | null;
}

/**
 * NOT from a contract. User.address is `anyOf: [{}, null]` in
 * services/users/openapi.yaml — completely untyped. These fields are read from
 * the DESIGN's profile and checkout frames. Phase 2 must reconcile them with
 * whatever the backend settles on.
 */
export interface Address {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

/**
 * services/users/openapi.yaml — User.
 * All 15 properties are REQUIRED with `additionalProperties: false`, so the
 * payload always carries exactly these keys — the createdBy/updatedBy/
 * deletedBy/deletedAt audit quartet is nullable, never absent.
 */
export interface User {
  id: string;
  email: string;
  fullName: string;
  address: Address | null;
  phoneNumber: string | null;
  tags: string[];
  authType: "PASSWORD" | "PASSWORDLESS";
  mustChangePassword: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string;
  deletedBy: string | null;
  deletedAt: string | null;
  isDeleted: boolean;
}

/**
 * NOT from a contract — no service exposes a notifications endpoint today.
 * Read from the design's Notification Item (qwO6X) and Toast (jYz4h) frames.
 */
export interface AppNotification {
  id: string;
  title: string;
  body: string;
  status: TrackingStatus | null;
  createdAt: string;
  read: boolean;
}

/** An order line resolved against the catalogue, for rendering. */
export interface ResolvedOrderLine extends OrderLine {
  product: Product | null;
}

/** Join a line to its product. Returns product: null for a delisted product. */
export function joinOrderLine(line: OrderLine, catalogue: readonly Product[]): ResolvedOrderLine {
  return { ...line, product: catalogue.find((p) => p.id === line.productId) ?? null };
}
