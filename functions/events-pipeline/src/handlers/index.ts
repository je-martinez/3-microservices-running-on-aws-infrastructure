import type { HandlerMap } from "#pipeline/process-record";
import { userCreatedHandler } from "#handlers/user-created";
import { orderCreatedHandler } from "#handlers/order-created";
import { trackingStatusChangedHandler } from "#handlers/tracking-status-changed";

// The CQRS dispatch table: event `type` → handler. Adding a type is ONE entry
// here, with no change to src/handler.ts — see the milestone design spec's
// "Implementation order": USER_CREATED lands in Task 10 and ORDER_CREATED in
// Task 11, which is what proves that claim rather than assuming it.
//
// TRACKING_STATUS_CHANGED (Task 12) is still just ONE entry, even though it
// fans out to four rendered templates (SHIPPED, ON_THE_WAY, OUT_FOR_DELIVERY,
// DELIVERED) — that fan-out lives inside trackingStatusChangedHandler, keyed
// by payload.status, not here. This is the mirror image of the Task 11
// claim above: the event taxonomy and the template catalog vary
// independently.
export const handlers: HandlerMap = {
  USER_CREATED: userCreatedHandler,
  ORDER_CREATED: orderCreatedHandler,
  TRACKING_STATUS_CHANGED: trackingStatusChangedHandler,
};
