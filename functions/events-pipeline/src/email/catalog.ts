import type { ReactElement } from "react";
import UserCreatedEmail, { type UserCreatedEmailProps } from "../../emails/user-created.tsx";
import OrderCreatedEmail, { type OrderCreatedEmailProps } from "../../emails/order-created.tsx";
import TrackingStatusChangedEmail, {
  type TrackingStatusChangedEmailProps,
} from "../../emails/tracking-status-changed.tsx";
import AuthOtpEmail, { type AuthOtpEmailProps } from "../../emails/auth-otp.tsx";
import ForgotPasswordEmail, {
  type ForgotPasswordEmailProps,
} from "../../emails/forgot-password.tsx";

// The single registry: template key → component + sample props. Three consumers
// read THIS object and nothing else — handlers (to render), the preview server
// (to list), and tests (to snapshot every entry). One source of truth; adding a
// template is one entry here and no change to the renderer or the dispatch
// code. See the milestone design spec's "src/email/catalog.ts — the key piece".
//
// Task 11 adds `order-created` and Task 12 the `tracking-status-changed`
// variants (one entry per status) the same way.
export interface EmailTemplateEntry<P> {
  component: (props: P) => ReactElement;
  // Rendered by the preview server and by the "every entry renders" test, so an
  // entry can never be registered without a working set of props.
  sampleProps: P;
}

// `defineTemplate` is what keeps the map heterogeneous WITHOUT reaching for
// `any`. Each call is checked against its own prop type — passing
// `UserCreatedEmail` with props that don't match `UserCreatedEmailProps` is a
// compile error — and the return type erases P to `unknown` so entries with
// different prop shapes can live in one `Record`.
//
// A plain `Record<string, EmailTemplateEntry<any>>` (the shape the plan
// sketched) would type-check the same registration but disable checking for
// every future entry too, which is exactly the mistake that would surface as a
// runtime "cannot read property of undefined" inside a template.
export function defineTemplate<P>(entry: EmailTemplateEntry<P>): EmailTemplateEntry<unknown> {
  return entry as EmailTemplateEntry<unknown>;
}

export type EmailCatalog = Record<string, EmailTemplateEntry<unknown>>;

// The sample shipment every tracking variant renders against. Declared once so
// the five entries below cannot drift into describing five different parcels.
const SAMPLE_TRACKING_NUMBER = "3MRAI-7K2P-9WQX-4M8B";
const SAMPLE_ADDRESS = {
  line1: "1 Ada Way",
  city: "San Juan",
  country: "PR",
  postal_code: "00901",
};

// The full progression, oldest first, with the timestamps a real shipment would
// carry. Each entry below slices this to the steps that have ACTUALLY happened
// by its status — a PLACED email cannot show a delivery date it does not have
// yet, and one that did would be previewing a shipment the pipeline can never
// receive.
const SAMPLE_HISTORY = [
  { status: "PLACED", datetime: "2026-07-28T14:02:11Z" },
  { status: "PROCESSING", datetime: "2026-07-29T09:15:40Z" },
  { status: "SHIPPED", datetime: "2026-08-01T17:48:03Z" },
  { status: "OUT_FOR_DELIVERY", datetime: "2026-08-05T07:22:19Z" },
  { status: "DELIVERED", datetime: "2026-08-05T15:31:55Z" },
];

const historyThrough = (status: string) =>
  SAMPLE_HISTORY.slice(0, SAMPLE_HISTORY.findIndex((e) => e.status === status) + 1);

