import type { CatalogEntry } from "../catalog";
import { systemContextL1 } from "./system-context/l1";
import { systemContextL2 } from "./system-context/l2";

const watches = [
  "infra/modules/api-gateway/**", "infra/modules/cognito/**", "services/*/openapi.yaml", "apps/web/nginx.conf",
  "infra/modules/compute/**", "infra/modules/alb/**", "infra/modules/docdb/**", "infra/modules/redis/**",
];

export const systemContextEntries: CatalogEntry[] = [
  {
    id: "system-context-l1",
    title: systemContextL1.title,
    output: "docs/00-overview/diagrams/system-context-l1",
    watches,
    primitive: "aws",
    source: "diagrams/src/data/system-context/l1.ts",
    data: systemContextL1,
  },
  {
    id: "system-context-l2",
    title: systemContextL2.title,
    output: "docs/00-overview/diagrams/system-context-l2",
    watches: [
      ...watches, "infra/modules/messaging/**", "infra/modules/lambda/**", "infra/modules/api-gateway-ws/**", "infra/modules/dynamodb/**",
      "infra/modules/ecr/**", "infra/modules/app-config/**", "infra/modules/ecs-service/**", "infra/modules/assets-bucket/**",
      "infra/modules/rds-aurora/**", "infra/environments/preprod/*.tf", "observability/otel-collector-config.yaml",
      "services/users/src/shared/realtime/**",
    ],
    primitive: "aws",
    source: "diagrams/src/data/system-context/l2.ts",
    data: systemContextL2,
  },
];
