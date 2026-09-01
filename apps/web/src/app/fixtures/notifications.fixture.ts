import type { AppNotification } from "./api-types";

/**
 * NOT from a contract — no service exposes a notifications endpoint today (see
 * api-types.ts's AppNotification comment). Read from the design's Notification
 * Item (qwO6X) and Toast (jYz4h) frames. Two unread and two read, because the
 * panel has distinct Read and Unread tabs to fill.
 */
export const NOTIFICATIONS: readonly AppNotification[] = [
  {
    id: "ntf_9kDpXmR3vL",
    title: "Your order has shipped",
    body: "Order ord_9mWtZo2hYd is on its way. Track its progress from Order History.",
    status: "SHIPPED",
    createdAt: "2026-08-12T14:30:05Z",
    read: false,
  },
  {
    id: "ntf_2wNfQbT8xZ",
    title: "Delivered",
    body: "Order ord_fB6rEjN4uK was delivered. We hope you enjoy your Solstice Wool Throw.",
    status: "DELIVERED",
    createdAt: "2026-08-02T16:13:00Z",
    read: true,
  },
  {
    id: "ntf_6cVdMwJ1lP",
    title: "Order placed",
    body: "We've received order ord_hV2sTaC7wQ and are preparing it for shipment.",
    status: "PLACED",
    createdAt: "2026-08-17T20:04:10Z",
    read: false,
  },
  {
    id: "ntf_4rEjN2hYdK",
    title: "Welcome to 3MRAI",
    body: "Your account is ready. Browse the catalogue to place your first order.",
    // Not every notification is tracking-related.
    status: null,
    createdAt: "2026-02-11T15:04:30Z",
    read: true,
  },
];
