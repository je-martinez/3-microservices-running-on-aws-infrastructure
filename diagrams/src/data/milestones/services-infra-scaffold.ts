import type { DependencyData } from "../../schema";

export const servicesInfraScaffoldDeps: DependencyData = {
  title: "Services and Infra Scaffold milestone: task dependencies",
  phases: [
    { id: "scaffolds", label: "Service scaffolds" },
    { id: "orchestration", label: "Orchestration" },
    { id: "infra", label: "Infrastructure" },
    { id: "tooling", label: "Tooling" },
  ],
  tasks: [
    { id: "JE-17", label: "Users scaffold", phase: "scaffolds" },
    { id: "JE-18", label: "Orders scaffold", phase: "scaffolds" },
    { id: "JE-19", label: "Tracking scaffold", phase: "scaffolds" },
    { id: "JE-20", label: "events-pipeline scaffold", phase: "scaffolds" },
    { id: "JE-22", label: "root docker-compose", phase: "orchestration" },
    { id: "JE-21", label: "infra scaffold", phase: "infra" },
    { id: "JE-23", label: "skill discovery", phase: "tooling" },
    { id: "JE-24", label: "install + preload skills", phase: "tooling" },
  ],
  deps: [
    { from: "JE-17", to: "JE-22" },
    { from: "JE-18", to: "JE-22" },
    { from: "JE-19", to: "JE-22" },
    { from: "JE-20", to: "JE-22" },
    { from: "JE-23", to: "JE-24" },
  ],
};
