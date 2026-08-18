/**
 * Phase-1 fixture types, derived from the services' openapi.yaml.
 * Phase 2 swaps the DATA SOURCE, not these types or the templates.
 *
 * Field names mirror the wire EXACTLY, including the case inconsistency
 * between Orders (camelCase) and its embedded tracking (snake_case).
 * Normalising here would hide a real contract inconsistency from phase 2.
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

/** Format integer cents as a display price. No currency in any contract. */
export function formatCents(value: IntLike): string {
  return (toInt(value) / 100).toFixed(2);
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
  unitPriceCents: IntLike;
  unitsInStock: IntLike;
  categories: string[];
  image: ProductImage | null;
}

/**
 * services/orders/openapi.yaml — OrderLineDto.
 * Carries ONLY productId: no name, image, or unit price. Rendering a line
 * requires joining against the product catalogue (see joinOrderLine).
 */
export interface OrderLine {
  productId: string;
  quantity: IntLike;
  subtotalCents: IntLike;
  taxCents: IntLike;
  totalCents: IntLike;
}

/** services/orders/openapi.yaml — OrderDto. No status field on the wire. */
export interface Order {
  id: string;
  userId: string;
  cognitoSub: string;
  subtotalCents: IntLike;
  taxCents: IntLike;
  shippingCents: IntLike;
  totalCents: IntLike;
  createdAt: string;
  lines: OrderLine[];
}

/**
 * The five delivery statuses.
 * NOT in any openapi.yaml — Tracking deliberately types `status` as a bare
 * string so an unknown value yields 400 from the handler rather than 422 from
 * Pydantic. Source of truth:
 *   services/tracking/src/features/tracking/domain/status.py
 * The design agrees: frame `Status Badge — States` (UOHCo) lists exactly these.
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

/** GET /v1/orders/my-orders returns an array of THESE, not of bare orders. */
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
