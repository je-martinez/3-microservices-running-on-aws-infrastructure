import type { FlowData } from "../../schema";

export const ordersCheckoutStripe: FlowData = {
  title: "Checkout with a Stripe charge",
  subtitle: "Charge first, persist in one transaction, reconcile through Stripe's webhook",
  actors: [
    { id: "web", label: "Web app", kind: "external" },
    { id: "orders", label: "Orders service", kind: "compute", aws: "ecs" },
    { id: "users", label: "Users service", kind: "compute", aws: "ecs" },
    { id: "stripe", label: "Stripe", kind: "external" },
    { id: "db", label: "Orders DB", kind: "data", aws: "aurora" },
    { id: "tracking", label: "Tracking service", kind: "compute", aws: "ecs" },
    { id: "pipeline", label: "Events pipeline", kind: "compute", aws: "lambda" },
  ],
  steps: [
    { from: "web", to: "orders", label: "Place order", caption: "The browser sends the cart lines, a saved payment method and an Idempotency-Key" },
    { from: "orders", to: "users", label: "Resolve caller", caption: "A gRPC call returns the user's id, email, name, address and Stripe customer" },
    { from: "orders", to: "stripe", label: "Charge", caption: "An off-session PaymentIntent, before persisting and outside the transaction" },
    { from: "orders", to: "db", label: "Write order", caption: "One transaction locks products, writes the order, deletes the cart; failure refunds" },
    { from: "orders", to: "pipeline", label: "ORDER_CREATED", caption: "Published to SNS before the commit; the pipeline emails the receipt through SES", async: true },
    { from: "orders", to: "tracking", label: "Init tracking", caption: "Called after the commit; a failure is logged and the response is unchanged" },
    { from: "orders", to: "web", label: "Order created", caption: "A retry with the same key replays this order instead of charging again" },
    { from: "stripe", to: "orders", label: "Webhook", caption: "payment_intent.succeeded passes IP allowlist, URL token and signature checks", async: true },
    { from: "orders", to: "db", label: "Find order", caption: "The write database is checked for the order the intent's metadata names" },
    { from: "orders", to: "stripe", label: "Refund orphan", caption: "A paid intent with no order after the grace period is refunded; otherwise a no-op" },
  ],
};
