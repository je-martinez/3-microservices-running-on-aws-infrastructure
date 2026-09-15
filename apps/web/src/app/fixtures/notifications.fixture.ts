import type { AppNotification } from "../core/api/types";

/**
 * The LAST fixture. Users now owns the notifications endpoints, so this data is
 * a placeholder for `NotificationsPanel` only until Tasks 4.5-4.7 bind it to
 * `NotificationsStore`; every other fixture is already gone.
 *
 * CONTRACT: Two unread and two read, because the panel has distinct Read and
 * Unread tabs to fill and an empty tab renders its empty state instead.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export const NOTIFICATIONS: readonly AppNotification[] = [
  {
    id: "ntf_9kDpXmR3vL",
    type: "ORDER_STATUS",
    title: "Your order has shipped",
    body: "Order ord_9mWtZo2hYd is on its way. Track its progress from Order History.",
    metadata: {
      status: "SHIPPED",
      order_id: "ord_9mWtZo2hYd",
      occurred_at: "2026-08-12T14:30:05Z",
    },
    createdAt: "2026-08-12T14:30:05Z",
    readAt: null,
  },
  {
    id: "ntf_2wNfQbT8xZ",
    type: "ORDER_STATUS",
    title: "Delivered",
    body: "Order ord_fB6rEjN4uK was delivered. We hope you enjoy your Solstice Wool Throw.",
    metadata: {
      status: "DELIVERED",
      order_id: "ord_fB6rEjN4uK",
      occurred_at: "2026-08-02T16:13:00Z",
    },
    createdAt: "2026-08-02T16:13:00Z",
    readAt: "2026-08-03T09:00:00Z",
  },
  {
    id: "ntf_6cVdMwJ1lP",
    type: "ORDER_STATUS",
    title: "Order placed",
    body: "We've received order ord_hV2sTaC7wQ and are preparing it for shipment.",
    metadata: {
      status: "PLACED",
      order_id: "ord_hV2sTaC7wQ",
      occurred_at: "2026-08-17T20:04:10Z",
    },
    createdAt: "2026-08-17T20:04:10Z",
    readAt: null,
  },
  {
    id: "ntf_4rEjN2hYdK",
    type: "WELCOME",
    title: "Welcome to 3MRAI",
    body: "Your account is ready. Browse the catalogue to place your first order.",
    // A WELCOME row carries no status and no order — not every notification is
    // tracking-related.
    metadata: { occurred_at: "2026-02-11T15:04:30Z" },
    createdAt: "2026-02-11T15:04:30Z",
    readAt: "2026-02-11T16:00:00Z",
  },
];
