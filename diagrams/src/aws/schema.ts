import { z } from "zod";
import { AwsService } from "../schema";

export const GroupKind = z.enum([
  "aws-cloud", "region", "az", "vpc", "public-subnet", "private-subnet",
  "account", "generic", "corporate", "local-floci", "phase",
]);
export type GroupKind = z.infer<typeof GroupKind>;

export const GenericIcon = z.enum(["users", "client", "internet", "server", "office-building", "firewall", "data-table"]);
export type GenericIcon = z.infer<typeof GenericIcon>;

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$|^JE-\d+$/);

export const NodeIcon = z.union([AwsService, GenericIcon, z.literal("task")]);
export type NodeIcon = z.infer<typeof NodeIcon>;

export const AwsDiagramData = z
  .object({
    title: z.string().min(1).max(70),
    subtitle: z.string().max(110).optional(),
    direction: z.enum(["RIGHT", "DOWN"]).default("RIGHT"),
    groups: z.array(z.object({ id: Id, kind: GroupKind, label: z.string().min(1).max(40), parent: Id.optional() })).max(16),
    nodes: z
      .array(z.object({ id: Id, label: z.string().min(1).max(32), sublabel: z.string().max(32).optional(), icon: NodeIcon, group: Id.optional() }))
      .max(24),
    edges: z.array(z.object({ id: Id, from: Id, to: Id, label: z.string().max(24).optional(), async: z.boolean().optional() })).max(30),
    steps: z.array(z.object({ edges: z.array(Id).min(1), caption: z.string().min(1).max(90) })).max(10).default([]),
  })
  .superRefine((d, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    const seen = new Set<string>();
    for (const id of [...d.groups.map((g) => g.id), ...d.nodes.map((n) => n.id)]) {
      if (seen.has(id)) fail(`duplicate id "${id}"`);
      seen.add(id);
    }
    const groups = new Map(d.groups.map((g) => [g.id, g]));
    for (const g of d.groups) {
      if (g.parent && !groups.has(g.parent)) fail(`unknown group "${g.parent}"`);
      const path = new Set<string>();
      for (let cur: string | undefined = g.id; cur; cur = groups.get(cur)?.parent) {
        if (path.has(cur)) { fail(`group cycle at "${g.id}"`); break; }
        path.add(cur);
      }
    }
    const nodes = new Set(d.nodes.map((n) => n.id));
    for (const n of d.nodes) if (n.group && !groups.has(n.group)) fail(`unknown group "${n.group}"`);
    const edges = new Set(d.edges.map((e) => e.id));
    for (const e of d.edges) for (const id of [e.from, e.to]) if (!nodes.has(id)) fail(`unknown node "${id}"`);
    for (const s of d.steps) for (const id of s.edges) if (!edges.has(id)) fail(`unknown edge "${id}"`);
  });
export type AwsDiagramData = z.infer<typeof AwsDiagramData>;
