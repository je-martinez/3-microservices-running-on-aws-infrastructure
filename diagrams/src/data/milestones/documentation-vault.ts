import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

export const documentationVaultDeps: z.input<typeof AwsDiagramData> = {
  title: "Documentation Vault milestone: task dependencies",
  direction: "RIGHT",
  groups: [
    { id: "foundations", kind: "phase", label: "Foundations" },
    { id: "shared", kind: "phase", label: "Shared base" },
    { id: "specs", kind: "phase", label: "Service specs" },
    { id: "overview", kind: "phase", label: "Overview" },
    { id: "bases", kind: "phase", label: "Bases" },
  ],
  nodes: [
    { id: "JE-5", label: "folder skeleton + validator", icon: "task", group: "foundations" },
    { id: "JE-6", label: "note templates", icon: "task", group: "foundations" },
    { id: "JE-7", label: "conventions + patterns", icon: "task", group: "shared" },
    { id: "JE-8", label: "ADRs 0001-0015", icon: "task", group: "shared" },
    { id: "JE-9", label: "Users spec", icon: "task", group: "specs" },
    { id: "JE-10", label: "Orders spec", icon: "task", group: "specs" },
    { id: "JE-11", label: "Tracking spec", icon: "task", group: "specs" },
    { id: "JE-12", label: "Events pipeline spec", icon: "task", group: "specs" },
    { id: "JE-13", label: "infra specs + runbooks", icon: "task", group: "specs" },
    { id: "JE-14", label: "overview MOC", icon: "task", group: "overview" },
    { id: "JE-15", label: "Obsidian Bases", icon: "task", group: "bases" },
  ],
  edges: [
    { id: "e-je-5-je-6", from: "JE-5", to: "JE-6" },
    { id: "e-je-6-je-7", from: "JE-6", to: "JE-7" },
    { id: "e-je-7-je-8", from: "JE-7", to: "JE-8" },
    { id: "e-je-6-je-9", from: "JE-6", to: "JE-9" },
    { id: "e-je-6-je-10", from: "JE-6", to: "JE-10" },
    { id: "e-je-6-je-11", from: "JE-6", to: "JE-11" },
    { id: "e-je-6-je-12", from: "JE-6", to: "JE-12" },
    { id: "e-je-6-je-13", from: "JE-6", to: "JE-13" },
    { id: "e-je-9-je-14", from: "JE-9", to: "JE-14" },
    { id: "e-je-10-je-14", from: "JE-10", to: "JE-14" },
    { id: "e-je-11-je-14", from: "JE-11", to: "JE-14" },
    { id: "e-je-12-je-14", from: "JE-12", to: "JE-14" },
    { id: "e-je-13-je-14", from: "JE-13", to: "JE-14" },
    { id: "e-je-14-je-15", from: "JE-14", to: "JE-15" },
  ],
};
