import { z } from "zod";

export const NodeKind = z.enum(["compute", "data", "messaging", "edge", "external"]);
export type NodeKind = z.infer<typeof NodeKind>;

export const AwsService = z.enum([
  "api-gateway", "aurora", "rds", "cognito", "documentdb", "dynamodb", "elasticache",
  "eventbridge", "sqs", "sns", "ses", "s3", "ecr", "ecs", "fargate", "elb", "lambda",
  "cloudwatch", "secrets-manager", "ssm", "iam", "vpc",
]);
export type AwsService = z.infer<typeof AwsService>;

const Id = z.string().regex(/^[a-z0-9][a-z0-9-]*$|^JE-\d+$/);
const Label = z.string().min(1).max(22);

const Box = z.object({ id: Id, label: Label, kind: NodeKind, aws: AwsService.optional() });

function unknown(ctx: z.RefinementCtx, what: string, id: string) {
  ctx.addIssue({ code: "custom", message: `unknown ${what} "${id}"` });
}

// WHY the 18-node cap here (vs ~12 elsewhere): a whole-environment map groups services
// by zone and cannot stay legible below that; flows and context diagrams keep the ~12 guidance.
export const ArchitectureData = z
  .object({
    title: z.string().max(60),
    subtitle: z.string().max(90).optional(),
    zones: z.array(z.object({ id: Id, label: Label })).min(1).max(5),
    nodes: z.array(Box.extend({ zone: Id })).min(1).max(18),
    edges: z.array(z.object({ from: Id, to: Id, label: z.string().max(18).optional() })).max(24),
  })
  .superRefine((d, ctx) => {
    const zones = new Set(d.zones.map((z) => z.id));
    const nodes = new Set(d.nodes.map((n) => n.id));
    for (const n of d.nodes) if (!zones.has(n.zone)) unknown(ctx, "zone", n.zone);
    for (const e of d.edges) for (const id of [e.from, e.to]) if (!nodes.has(id)) unknown(ctx, "node", id);
  });
export type ArchitectureData = z.infer<typeof ArchitectureData>;

export const FlowData = z
  .object({
    title: z.string().max(60),
    subtitle: z.string().max(90).optional(),
    actors: z.array(Box).min(2).max(7),
    steps: z
      .array(
        z.object({
          from: Id,
          to: Id,
          label: z.string().min(1).max(28),
          caption: z.string().min(1).max(90),
          async: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(10),
  })
  .superRefine((d, ctx) => {
    const actors = new Set(d.actors.map((a) => a.id));
    for (const s of d.steps) for (const id of [s.from, s.to]) if (!actors.has(id)) unknown(ctx, "actor", id);
  });
export type FlowData = z.infer<typeof FlowData>;

export const DependencyData = z
  .object({
    title: z.string().max(60),
    phases: z.array(z.object({ id: Id, label: Label })).min(1).max(6),
    tasks: z.array(z.object({ id: Id, label: z.string().min(1).max(30), phase: Id })).min(1).max(24),
    deps: z.array(z.object({ from: Id, to: Id })),
  })
  .superRefine((d, ctx) => {
    const phases = new Set(d.phases.map((p) => p.id));
    const tasks = new Set(d.tasks.map((t) => t.id));
    for (const t of d.tasks) if (!phases.has(t.phase)) unknown(ctx, "phase", t.phase);
    for (const e of d.deps) for (const id of [e.from, e.to]) if (!tasks.has(id)) unknown(ctx, "task", id);
  });
export type DependencyData = z.infer<typeof DependencyData>;
