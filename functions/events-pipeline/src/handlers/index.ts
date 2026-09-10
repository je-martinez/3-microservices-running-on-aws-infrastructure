import type { HandlerMap } from "#pipeline/process-record";
import { userCreatedHandler } from "#handlers/user-created";
import { orderCreatedHandler } from "#handlers/order-created";
import { trackingStatusChangedHandler } from "#handlers/tracking-status-changed";
import { authOtpRequestedHandler } from "#handlers/auth-otp-requested";
import { passwordResetRequestedHandler } from "#handlers/password-reset-requested";

// The CQRS dispatch table: event `type` → handler. Adding a type is one entry
// here, with no change to src/handler.ts. Template fan-out is NOT modelled here
// — TRACKING_STATUS_CHANGED is one entry that renders five templates, keyed by
// payload.status inside its handler.
// CONTRACT: Keep PASSWORD_RESET_REQUESTED separate from AUTH_OTP_REQUESTED.
// The payloads are identical but the flows are not (ForgotPassword vs
// CUSTOM_AUTH, different TTLs), and merging them puts a runtime branch in charge
// of which email a recipient gets, on a payload that cannot tell them apart.
// See [[events-pipeline-design]]
export const handlers: HandlerMap = {
  USER_CREATED: userCreatedHandler,
  ORDER_CREATED: orderCreatedHandler,
  TRACKING_STATUS_CHANGED: trackingStatusChangedHandler,
  AUTH_OTP_REQUESTED: authOtpRequestedHandler,
  PASSWORD_RESET_REQUESTED: passwordResetRequestedHandler,
};
