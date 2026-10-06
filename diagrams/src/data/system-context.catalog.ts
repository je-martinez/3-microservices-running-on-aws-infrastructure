import type { CatalogEntry } from "../catalog";
import { systemContextL1 } from "./system-context/l1";
import { systemContextL2 } from "./system-context/l2";

const watches = ["infra/modules/api-gateway/**", "infra/modules/cognito/**", "services/*/openapi.yaml"];

export const systemContextEntries: CatalogEntry[] = [
  {
    id: "system-context-l1",
    title: systemContextL1.title,
    output: "docs/00-overview/diagrams/system-context-l1",
    watches,
    primitive: "architecture",
    data: systemContextL1,
  },
  {
    id: "system-context-l2",
    title: systemContextL2.title,
    output: "docs/00-overview/diagrams/system-context-l2",
    watches: [...watches, "infra/modules/messaging/**", "infra/modules/lambda/**"],
    primitive: "architecture",
    data: systemContextL2,
  },
];
