import { z } from "zod";

export const AwsService = z.enum([
  "api-gateway", "aurora", "rds", "cognito", "documentdb", "dynamodb", "elasticache",
  "eventbridge", "sqs", "sns", "ses", "s3", "ecr", "ecs", "fargate", "elb", "lambda",
  "cloudwatch", "secrets-manager", "ssm", "iam", "vpc",
]);
export type AwsService = z.infer<typeof AwsService>;

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
    // CONTRACT: `from`/`to` name a node or a group; a group endpoint draws one connection from its frame.
    edges: z.array(z.object({ id: Id, from: Id, to: Id, label: z.string().max(24).optional(), async: z.boolean().optional() })).max(30),
    steps: z.array(z.object({ edges: z.array(Id).min(1), caption: z.string().min(1).max(90) })).max(10).default([]),
  })
  .superRefine((d, ctx) => {
    const fail = (message: string, path: (string | number)[]) => ctx.addIssue({ code: "custom", message, path });
    const seen = new Set<string>();
    d.groups.forEach((g, i) => {
      if (seen.has(g.id)) fail(`duplicate id "${g.id}"`, ["groups", i]);
      seen.add(g.id);
    });
    d.nodes.forEach((n, i) => {
      if (seen.has(n.id)) fail(`duplicate id "${n.id}"`, ["nodes", i]);
      seen.add(n.id);
    });
    const groups = new Map(d.groups.map((g) => [g.id, g]));
    d.groups.forEach((g, i) => {
      if (g.parent && !groups.has(g.parent)) fail(`unknown group "${g.parent}"`, ["groups", i]);
      const path = new Set<string>();
      for (let cur: string | undefined = g.id; cur; cur = groups.get(cur)?.parent) {
        if (path.has(cur)) { fail(`group cycle at "${g.id}"`, ["groups", i]); break; }
        path.add(cur);
      }
    });
    const nodes = new Set(d.nodes.map((n) => n.id));
    d.nodes.forEach((n, i) => { if (n.group && !groups.has(n.group)) fail(`unknown group "${n.group}"`, ["nodes", i]); });
    const nodeGroup = new Map(d.nodes.flatMap((n) => (n.group ? [[n.id, n.group] as const] : [])));
    const edges = new Set<string>();
    d.edges.forEach((e, i) => {
      if (edges.has(e.id)) fail(`duplicate edge id "${e.id}"`, ["edges", i]);
      edges.add(e.id);
      for (const id of [e.from, e.to]) if (!nodes.has(id) && !groups.has(id)) fail(`unknown node or group "${id}"`, ["edges", i]);
      const within = (inner: string, outer: string) => {
        let cur = nodeGroup.get(inner) ?? (groups.has(inner) ? inner : undefined);
        for (let hops = 0; cur && hops <= d.groups.length; hops++, cur = groups.get(cur)?.parent) if (cur === outer) return true;
        return false;
      };
      const contains = (g: string, other: string) => groups.has(g) && within(other, g);
      if (contains(e.from, e.to) || contains(e.to, e.from)) fail(`edge "${e.id}" connects a group to itself or its own content`, ["edges", i]);
    });
    d.steps.forEach((s, i) => { for (const id of s.edges) if (!edges.has(id)) fail(`unknown edge "${id}"`, ["steps", i]); });
  });
export type AwsDiagramData = z.infer<typeof AwsDiagramData>;
