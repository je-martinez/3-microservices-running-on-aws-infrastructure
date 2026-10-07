import type { CatalogEntry } from "../catalog";
import { observabilityTelemetry } from "./flows/observability-telemetry";
import { ordersCheckoutStripe } from "./flows/orders-checkout-stripe";
import { trackingNotification } from "./flows/tracking-notification";
import { usersPasswordReset } from "./flows/users-password-reset";
import { usersSignupOtp } from "./flows/users-signup-otp";

export const initialFlowEntries: CatalogEntry[] = [
  {
    id: "users-signup-otp",
    title: usersSignupOtp.title,
    primitive: "flow",
    output: "docs/domains/users/specs/diagrams/users-signup-otp",
    watches: [
      "services/users/src/users/commands/register-passwordless.command.ts",
      "services/users/src/users/commands/*-otp-challenge.command.ts",
      "infra/modules/cognito/otp-challenge-lambda/**",
      "functions/events-pipeline/src/handlers/user-created.ts",
      "functions/events-pipeline/src/handlers/auth-otp-requested.ts",
    ],
    source: "diagrams/src/data/flows/users-signup-otp.ts",
    data: usersSignupOtp,
  },
  {
    id: "users-password-reset",
    title: usersPasswordReset.title,
    primitive: "flow",
    output: "docs/domains/users/specs/diagrams/users-password-reset",
    watches: [
      "services/users/src/users/commands/forgot-password.command.ts",
      "services/users/src/users/commands/confirm-password-reset.command.ts",
      "services/users/src/shared/cache/reset-code-store.ts",
      "services/users/src/shared/auth/reset-code.ts",
      "functions/events-pipeline/src/handlers/password-reset-requested.ts",
    ],
    source: "diagrams/src/data/flows/users-password-reset.ts",
    data: usersPasswordReset,
  },
  {
    id: "orders-checkout-stripe",
    title: ordersCheckoutStripe.title,
    primitive: "flow",
    output: "docs/domains/orders/specs/diagrams/orders-checkout-stripe",
    watches: [
      "services/orders/src/Orders.Api/Endpoints/CreateOrderEndpoint.cs",
      "services/orders/src/Orders.Api/Endpoints/StripeWebhookEndpoints.cs",
      "services/orders/src/Orders.Api/Payments/**",
      "services/orders/src/Orders.Application/Orders/CreateOrderCommand.cs",
      "services/orders/src/Orders.Infrastructure/Orders/CreateOrderService.cs",
      "services/orders/src/Orders.Infrastructure/Payments/**",
      "services/orders/src/Orders.Infrastructure/Grpc/UserDirectoryGrpcClient.cs",
      "services/orders/src/Orders.Infrastructure/Tracking/TrackingHttpClient.cs",
      "services/orders/src/Orders.Infrastructure/Messaging/SnsEventPublisher.cs",
      "functions/events-pipeline/src/handlers/order-created.ts",
    ],
    source: "diagrams/src/data/flows/orders-checkout-stripe.ts",
    data: ordersCheckoutStripe,
  },
  {
    id: "tracking-notification",
    title: trackingNotification.title,
    primitive: "flow",
    output: "docs/domains/tracking/specs/diagrams/tracking-notification",
    watches: [
      "services/tracking-go/internal/adapter/http/handler_carrier.go",
      "services/tracking-go/internal/app/update_status.go",
      "services/tracking-go/internal/adapter/mysql/outbox_writer.go",
      "services/tracking-go/internal/outbox/**",
      "services/tracking-go/internal/adapter/notify/**",
      "infra/modules/messaging/**",
      "functions/realtime-events/**",
      "functions/events-pipeline/src/handlers/tracking-status-changed.ts",
      "services/users/src/notifications/**",
      "services/users/src/shared/realtime/**",
    ],
    source: "diagrams/src/data/flows/tracking-notification.ts",
    data: trackingNotification,
  },
  {
    id: "observability-telemetry",
    title: observabilityTelemetry.title,
    primitive: "flow",
    output: "docs/shared/observability/diagrams/observability-telemetry",
    watches: ["observability/**", "docker-compose.yml", "apps/web/nginx.conf"],
    source: "diagrams/src/data/flows/observability-telemetry.ts",
    data: observabilityTelemetry,
  },
];
