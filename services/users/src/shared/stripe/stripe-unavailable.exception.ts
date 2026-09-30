import { HttpException, HttpStatus } from "@nestjs/common";

// Thrown by any Stripe-backed route when the client holder's `.client` is
// null (spec D13) — flag on, key missing. Never thrown when the flag is off;
// those routes are not mounted at all. Body matches the service's Error
// schema (`{ error: string }`), not a plain HttpException message string.
export class StripeUnavailableException extends HttpException {
  constructor() {
    super({ error: "stripe_unavailable" }, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
