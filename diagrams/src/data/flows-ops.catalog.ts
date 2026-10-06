import type { CatalogEntry } from "../catalog";
import { browserRum } from "./flows/browser-rum";
import { businessMetrics } from "./flows/business-metrics";
import { preprodDeploy } from "./flows/preprod-deploy";
import { terraformTwoPhaseApply } from "./flows/terraform-two-phase-apply";

export const opsFlowEntries: CatalogEntry[] = [
  {
    id: "business-metrics",
    title: businessMetrics.title,
    primitive: "flow",
    output: "docs/shared/observability/diagrams/business-metrics",
    watches: [
      "services/*/src/shared/metrics/**",
      "services/orders/src/Orders.Api/BackgroundServices/OrdersMetricsPublisher.cs",
      "services/tracking-go/internal/adapter/cloudwatch/**",
      "functions/events-pipeline/src/handler.ts",
      "observability/**",
    ],
    source: "diagrams/src/data/flows/business-metrics.ts",
    data: businessMetrics,
  },
  {
    id: "browser-rum",
    title: browserRum.title,
    primitive: "flow",
    output: "docs/shared/observability/diagrams/browser-rum",
    watches: [
      "apps/web/src/app/core/observability/**",
      "apps/web/nginx.conf",
      "observability/otel-collector-config.yaml",
      "observability/dashboards/rum.dashboard.json",
    ],
    source: "diagrams/src/data/flows/browser-rum.ts",
    data: browserRum,
  },
  {
    id: "preprod-deploy",
    title: preprodDeploy.title,
    primitive: "flow",
    output: "docs/infrastructure/runbooks/diagrams/preprod-deploy",
    // WHY Makefile stays: the preprod-up target is the only source of the step order this flow draws.
    watches: ["infra/environments/preprod/**", "docker-compose.preprod.yml", "Makefile"],
    source: "diagrams/src/data/flows/preprod-deploy.ts",
    data: preprodDeploy,
  },
  {
    id: "terraform-two-phase-apply",
    title: terraformTwoPhaseApply.title,
    primitive: "flow",
    output: "docs/infrastructure/decisions/diagrams/terraform-two-phase-apply",
    watches: [
      "infra/environments/local/backend/**",
      "infra/environments/local/*.tf",
      "infra/environments/local/post/**",
    ],
    source: "diagrams/src/data/flows/terraform-two-phase-apply.ts",
    data: terraformTwoPhaseApply,
  },
];
