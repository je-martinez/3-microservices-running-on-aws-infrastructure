import type { CatalogEntry } from "../catalog";
import { architectureDevFloci } from "./architecture/dev-floci";
import { architecturePreprod } from "./architecture/preprod";

export const architectureEntries: CatalogEntry[] = [
  {
    id: "architecture-dev-floci",
    title: architectureDevFloci.title,
    output: "docs/00-overview/diagrams/architecture-dev-floci",
    watches: ["infra/modules/**", "infra/environments/local/**", "docker-compose.yml"],
    primitive: "architecture",
    data: architectureDevFloci,
  },
  {
    id: "architecture-preprod",
    title: architecturePreprod.title,
    output: "docs/00-overview/diagrams/architecture-preprod",
    watches: ["infra/modules/**", "infra/environments/preprod/**", "docker-compose.preprod.yml"],
    primitive: "architecture",
    data: architecturePreprod,
  },
];
