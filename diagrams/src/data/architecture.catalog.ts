import type { CatalogEntry } from "../catalog";
import { architectureDevFloci } from "./architecture/dev-floci";
import { architectureDevFlociEvents } from "./architecture/dev-floci-events";
import { architecturePreprod } from "./architecture/preprod";
import { architecturePreprodEvents } from "./architecture/preprod-events";

const devWatches = ["infra/modules/**", "infra/environments/local/**", "docker-compose.yml", "observability/otel-collector-config.yaml", "services/users/src/shared/realtime/**"];
const preprodWatches = ["infra/modules/**", "infra/environments/preprod/**", "docker-compose.preprod.yml", "observability/otel-collector-config.yaml", "services/users/src/shared/realtime/**"];

export const architectureEntries: CatalogEntry[] = [
  {
    id: "architecture-dev-floci",
    title: architectureDevFloci.title,
    output: "docs/00-overview/diagrams/architecture-dev-floci",
    watches: devWatches,
    primitive: "aws",
    source: "diagrams/src/data/architecture/dev-floci.ts",
    data: architectureDevFloci,
  },
  {
    id: "architecture-dev-floci-events",
    title: architectureDevFlociEvents.title,
    output: "docs/00-overview/diagrams/architecture-dev-floci-events",
    watches: devWatches,
    primitive: "aws",
    source: "diagrams/src/data/architecture/dev-floci-events.ts",
    data: architectureDevFlociEvents,
  },
  {
    id: "architecture-preprod",
    title: architecturePreprod.title,
    output: "docs/00-overview/diagrams/architecture-preprod",
    watches: preprodWatches,
    primitive: "aws",
    source: "diagrams/src/data/architecture/preprod.ts",
    data: architecturePreprod,
  },
  {
    id: "architecture-preprod-events",
    title: architecturePreprodEvents.title,
    output: "docs/00-overview/diagrams/architecture-preprod-events",
    watches: preprodWatches,
    primitive: "aws",
    source: "diagrams/src/data/architecture/preprod-events.ts",
    data: architecturePreprodEvents,
  },
];
