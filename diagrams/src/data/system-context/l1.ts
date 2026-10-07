import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

// CONTRACT: 3MRAI is one black-box node; everything outside the AWS Cloud group is a person or
// a third party. Sources: infra/modules/{api-gateway,cognito}, services/*/openapi.yaml
// (carrier and Stripe webhooks).
export const systemContextL1: z.input<typeof AwsDiagramData> = {
  title: "System context — Level 1",
  subtitle: "3MRAI as a black box: who uses it and which systems it depends on",
  direction: "RIGHT",
  groups: [
    { id: "people", kind: "corporate", label: "People and partners" },
    { id: "cloud", kind: "aws-cloud", label: "AWS Cloud (Floci locally)" },
    { id: "third", kind: "generic", label: "Third-party services" },
  ],
  nodes: [
    { id: "customer", label: "Customer", icon: "users", group: "people" },
    { id: "carrier", label: "Carrier", icon: "office-building", group: "people" },
    { id: "app", label: "3MRAI platform", icon: "server", group: "cloud" },
    { id: "cognito", label: "Cognito", icon: "cognito", group: "cloud" },
    { id: "ses", label: "SES", icon: "ses", group: "cloud" },
    { id: "stripe", label: "Stripe", sublabel: "optional, webhooks", icon: "internet", group: "third" },
    { id: "geoapify", label: "Geoapify", sublabel: "optional", icon: "internet", group: "third" },
    { id: "o2", label: "OpenObserve", sublabel: "logs + traces", icon: "server", group: "third" },
  ],
  edges: [
    { id: "customer-app", from: "customer", to: "app", label: "uses" },
    { id: "carrier-app", from: "carrier", to: "app", label: "status" },
    { id: "app-stripe", from: "app", to: "stripe", label: "payments" },
    { id: "app-geoapify", from: "app", to: "geoapify", label: "geocode" },
    { id: "app-cognito", from: "app", to: "cognito", label: "auth" },
    { id: "app-ses", from: "app", to: "ses", label: "email" },
    { id: "app-o2", from: "app", to: "o2", label: "telemetry" },
  ],
  steps: [],
};
