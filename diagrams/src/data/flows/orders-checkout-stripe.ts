import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: local dev. Orders, Users and Tracking run in Docker Compose; SNS, SQS, the pipeline
// Lambda and SES run on Floci outside the VPC; the Orders DB (the RDS MySQL cluster) sits in
// module.networking's subnets; Stripe is outside AWS. Source: infra/environments/local/main.tf.
export const ordersCheckoutStripe: z.input<typeof AwsDiagramData> = {
  title: "Checkout with a Stripe charge",
  subtitle: "Local dev on Floci: charge first, persist in one transaction, reconcile through Stripe's webhook",
  direction: "RIGHT",
  groups: [
    { id: "compose", kind: "generic", label: "Docker Compose" },
    { id: "floci", kind: "local-floci", label: "Floci (:4566)" },
    { id: "vpc", kind: "vpc", label: "VPC 10.0.0.0/16", parent: "floci" },
    { id: "subnets", kind: "public-subnet", label: "Subnets a + b", parent: "vpc" },
  ],
  nodes: [
    { id: "web", label: "Web app", icon: "client" },
    { id: "orders", label: "Orders service", icon: "server", group: "compose" },
    { id: "users", label: "Users service", icon: "server", group: "compose" },
    { id: "tracking", label: "Tracking service", icon: "server", group: "compose" },
    { id: "stripe", label: "Stripe", icon: "internet" },
    { id: "db", label: "Orders DB", sublabel: "RDS MySQL", icon: "rds", group: "subnets" },
    { id: "sns", label: "Events topic", icon: "sns", group: "floci" },
    { id: "sqs", label: "Events queue", icon: "sqs", group: "floci" },
    { id: "pipeline", label: "Events pipeline", icon: "lambda", group: "floci" },
    { id: "ses", label: "SES", sublabel: "Mailpit", icon: "ses", group: "floci" },
  ],
  edges: [
    { id: "web-orders", from: "web", to: "orders", label: "REST" },
    { id: "orders-users", from: "orders", to: "users", label: "gRPC" },
    { id: "orders-stripe", from: "orders", to: "stripe", label: "charge, refund" },
    { id: "orders-db", from: "orders", to: "db" },
    { id: "orders-sns", from: "orders", to: "sns", label: "ORDER_CREATED", async: true },
    { id: "sns-sqs", from: "sns", to: "sqs", async: true },
    { id: "sqs-pipeline", from: "sqs", to: "pipeline", async: true },
    { id: "pipeline-ses", from: "pipeline", to: "ses", label: "receipt" },
    { id: "orders-tracking", from: "orders", to: "tracking", label: "init tracking" },
    { id: "stripe-orders", from: "stripe", to: "orders", label: "webhook", async: true },
  ],
  steps: [
    { edges: ["web-orders"], caption: "The browser sends the cart lines, a saved payment method and an Idempotency-Key" },
    { edges: ["orders-users"], caption: "A gRPC call returns the user's id, email, name, address and Stripe customer" },
    { edges: ["orders-stripe"], caption: "An off-session PaymentIntent, before persisting and outside the transaction" },
    { edges: ["orders-db"], caption: "One transaction locks products, writes the order, deletes the cart; failure refunds" },
    { edges: ["orders-sns", "sns-sqs", "sqs-pipeline", "pipeline-ses"], caption: "Published to SNS before the commit; the pipeline emails the receipt through SES" },
    { edges: ["orders-tracking"], caption: "Called after the commit; a failure is logged and the response is unchanged" },
    { edges: ["web-orders"], caption: "A retry with the same key replays this order instead of charging again" },
    { edges: ["stripe-orders"], caption: "payment_intent.succeeded passes IP allowlist, URL token and signature checks" },
    { edges: ["orders-db"], caption: "The write database is checked for the order the intent's metadata names" },
    { edges: ["orders-stripe"], caption: "A paid intent with no order after the grace period is refunded; otherwise a no-op" },
  ],
};