export const catalog: EmailCatalog = {
  "user-created": defineTemplate<UserCreatedEmailProps>({
    component: UserCreatedEmail,
    sampleProps: {
      fullName: "Ada Lovelace",
      email: "ada@example.com",
      userId: "usr_sample1",
      createdAt: "2026-08-05T12:00:00Z",
    },
  }),
  // A multi-line order whose figures actually balance: 2×1200 + 1×599 = 2999
  // subtotal, +240 tax +1500 shipping = 4739 total. A preview whose arithmetic
  // does not add up would hide exactly the bug the receipt exists to avoid.
  "order-created": defineTemplate<OrderCreatedEmailProps>({
    component: OrderCreatedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      fullName: "Ada Lovelace",
      subtotalCents: 2999,
      taxCents: 240,
      shippingCents: 1500,
      totalCents: 4739,
      shippingAddress: SAMPLE_ADDRESS,
      items: [
        { name: "Mechanical Keyboard", quantity: 2, unitPriceCents: 1200 },
        { name: "USB-C Cable", quantity: 1, unitPriceCents: 599 },
      ],
      createdAt: "2026-07-28T14:02:11Z",
    },
  }),
  // Five entries, ONE component (TrackingStatusChangedEmail) — see
  // #handlers/tracking-status-changed for where payload.status selects one of
  // these keys. This is the mirror image of Task 11's claim: a new event type
  // costs one dispatch entry, and one event type can fan out to several
  // rendered variants without adding a second one.
  //
  // Each `previousStatus` sample is the status that ACTUALLY precedes it in
  // the progression (PLACED -> PROCESSING -> SHIPPED -> OUT_FOR_DELIVERY ->
  // DELIVERED), so a preview shows a transition the pipeline can really
  // receive. PLACED is the initial status and therefore has no predecessor —
  // it carries the "no previous status" marker.
  "tracking-status-changed-placed": defineTemplate<TrackingStatusChangedEmailProps>({
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "PLACED",
      previousStatus: "null",
      changedAt: "2026-07-28T14:02:11Z",
      fullName: "Ada Lovelace",
      trackingNumber: SAMPLE_TRACKING_NUMBER,
      shippingAddress: SAMPLE_ADDRESS,
      history: historyThrough("PLACED"),
    },
  }),
  "tracking-status-changed-processing": defineTemplate<TrackingStatusChangedEmailProps>({
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "PROCESSING",
      previousStatus: "PLACED",
      changedAt: "2026-07-29T09:15:40Z",
      fullName: "Ada Lovelace",
      trackingNumber: SAMPLE_TRACKING_NUMBER,
      shippingAddress: SAMPLE_ADDRESS,
      history: historyThrough("PROCESSING"),
    },
  }),
  "tracking-status-changed-shipped": defineTemplate<TrackingStatusChangedEmailProps>({
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "SHIPPED",
      previousStatus: "PROCESSING",
      changedAt: "2026-08-01T17:48:03Z",
      fullName: "Ada Lovelace",
      trackingNumber: SAMPLE_TRACKING_NUMBER,
      shippingAddress: SAMPLE_ADDRESS,
      history: historyThrough("SHIPPED"),
    },
  }),
  "tracking-status-changed-out-for-delivery": defineTemplate<TrackingStatusChangedEmailProps>({
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "OUT_FOR_DELIVERY",
      previousStatus: "SHIPPED",
      changedAt: "2026-08-05T07:22:19Z",
      fullName: "Ada Lovelace",
      trackingNumber: SAMPLE_TRACKING_NUMBER,
      shippingAddress: SAMPLE_ADDRESS,
      history: historyThrough("OUT_FOR_DELIVERY"),
    },
  }),
  // The one entry WITHOUT a shipping address, so the preview and the snapshot
  // both cover the branch where the producer omitted the key entirely. Every
  // sample carrying an address would leave that path unrendered until a real
  // addressless shipment hit production.
  "tracking-status-changed-delivered": defineTemplate<TrackingStatusChangedEmailProps>({
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "DELIVERED",
      previousStatus: "OUT_FOR_DELIVERY",
      changedAt: "2026-08-05T15:31:55Z",
      fullName: "Ada Lovelace",
      trackingNumber: SAMPLE_TRACKING_NUMBER,
      history: historyThrough("DELIVERED"),
    },
  }),
  // `sampleProps.code` is a made-up constant, never a real credential: this
  // object is rendered by the preview server and committed to a snapshot, so
  // anything here is public by construction.
  //
  // `fullName` is "" on purpose — Cognito populates no name attribute today, so
  // the empty greeting IS the production path and the preview should show what
  // users actually receive rather than a name they will never see.
  "auth-otp": defineTemplate<AuthOtpEmailProps>({
    component: AuthOtpEmail,
    sampleProps: { code: "042817", ttlMinutes: 5, fullName: "" },
  }),
  // Same shape as `auth-otp` and for the same reasons: `code` is a made-up
  // constant (this object is rendered by the preview server and reachable from
  // a committed snapshot, so anything here is public by construction), and
  // `fullName` is "" because Cognito populates no name attribute today — the
  // empty greeting IS the production path, and the preview should show what
  // users actually receive.
  //
  // A DIFFERENT sample code from auth-otp's on purpose: a preview or a failing
  // assertion that mentions "042817" then names exactly one template instead of
  // two that render six digits in identical boxes.
  //
  // `ttlMinutes: 30` matches Cognito's own reset-code lifetime and the `.pen`
  // frame. It is still a PROP end to end — the handler derives it from the
  // payload's `ttlSeconds` — so this is a sample value, not a default.
  "forgot-password": defineTemplate<ForgotPasswordEmailProps>({
    component: ForgotPasswordEmail,
    sampleProps: { code: "720486", ttlMinutes: 10, fullName: "" },
  }),
};
