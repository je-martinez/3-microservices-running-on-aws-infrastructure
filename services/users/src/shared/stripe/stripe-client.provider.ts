import Stripe from "stripe";
import { AppConfigService } from "#config/config.module";
import { appLogger } from "#shared/logging/app-logger";
import { STRIPE_CLIENT } from "#shared/tokens";

export { STRIPE_CLIENT };

export const STRIPE_API_VERSION = "2026-08-26.dahlia" as const;

export interface StripeEnv {
  STRIPE_ENABLED: boolean;
  STRIPE_SECRET_KEY: string | undefined;
}

export interface StripeClientHolder {
  /** Null when STRIPE_ENABLED is true but STRIPE_SECRET_KEY is absent (Decision 13). */
  readonly client: Stripe | null;
  readonly enabled: boolean;
}

interface WarnLogger {
  warn(message: string): void;
}

// CONTRACT: STRIPE_ENABLED=true with no key is a valid boot state (spec D13) —
// the service still boots; callers check `.client` for null and answer 503.
export function buildStripeClientHolder(env: StripeEnv, logger: WarnLogger): StripeClientHolder {
  if (!env.STRIPE_ENABLED) {
    return { client: null, enabled: false };
  }
  if (!env.STRIPE_SECRET_KEY) {
    logger.warn(
      "STRIPE_ENABLED is true but STRIPE_SECRET_KEY is not set. Stripe routes will answer 503.",
    );
    return { client: null, enabled: true };
  }
  return {
    client: new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION }),
    enabled: true,
  };
}

export const stripeClientProvider = {
  provide: STRIPE_CLIENT,
  inject: [AppConfigService],
  useFactory: (config: AppConfigService): StripeClientHolder =>
    buildStripeClientHolder(
      {
        STRIPE_ENABLED: config.get("STRIPE_ENABLED", false),
        STRIPE_SECRET_KEY: config.get("STRIPE_SECRET_KEY", undefined),
      },
      appLogger,
    ),
};
