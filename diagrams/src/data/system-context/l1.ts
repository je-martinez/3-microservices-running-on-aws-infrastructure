import type { ArchitectureData } from "../../schema";

// CONTRACT: zones are context boundaries; 3MRAI is one black-box node. Sources:
// infra/modules/{api-gateway,cognito}, services/*/openapi.yaml (carrier and Stripe webhooks).
export const systemContextL1: ArchitectureData = {
  title: "System context — Level 1",
  subtitle: "3MRAI as a black box: who uses it and which systems it depends on",
  zones: [
    { id: "outside", label: "People and partners" },
    { id: "system", label: "3MRAI" },
    { id: "platform", label: "Platform services" },
  ],
  nodes: [
    { id: "customer", label: "Customer", kind: "external", zone: "outside" },
    { id: "carrier", label: "Carrier", kind: "external", zone: "outside" },
    { id: "stripe", label: "Stripe (opt, +hooks)", kind: "external", zone: "outside" },
    { id: "geoapify", label: "Geoapify (optional)", kind: "external", zone: "outside" },
    { id: "app", label: "3MRAI platform", kind: "compute", zone: "system" },
    { id: "cognito", label: "Cognito", kind: "edge", aws: "cognito", zone: "platform" },
    { id: "ses", label: "SES", kind: "messaging", aws: "ses", zone: "platform" },
    { id: "o2", label: "OpenObserve", kind: "external", zone: "platform" },
  ],
  edges: [
    { from: "customer", to: "app", label: "uses" },
    { from: "carrier", to: "app", label: "status" },
    { from: "app", to: "stripe", label: "payments" },
    { from: "app", to: "geoapify", label: "geocode" },
    { from: "app", to: "cognito", label: "auth" },
    { from: "app", to: "ses", label: "email" },
    { from: "app", to: "o2", label: "telemetry" },
  ],
};
