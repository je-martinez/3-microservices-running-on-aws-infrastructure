import type { OrderWithTracking } from "./api-types";
import { CURRENT_USER } from "./user.fixture";

const USER_ID = CURRENT_USER.id;
const COGNITO_SUB = "a3c1e6d0-4f2b-4a9d-8e7c-1b6f0d2a9c44";

/**
 * GET /v1/orders/my-orders returns an array of OrderWithTracking, not of
 * bare orders (see api-types.ts). Order ids use the `ord_` nano-id prefix.
 *
 * Deliberate edge-state coverage for layout (see task-4b-brief.md):
 *   - ord_3kLpQx8vRn: status PLACED, tracking present
 *   - ord_9mWtZo2hYd: status SHIPPED, tracking present
 *   - ord_fB6rEjN4uK: status DELIVERED, full tracking history
 *   - ord_hV2sTaC7wQ: tracking is null (no tracking record yet); its one
 *     line also references a delisted product (prd_zZ9delisted0, absent
 *     from catalogue.fixture.ts) so joinOrderLine's `product: null` branch
 *     (Task 11) actually renders somewhere instead of staying dead code
 */
export const ORDERS: readonly OrderWithTracking[] = [
  {
    order: {
      id: "ord_3kLpQx8vRn",
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
      subtotalCents: 8900,
      taxCents: 712,
      shippingCents: 500,
      // Total as a STRING, exercising IntLike on an Orders numeric field.
      totalCents: "10112",
      createdAt: "2026-08-15T18:22:41Z",
      lines: [
        {
          productId: "prd_V1StGXR8Z5",
          quantity: 1,
          subtotalCents: 8900,
          taxCents: 712,
          totalCents: 9612,
        },
      ],
    },
    tracking: {
      id: "trk_2pXqNzB6vT",
      user_id: USER_ID,
      order_id: "ord_3kLpQx8vRn",
      status: "PLACED",
      datetime: "2026-08-15T18:22:41Z",
      history: [
        {
          tracking_id: "trk_2pXqNzB6vT",
          user_id: USER_ID,
          order_id: "ord_3kLpQx8vRn",
          status: "PLACED",
          datetime: "2026-08-15T18:22:41Z",
        },
      ],
    },
  },
  {
    order: {
      id: "ord_9mWtZo2hYd",
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
      subtotalCents: 17300,
      taxCents: 1384,
      shippingCents: 0,
      totalCents: 18684,
      createdAt: "2026-08-10T09:05:12Z",
      lines: [
        {
          productId: "prd_bN8dJfR3mQ",
          quantity: 1,
          subtotalCents: 14900,
          taxCents: 1192,
          totalCents: 16092,
        },
        {
          productId: "prd_hQ3nWbT8xL",
          quantity: 1,
          subtotalCents: 2400,
          taxCents: 192,
          totalCents: 2592,
        },
      ],
    },
    tracking: {
      id: "trk_7cVdMwJ1lP",
      user_id: USER_ID,
      order_id: "ord_9mWtZo2hYd",
      status: "SHIPPED",
      datetime: "2026-08-12T14:30:00Z",
      history: [
        {
          tracking_id: "trk_7cVdMwJ1lP",
          user_id: USER_ID,
          order_id: "ord_9mWtZo2hYd",
          status: "PLACED",
          datetime: "2026-08-10T09:05:12Z",
        },
        {
          tracking_id: "trk_7cVdMwJ1lP",
          user_id: USER_ID,
          order_id: "ord_9mWtZo2hYd",
          status: "PROCESSING",
          datetime: "2026-08-11T08:00:00Z",
        },
        {
          tracking_id: "trk_7cVdMwJ1lP",
          user_id: USER_ID,
          order_id: "ord_9mWtZo2hYd",
          status: "SHIPPED",
          datetime: "2026-08-12T14:30:00Z",
        },
      ],
    },
  },
  {
    order: {
      id: "ord_fB6rEjN4uK",
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
      subtotalCents: 12500,
      taxCents: 1000,
      shippingCents: 500,
      totalCents: 14000,
      createdAt: "2026-07-28T11:41:09Z",
      lines: [
        {
          productId: "prd_pR9kLmZ2vN",
          quantity: 1,
          subtotalCents: 12500,
          taxCents: 1000,
          totalCents: 13500,
        },
      ],
    },
    // Full history through to DELIVERED.
    tracking: {
      id: "trk_5nRfKoX9dW",
      user_id: USER_ID,
      order_id: "ord_fB6rEjN4uK",
      status: "DELIVERED",
      datetime: "2026-08-02T16:12:47Z",
      history: [
        {
          tracking_id: "trk_5nRfKoX9dW",
          user_id: USER_ID,
          order_id: "ord_fB6rEjN4uK",
          status: "PLACED",
          datetime: "2026-07-28T11:41:09Z",
        },
        {
          tracking_id: "trk_5nRfKoX9dW",
          user_id: USER_ID,
          order_id: "ord_fB6rEjN4uK",
          status: "PROCESSING",
          datetime: "2026-07-29T09:15:00Z",
        },
        {
          tracking_id: "trk_5nRfKoX9dW",
          user_id: USER_ID,
          order_id: "ord_fB6rEjN4uK",
          status: "SHIPPED",
          datetime: "2026-07-30T13:05:00Z",
        },
        {
          tracking_id: "trk_5nRfKoX9dW",
          user_id: USER_ID,
          order_id: "ord_fB6rEjN4uK",
          status: "OUT_FOR_DELIVERY",
          datetime: "2026-08-02T08:20:00Z",
        },
        {
          tracking_id: "trk_5nRfKoX9dW",
          user_id: USER_ID,
          order_id: "ord_fB6rEjN4uK",
          status: "DELIVERED",
          datetime: "2026-08-02T16:12:47Z",
        },
      ],
    },
  },
  {
    order: {
      id: "ord_hV2sTaC7wQ",
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
      subtotalCents: 5600,
      taxCents: 448,
      shippingCents: 500,
      totalCents: 6548,
      createdAt: "2026-08-17T20:03:55Z",
      lines: [
        {
          // Deliberately delisted: no product in catalogue.fixture.ts has
          // this id. GET /v1/products returns only the active catalogue, so
          // an order referencing a since-removed product is a real runtime
          // case — this is the ONLY fixture line that exercises
          // joinOrderLine's `product: null` branch (see api-types.ts).
          // Every other order line resolves against PRODUCTS.
          productId: "prd_zZ9delisted0",
          quantity: 1,
          subtotalCents: 5600,
          taxCents: 448,
          totalCents: 6048,
        },
      ],
    },
    // No tracking record yet — the "tracking: null" edge state.
    tracking: null,
  },
];
