import type { HandlerMap } from "#pipeline/process-record";
import { userCreatedHandler } from "#handlers/user-created";
import { orderCreatedHandler } from "#handlers/order-created";
import { trackingStatusChangedHandler } from "#handlers/tracking-status-changed";
import { authOtpRequestedHandler } from "#handlers/auth-otp-requested";
import { passwordResetRequestedHandler } from "#handlers/password-reset-requested";

// The CQRS dispatch table: event `type` → handler. Adding a type is ONE entry
// here, with no change to src/handler.ts — see the milestone design spec's
// "Implementation order": USER_CREATED lands in Task 10 and ORDER_CREATED in
// Task 11, which is what proves that claim rather than assuming it.
//
// TRACKING_STATUS_CHANGED (Task 12) is still just ONE entry, even though it
// fans out to five rendered templates (PLACED, PROCESSING, SHIPPED,
// OUT_FOR_DELIVERY, DELIVERED) — that fan-out lives inside
// trackingStatusChangedHandler, keyed
// by payload.status, not here. This is the mirror image of the Task 11
// claim above: the event taxonomy and the template catalog vary
// independently.
//
// AUTH_OTP_REQUESTED is the same one-entry addition, and — with
// PASSWORD_RESET_REQUESTED — one of the two types whose payload is REDACTED
// before persistence (#domain/redact-payload). The dispatch table is unaffected
// by that: the handler still receives the intact envelope.
//
// PASSWORD_RESET_REQUESTED is a SEPARATE TYPE rather than a variant of
// AUTH_OTP_REQUESTED, even though both carry `{ email, full_name, code,
// ttlSeconds }` and both render six digits. They are different flows with
// different Cognito APIs behind them (InitiateAuth/CUSTOM_AUTH vs
// ForgotPassword), different TTLs, and different consequences if the mail goes
// astray — collapsing them would mean a runtime branch deciding which email a
// recipient gets, on a payload that cannot distinguish the two.
export const handlers: HandlerMap = {
  USER_CREATED: userCreatedHandler,
  ORDER_CREATED: orderCreatedHandler,
  TRACKING_STATUS_CHANGED: trackingStatusChangedHandler,
  AUTH_OTP_REQUESTED: authOtpRequestedHandler,
  PASSWORD_RESET_REQUESTED: passwordResetRequestedHandler,
};
