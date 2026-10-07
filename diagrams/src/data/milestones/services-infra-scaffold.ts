import type { z } from "zod";
import type { AwsDiagramData } from "../../aws/schema";

export const servicesInfraScaffoldDeps: z.input<typeof AwsDiagramData> = {
  title: "Services and Infra Scaffold milestone: task dependencies",
  direction: "RIGHT",
  groups: [
    { id: "scaffolds", kind: "phase", label: "Service scaffolds" },
    { id: "orchestration", kind: "phase", label: "Orchestration" },
    { id: "infra", kind: "phase", label: "Infrastructure" },
    { id: "tooling", kind: "phase", label: "Tooling" },
  ],
  nodes: [
    { id: "JE-17", label: "Users scaffold", icon: "task", group: "scaffolds" },
    { id: "JE-18", label: "Orders scaffold", icon: "task", group: "scaffolds" },
    { id: "JE-19", label: "Tracking scaffold", icon: "task", group: "scaffolds" },
    { id: "JE-20", label: "events-pipeline scaffold", icon: "task", group: "scaffolds" },
    { id: "JE-22", label: "root docker-compose", icon: "task", group: "orchestration" },
    { id: "JE-21", label: "infra scaffold", icon: "task", group: "infra" },
    { id: "JE-23", label: "skill discovery", icon: "task", group: "tooling" },
    { id: "JE-24", label: "install + preload skills", icon: "task", group: "tooling" },
  ],
  edges: [
    { id: "e-je-17-je-22", from: "JE-17", to: "JE-22" },
    { id: "e-je-18-je-22", from: "JE-18", to: "JE-22" },
    { id: "e-je-19-je-22", from: "JE-19", to: "JE-22" },
    { id: "e-je-20-je-22", from: "JE-20", to: "JE-22" },
    { id: "e-je-23-je-24", from: "JE-23", to: "JE-24" },
  ],
};
