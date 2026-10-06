import type { CatalogEntry } from "../catalog";
import { documentationVaultDeps } from "./milestones/documentation-vault";
import { servicesInfraScaffoldDeps } from "./milestones/services-infra-scaffold";
import { usersServiceDeps } from "./milestones/users-service";

export const milestoneEntries: CatalogEntry[] = [
  {
    id: "milestone-users-service-deps",
    title: "Users Service milestone dependencies",
    primitive: "dependency",
    animated: false,
    output: "docs/plans/diagrams/users-service-deps",
    watches: ["docs/plans/users-service-milestone.md"],
    data: usersServiceDeps,
  },
  {
    id: "milestone-services-infra-scaffold-deps",
    title: "Services and Infra Scaffold milestone dependencies",
    primitive: "dependency",
    animated: false,
    output: "docs/plans/diagrams/services-infra-scaffold-deps",
    watches: ["docs/plans/services-infra-scaffold-milestone.md"],
    data: servicesInfraScaffoldDeps,
  },
  {
    id: "milestone-documentation-vault-deps",
    title: "Documentation Vault milestone dependencies",
    primitive: "dependency",
    animated: false,
    output: "docs/plans/diagrams/documentation-vault-deps",
    watches: ["docs/plans/documentation-vault-milestone.md"],
    data: documentationVaultDeps,
  },
];
