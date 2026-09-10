import type { AppNotification } from "../core/api/types";

/**
 * The LAST fixture, and deliberately so: the catalogue, orders and user fixtures
 * are gone, replaced by real gateway calls.
 *
 * CONTRACT: Do NOT go looking for a notifications endpoint to wire this to —
 * none exists. No service in this repo exposes notifications: not Users, not
 * Orders, not Tracking, not the events-pipeline. This data is read from the
 * design's Notification Item (qwO6X) and Toast (jYz4h) frames, and the panel
 * stays fixture-backed until a service owns the concept. Two unread and two
 * read, because the panel has distinct Read and Unread tabs to fill.
 * See [[openapi-specs]]
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
