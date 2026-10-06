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
    data: browserRum,
  },
  {
    id: "preprod-deploy",
    title: preprodDeploy.title,
    primitive: "flow",
    output: "docs/infrastructure/runbooks/diagrams/preprod-deploy",
    watches: ["infra/environments/preprod/**", "docker-compose.preprod.yml", "Makefile"],
    data: preprodDeploy,
  },
  {
    id: "terraform-two-phase-apply",
    title: terraformTwoPhaseApply.title,
    primitive: "flow",
    output: "docs/infrastructure/decisions/diagrams/terraform-two-phase-apply",
    watches: ["infra/environments/local/**", "Makefile"],
    data: terraformTwoPhaseApply,
  },
];
