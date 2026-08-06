import type { ReactElement } from "react";
import UserCreatedEmail, { type UserCreatedEmailProps } from "../../emails/user-created.tsx";
import OrderCreatedEmail, { type OrderCreatedEmailProps } from "../../emails/order-created.tsx";
import TrackingStatusChangedEmail, {
  type TrackingStatusChangedEmailProps,
} from "../../emails/tracking-status-changed.tsx";
import AuthOtpEmail, { type AuthOtpEmailProps } from "../../emails/auth-otp.tsx";

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

export const catalog: EmailCatalog = {
  "user-created": defineTemplate<UserCreatedEmailProps>({
    component: UserCreatedEmail,
    sampleProps: { fullName: "Ada Lovelace", email: "ada@example.com" },
  }),
  "order-created": defineTemplate<OrderCreatedEmailProps>({
    component: OrderCreatedEmail,
    sampleProps: { orderId: "ord_sample1", totalCents: 4599 },
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
    sampleProps: { orderId: "ord_sample1", status: "PLACED", previousStatus: "null" },
  }),
  "tracking-status-changed-processing": defineTemplate<TrackingStatusChangedEmailProps>({
    component: TrackingStatusChangedEmail,
    sampleProps: { orderId: "ord_sample1", status: "PROCESSING", previousStatus: "PLACED" },
  }),
  "tracking-status-changed-shipped": defineTemplate<TrackingStatusChangedEmailProps>({
    component: TrackingStatusChangedEmail,
    sampleProps: { orderId: "ord_sample1", status: "SHIPPED", previousStatus: "PROCESSING" },
  }),
  "tracking-status-changed-out-for-delivery": defineTemplate<TrackingStatusChangedEmailProps>({
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "OUT_FOR_DELIVERY",
      previousStatus: "SHIPPED",
    },
  }),
  "tracking-status-changed-delivered": defineTemplate<TrackingStatusChangedEmailProps>({
    component: TrackingStatusChangedEmail,
    sampleProps: {
      orderId: "ord_sample1",
      status: "DELIVERED",
      previousStatus: "OUT_FOR_DELIVERY",
    },
  }),
  // `sampleProps.code` is a made-up constant, never a real credential: this
  // object is rendered by the preview server and committed to a snapshot, so
  // anything here is public by construction.
  "auth-otp": defineTemplate<AuthOtpEmailProps>({
    component: AuthOtpEmail,
    sampleProps: { code: "042817", ttlMinutes: 5 },
  }),
};
