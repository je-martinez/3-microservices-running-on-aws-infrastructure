import type { CatalogEntry } from "../catalog";
import { observabilityTelemetry } from "./flows/observability-telemetry";
import { ordersCheckoutStripe } from "./flows/orders-checkout-stripe";
import { trackingNotification } from "./flows/tracking-notification";
import { usersPasswordReset } from "./flows/users-password-reset";
import { usersSignupOtp } from "./flows/users-signup-otp";

const usersWatches = ["services/users/src/**", "infra/modules/cognito/**", "functions/events-pipeline/src/handlers/**"];

export const initialFlowEntries: CatalogEntry[] = [
  {
    id: "users-signup-otp",
    title: usersSignupOtp.title,
    primitive: "flow",
    output: "docs/domains/users/specs/diagrams/users-signup-otp",
    watches: usersWatches,
    data: usersSignupOtp,
  },
  {
    id: "users-password-reset",
    title: usersPasswordReset.title,
    primitive: "flow",
    output: "docs/domains/users/specs/diagrams/users-password-reset",
    watches: usersWatches,
    data: usersPasswordReset,
  },
  {
    id: "orders-checkout-stripe",
    title: ordersCheckoutStripe.title,
    primitive: "flow",
    output: "docs/domains/orders/specs/diagrams/orders-checkout-stripe",
    watches: ["services/orders/**", "functions/events-pipeline/src/handlers/**"],
    data: ordersCheckoutStripe,
  },
  {
    id: "tracking-notification",
    title: trackingNotification.title,
    primitive: "flow",
    output: "docs/domains/tracking/specs/diagrams/tracking-notification",
    watches: ["services/tracking-go/**", "infra/modules/messaging/**", "functions/realtime-events/**"],
    data: trackingNotification,
  },
  {
    id: "observability-telemetry",
    title: observabilityTelemetry.title,
    primitive: "flow",
    output: "docs/shared/observability/diagrams/observability-telemetry",
    watches: ["observability/**", "docker-compose.yml", "apps/web/nginx.conf"],
    data: observabilityTelemetry,
  },
];
