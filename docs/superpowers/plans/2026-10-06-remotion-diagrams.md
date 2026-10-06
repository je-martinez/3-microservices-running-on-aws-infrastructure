---
title: "Remotion Diagrams Implementation Plan"
type: plan
area: shared
status: active
created: 2026-10-06
updated: 2026-10-06
tags:
  - type/plan
  - area/shared
  - status/active
propagates-to:
  - "[[git-workflow]]"
  - "[[milestone-plan]]"
  - "[[architecture]]"
  - "[[system-context]]"
  - "[[index]]"
  - "[[mcp-servers]]"
  - "[[scripting-language]]"
  - "[[drawio-diagram-legibility]]"
  - "[[ADR-0015-drawio-diagrams]]"
related:
  - "[[2026-10-06-remotion-diagrams-design]]"
  - "[[ADR-0015-drawio-diagrams]]"
  - "[[drawio-diagram-legibility]]"
  - "[[skill-propagation]]"
  - "[[doc-propagation]]"
---

# Remotion Diagrams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace draw.io with a data-driven Remotion package that renders 26 animated (GIF) and static (PNG) diagrams of the system's flows and AWS architecture, with an implementer agent, drift detection, and the conventions that keep diagrams current.

**Architecture:** A new pnpm workspace package `diagrams/` (`@3mrai/diagrams`). Three generic primitives (`ArchitectureMap`, `FlowSequence`, `DependencyGraph`) render typed, zod-validated data files; `src/catalog.ts` lists every diagram with its output path and the source globs it `watches`. `render.ts` writes GIF + last-frame PNG into the vault; `check-drift.ts` intersects the branch diff with `watches` and warns. AWS icons come from `@nxavis/aws-icons` behind one adapter file.

**Tech Stack:** Remotion 4.0.533 (`remotion`, `@remotion/cli`, `@remotion/bundler`, `@remotion/renderer`, `@remotion/google-fonts`, all pinned to the same exact version), React 19, zod 4.5.4, `@nxavis/aws-icons` 0.0.5 (exact), picomatch, tsx, vitest 4, TypeScript ~6.0.3.

**Spec:** `docs/superpowers/specs/2026-10-06-remotion-diagrams-design.md`

## Global Constraints

- pnpm only (`pnpm add`, `pnpm --filter @3mrai/diagrams …`, `pnpm dlx`); never `npm`/`npx`. Run `nvm use` before any Node command.
- All `remotion` / `@remotion/*` packages pinned to the **same exact** version (`4.0.533`, no caret). `@nxavis/aws-icons` pinned exact (`-E`).
- Only `diagrams/src/theme/aws-icons.ts` may import `@nxavis/aws-icons`.
- Outputs: GIF + last-frame PNG (milestone `DependencyGraph` entries: PNG only). ~12 fps GIF, ≤ ~1200px wide, target ≤ ~2 MB per GIF. No MP4, no web player, no blocking CI gate.
- Detail level: ≤ ~12 nodes per diagram, ≤ ~10 steps per flow, one-line caption per step; service/resource names only — never endpoints, fields or payloads. Content is read from real code/Terraform, never invented.
- Dispatched agents never run git writes; the main session commits through the A/B/C/D/E `AskUserQuestion` menu. Every "Commit" step below means: main session presents the menu.
- Only `obsidian-vault` edits `.md` files under `docs/`. `diagram-impl` (and any worker rendering) writes only `diagrams/**` and `docs/**/diagrams/*.{gif,png}`.
- Code comments follow `[[code-comments]]`: five tags, present tense, run `python3 scripts/validate-comments.py <files>` on everything touched.
- Vault content in English; conversation with the user in Spanish.

## Review Focus

- **A watch glob that matches nothing** (typo, renamed directory) silently disables drift detection for that diagram → `catalog.test.ts` asserts every glob matches ≥1 tracked file (Task 1/2).
- **An edge or step that references an unknown node/actor id** renders an arrow to nowhere with no error → schema `superRefine` rejects it (Task 1).
- **Two catalog entries with the same `id` or `output`** — Remotion registers one composition, the other render overwrites a file → catalog test asserts uniqueness (Task 1).
- **A diff that touches only the diagram's own renders/data** must not be reported as stale; a diff that touches watched source AND the render reports "updated", not "stale" (Task 2).
- **Long labels overflow their box/lane** and get clipped — invisible to tests → schema `max()` on label/caption lengths plus mandatory visual PNG inspection (Tasks 1, 4–6, 10–16).

---

## File Structure

```
diagrams/
  package.json, tsconfig.json, remotion.config.ts, vitest.config.ts, CLAUDE.md, .gitignore
  src/
    index.ts                     registerRoot(Root)
    Root.tsx                     one <Composition> per catalog entry
    catalog.ts                   CatalogEntry[] (source of truth)
    schema.ts                    zod schemas + inferred types for all three primitives
    timing.ts                    FPS, size, per-primitive duration helpers (pure)
    theme/tokens.ts              colours per node kind, typography, sizes
    theme/aws-icons.ts           AwsService → icon component (ONLY importer of @nxavis/aws-icons)
    primitives/shared/{NodeBox,Arrow,Title,Legend,Caption}.tsx
    primitives/layout.ts         pure layout functions for all primitives
    primitives/{ArchitectureMap,FlowSequence,DependencyGraph}.tsx
    data/architecture/*.ts, data/system-context/*.ts, data/flows/*.ts, data/milestones/*.ts
    scripts/drift.ts             pure: affectedDiagrams()
    scripts/check-drift.ts       CLI around drift.ts
    scripts/render.ts            CLI: bundle once, render GIF/PNG per entry
  test/{schema,catalog,drift,layout,aws-icons}.test.ts
```

---

### Task 1: Package scaffold, schemas, empty catalog

**Files:**
- Create: `diagrams/package.json`, `diagrams/tsconfig.json`, `diagrams/remotion.config.ts`, `diagrams/vitest.config.ts`, `diagrams/.gitignore`, `diagrams/src/schema.ts`, `diagrams/src/catalog.ts`, `diagrams/test/schema.test.ts`, `diagrams/test/catalog.test.ts`
- Modify: `pnpm-workspace.yaml` (add `- "diagrams"`), root `package.json` (add `diagrams:*` scripts)

**Interfaces:**
- Produces: `NodeKind`, `AwsService`, `ArchitectureData`, `FlowData`, `DependencyData` (zod schemas + `z.infer` types), `CatalogEntry`, `catalog: CatalogEntry[]`.

- [ ] **Step 1: Create `diagrams/package.json`**

```json
{
  "name": "@3mrai/diagrams",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "description": "Remotion-rendered animated diagrams of 3MRAI flows and architecture",
  "scripts": {
    "studio": "remotion studio src/index.ts",
    "render": "tsx src/scripts/render.ts",
    "check-drift": "tsx src/scripts/check-drift.ts",
    "browser": "remotion browser ensure",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

- [ ] **Step 2: Register the workspace and install pinned dependencies**

Add `  - "diagrams"` to `pnpm-workspace.yaml` `packages:`. Then:

```bash
nvm use
pnpm --filter @3mrai/diagrams add -E remotion@4.0.533 @remotion/cli@4.0.533 @remotion/bundler@4.0.533 @remotion/renderer@4.0.533 @remotion/google-fonts@4.0.533 @nxavis/aws-icons@0.0.5 zod@4.5.4 react@19 react-dom@19 picomatch@4
pnpm --filter @3mrai/diagrams add -D -E typescript@6.0.3 vitest@4 tsx@4 @types/react@19 @types/react-dom@19 @types/picomatch@4 @types/node@24
```

Expected: `pnpm-lock.yaml` updated, no `package-lock.json` created. Verify every `remotion`/`@remotion/*` entry in `diagrams/package.json` reads exactly `4.0.533`.

- [ ] **Step 3: Create `tsconfig.json`, `remotion.config.ts`, `vitest.config.ts`, `.gitignore`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test", "remotion.config.ts", "vitest.config.ts"]
}
```

```ts
// diagrams/remotion.config.ts
import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("png");
Config.setOverwriteOutput(true);
```

```ts
// diagrams/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
```

```
# diagrams/.gitignore
out/
```

- [ ] **Step 4: Write the failing schema test** — `diagrams/test/schema.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { ArchitectureData, DependencyData, FlowData } from "../src/schema";

const arch = {
  title: "Demo",
  zones: [{ id: "edge", label: "Edge" }, { id: "core", label: "Core" }],
  nodes: [
    { id: "gw", label: "API Gateway", kind: "edge", aws: "api-gateway", zone: "edge" },
    { id: "users", label: "Users", kind: "compute", aws: "ecs", zone: "core" },
  ],
  edges: [{ from: "gw", to: "users", label: "HTTP" }],
};

describe("ArchitectureData", () => {
  it("accepts a valid map", () => {
    expect(ArchitectureData.parse(arch).nodes).toHaveLength(2);
  });
  it("rejects an edge to an unknown node", () => {
    const bad = { ...arch, edges: [{ from: "gw", to: "ghost" }] };
    expect(() => ArchitectureData.parse(bad)).toThrow(/unknown node "ghost"/);
  });
  it("rejects a node in an unknown zone", () => {
    const bad = { ...arch, nodes: [{ ...arch.nodes[0], zone: "nowhere" }, arch.nodes[1]] };
    expect(() => ArchitectureData.parse(bad)).toThrow(/unknown zone "nowhere"/);
  });
  it("rejects a label longer than 22 chars", () => {
    const bad = { ...arch, nodes: [{ ...arch.nodes[0], label: "x".repeat(23) }, arch.nodes[1]] };
    expect(() => ArchitectureData.parse(bad)).toThrow();
  });
});

describe("FlowData", () => {
  const flow = {
    title: "Sign-up",
    actors: [
      { id: "web", label: "Web", kind: "external" },
      { id: "users", label: "Users", kind: "compute", aws: "ecs" },
    ],
    steps: [{ from: "web", to: "users", label: "sign up", caption: "The browser submits the form." }],
  };
  it("accepts a valid flow", () => {
    expect(FlowData.parse(flow).steps).toHaveLength(1);
  });
  it("rejects more than 10 steps", () => {
    const bad = { ...flow, steps: Array.from({ length: 11 }, () => flow.steps[0]) };
    expect(() => FlowData.parse(bad)).toThrow();
  });
  it("rejects a step from an unknown actor", () => {
    const bad = { ...flow, steps: [{ ...flow.steps[0], from: "ghost" }] };
    expect(() => FlowData.parse(bad)).toThrow(/unknown actor "ghost"/);
  });
});

describe("DependencyData", () => {
  it("rejects a dependency on an unknown task", () => {
    const bad = {
      title: "M",
      phases: [{ id: "p1", label: "Phase 1" }],
      tasks: [{ id: "JE-1", label: "Scaffold", phase: "p1" }],
      deps: [{ from: "JE-0", to: "JE-1" }],
    };
    expect(() => DependencyData.parse(bad)).toThrow(/unknown task "JE-0"/);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `nvm use && pnpm --filter @3mrai/diagrams test`
Expected: FAIL — `Cannot find module '../src/schema'`.

- [ ] **Step 6: Implement `diagrams/src/schema.ts`**

```ts
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
```

WHY the 18-node cap on `ArchitectureData` (vs ~12 elsewhere): a whole-environment map groups services by zone and cannot stay legible below that; flows and context diagrams keep the ~12 guidance.

- [ ] **Step 7: Run schema tests** — `pnpm --filter @3mrai/diagrams test` → PASS (8 tests).

- [ ] **Step 8: Write the failing catalog test** — `diagrams/test/catalog.test.ts`

```ts
import { execFileSync } from "node:child_process";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import { catalog } from "../src/catalog";
import { ArchitectureData, DependencyData, FlowData } from "../src/schema";

const repoRoot = new URL("../../", import.meta.url).pathname;
const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" }).split("\n");
const schemas = { architecture: ArchitectureData, flow: FlowData, dependency: DependencyData };

describe("catalog", () => {
  it("has unique ids and outputs", () => {
    expect(new Set(catalog.map((e) => e.id)).size).toBe(catalog.length);
    expect(new Set(catalog.map((e) => e.output)).size).toBe(catalog.length);
  });
  it.each(catalog.map((e) => [e.id, e] as const))("%s data matches its primitive schema", (_id, e) => {
    expect(() => schemas[e.primitive].parse(e.data)).not.toThrow();
  });
  it.each(catalog.map((e) => [e.id, e] as const))("%s: every watch glob matches a tracked file", (_id, e) => {
    for (const glob of e.watches) {
      expect(tracked.some(picomatch(glob)), `glob "${glob}" matches nothing`).toBe(true);
    }
  });
  it.each(catalog.map((e) => [e.id, e] as const))("%s output lives in a docs diagrams/ folder", (_id, e) => {
    expect(e.output).toMatch(/^docs\/.+\/diagrams\/[a-z0-9-]+$/);
  });
});
```

- [ ] **Step 9: Implement `diagrams/src/catalog.ts` (empty, typed)**

```ts
import type { ArchitectureData, DependencyData, FlowData } from "./schema";

type Base = {
  id: string;
  title: string;
  /** Repo-relative path WITHOUT extension; render.ts appends .gif / .png. */
  output: string;
  /** Repo-relative globs whose change may make this diagram stale. */
  watches: string[];
};

export type CatalogEntry =
  | (Base & { primitive: "architecture"; data: ArchitectureData })
  | (Base & { primitive: "flow"; data: FlowData })
  | (Base & { primitive: "dependency"; data: DependencyData });

export const catalog: CatalogEntry[] = [];
```

- [ ] **Step 10: Run all tests + typecheck**

Run: `pnpm --filter @3mrai/diagrams test && pnpm --filter @3mrai/diagrams typecheck`
Expected: PASS (catalog `it.each` over an empty array yields zero cases; the uniqueness test passes).

- [ ] **Step 11: Root scripts** — add to root `package.json` `scripts`:

```json
"diagrams:studio": "pnpm --filter @3mrai/diagrams studio",
"diagrams:render": "pnpm --filter @3mrai/diagrams render",
"diagrams:check": "pnpm --filter @3mrai/diagrams check-drift",
"diagrams:test": "pnpm --filter @3mrai/diagrams test"
```

- [ ] **Step 12: Commit** (main session, menu) — `build(diagrams): scaffold Remotion diagrams package with data schemas`

---

### Task 2: Drift detection (`diagrams-check`)

**Files:**
- Create: `diagrams/src/scripts/drift.ts`, `diagrams/src/scripts/check-drift.ts`, `diagrams/test/drift.test.ts`
- Modify: `Makefile` (target `diagrams-check`, add to `.PHONY`)

**Interfaces:**
- Consumes: `CatalogEntry`, `catalog` (Task 1).
- Produces: `affectedDiagrams(changed: string[], entries: Pick<CatalogEntry,"id"|"output"|"watches">[]): DriftResult[]` where `type DriftResult = { id: string; status: "stale" | "updated"; matches: string[] }`.

- [ ] **Step 1: Write the failing test** — `diagrams/test/drift.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { affectedDiagrams } from "../src/scripts/drift";

const entries = [
  { id: "arch", output: "docs/00-overview/diagrams/arch", watches: ["infra/modules/**", "docker-compose.yml"] },
  { id: "otp", output: "docs/domains/users/specs/diagrams/otp", watches: ["infra/modules/cognito/**"] },
];

describe("affectedDiagrams", () => {
  it("returns nothing when no watched path changed", () => {
    expect(affectedDiagrams(["README.md"], entries)).toEqual([]);
  });
  it("flags every entry whose globs match, as stale, listing the matching paths", () => {
    expect(affectedDiagrams(["infra/modules/cognito/main.tf"], entries)).toEqual([
      { id: "arch", status: "stale", matches: ["infra/modules/cognito/main.tf"] },
      { id: "otp", status: "stale", matches: ["infra/modules/cognito/main.tf"] },
    ]);
  });
  it("reports updated when the render changed alongside the source", () => {
    const r = affectedDiagrams(["docker-compose.yml", "docs/00-overview/diagrams/arch.png"], entries);
    expect(r).toEqual([{ id: "arch", status: "updated", matches: ["docker-compose.yml"] }]);
  });
  it("ignores a diff that touches only the render", () => {
    expect(affectedDiagrams(["docs/00-overview/diagrams/arch.gif"], entries)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run** `pnpm --filter @3mrai/diagrams test -- drift` → FAIL (module not found).

- [ ] **Step 3: Implement `diagrams/src/scripts/drift.ts`**

```ts
import picomatch from "picomatch";
import type { CatalogEntry } from "../catalog";

export type DriftResult = { id: string; status: "stale" | "updated"; matches: string[] };

export function affectedDiagrams(
  changed: string[],
  entries: Pick<CatalogEntry, "id" | "output" | "watches">[],
): DriftResult[] {
  const results: DriftResult[] = [];
  for (const e of entries) {
    const isWatched = picomatch(e.watches);
    const matches = changed.filter((f) => isWatched(f));
    if (matches.length === 0) continue;
    const rendered = changed.some((f) => f === `${e.output}.gif` || f === `${e.output}.png`);
    results.push({ id: e.id, status: rendered ? "updated" : "stale", matches });
  }
  return results;
}
```

- [ ] **Step 4: Run** → PASS (4 tests).

- [ ] **Step 5: Implement the CLI** — `diagrams/src/scripts/check-drift.ts`

```ts
import { execFileSync } from "node:child_process";
import { catalog } from "../catalog";
import { affectedDiagrams } from "./drift";

const repoRoot = new URL("../../../", import.meta.url).pathname;
const base = process.env.DIAGRAMS_BASE ?? "main";
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).split("\n").filter(Boolean);

const mergeBase = git("merge-base", base, "HEAD")[0] ?? base;
// WHY: committed branch changes + uncommitted edits + untracked files, so the check is useful before the first commit too.
const changed = [
  ...new Set([
    ...git("diff", "--name-only", mergeBase, "HEAD"),
    ...git("diff", "--name-only", "HEAD"),
    ...git("ls-files", "--others", "--exclude-standard"),
  ]),
];

const results = affectedDiagrams(changed, catalog);
if (results.length === 0) {
  console.log(`diagrams-check: no diagram watches a path changed since ${base}`);
} else {
  for (const r of results) {
    const mark = r.status === "stale" ? "STALE?  " : "updated ";
    console.log(`${mark} ${r.id}  ← ${r.matches.slice(0, 3).join(", ")}${r.matches.length > 3 ? ", …" : ""}`);
  }
  const stale = results.filter((r) => r.status === "stale").length;
  console.log(`\n${stale} possibly stale. Re-render (make diagrams-render ID=<id>) or justify in the PR. See [[diagrams]].`);
}
```

CONTRACT: always exits 0 — the check warns, it never blocks (spec decision 5).

- [ ] **Step 6: Makefile target** — add `diagrams-check` to `.PHONY` and, in a new `## --- Diagrams ---` section:

```make
diagrams-check: ## List diagrams whose watched sources changed vs main (warns, never fails; DIAGRAMS_BASE=main)
	pnpm --filter @3mrai/diagrams check-drift
```

- [ ] **Step 7: Verify** — `nvm use && make diagrams-check` → prints "no diagram watches a path changed" (catalog still empty). Run `python3 scripts/validate-comments.py diagrams/src/scripts/*.ts Makefile` → clean.

- [ ] **Step 8: Commit** (menu) — `feat(diagrams): add non-blocking drift check against catalog watches`

---

### Task 3: Theme tokens and AWS icon adapter

**Files:**
- Create: `diagrams/src/theme/tokens.ts`, `diagrams/src/theme/aws-icons.ts`, `diagrams/src/timing.ts`, `diagrams/test/aws-icons.test.ts`

**Interfaces:**
- Consumes: `NodeKind`, `AwsService` (Task 1).
- Produces: `tokens` (`tokens.kind[k].{fill,stroke,text}`, `tokens.bg`, `tokens.ink`, `tokens.muted`, `tokens.accent`, `tokens.font`), `awsIcon(service: AwsService): ComponentType<{ size?: number }>`, `WIDTH=1200`, `HEIGHT=675`, `FPS=24`, `INTRO=18`, `STEP=36`, `HOLD=48`, `durationFor(units: number): number`.

- [ ] **Step 1: Failing test** — `diagrams/test/aws-icons.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { AwsService } from "../src/schema";
import { awsIcon } from "../src/theme/aws-icons";

describe("awsIcon", () => {
  it.each(AwsService.options)("maps %s to a component", (s) => {
    expect(awsIcon(s)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run** → FAIL (module not found).

- [ ] **Step 3: Implement `diagrams/src/theme/aws-icons.ts`**

```ts
// CONTRACT: the ONLY importer of @nxavis/aws-icons. Swapping the icon source touches this file alone. See [[diagrams]]
import {
  AmazonApiGateway, AmazonAurora, AmazonCloudWatch, AmazonCognito, AmazonDocumentDb, AmazonDynamoDb,
  AmazonElastiCache, AmazonElasticContainerRegistry, AmazonElasticContainerService, AmazonEventBridge,
  AmazonRds, AmazonSimpleEmailService, AmazonSimpleNotificationService, AmazonSimpleQueueService,
  AmazonSimpleStorageService, AmazonVirtualPrivateCloud, AwsFargate, AwsIdentityAndAccessManagement,
  AwsLambda, AwsSecretsManager, AwsSystemsManager, ElasticLoadBalancing,
} from "@nxavis/aws-icons";
import type { ComponentType } from "react";
import type { AwsService } from "../schema";

const ICONS: Record<AwsService, ComponentType<{ size?: number }>> = {
  "api-gateway": AmazonApiGateway, aurora: AmazonAurora, rds: AmazonRds, cognito: AmazonCognito,
  documentdb: AmazonDocumentDb, dynamodb: AmazonDynamoDb, elasticache: AmazonElastiCache,
  eventbridge: AmazonEventBridge, sqs: AmazonSimpleQueueService, sns: AmazonSimpleNotificationService,
  ses: AmazonSimpleEmailService, s3: AmazonSimpleStorageService, ecr: AmazonElasticContainerRegistry,
  ecs: AmazonElasticContainerService, fargate: AwsFargate, elb: ElasticLoadBalancing, lambda: AwsLambda,
  cloudwatch: AmazonCloudWatch, "secrets-manager": AwsSecretsManager, ssm: AwsSystemsManager,
  iam: AwsIdentityAndAccessManagement, vpc: AmazonVirtualPrivateCloud,
};

export function awsIcon(service: AwsService): ComponentType<{ size?: number }> {
  return ICONS[service];
}
```

- [ ] **Step 4: Implement `diagrams/src/theme/tokens.ts`** — light pastel fills with DARK text (the legibility rule from `[[drawio-diagram-legibility]]`):

```ts
import { loadFont } from "@remotion/google-fonts/Inter";
import type { NodeKind } from "../schema";

const { fontFamily } = loadFont("normal", { weights: ["400", "600", "700"], subsets: ["latin"] });

export const tokens = {
  font: fontFamily,
  bg: "#F8FAFC",
  ink: "#0F172A",
  muted: "#64748B",
  accent: "#E8590C",
  zoneFill: "#EEF2F7",
  zoneStroke: "#CBD5E1",
  kind: {
    compute: { fill: "#FFE8CC", stroke: "#E8590C", text: "#5C2400" },
    data: { fill: "#D3F9D8", stroke: "#2F9E44", text: "#0B3D17" },
    messaging: { fill: "#F3D9FA", stroke: "#AE3EC9", text: "#3D0B4A" },
    edge: { fill: "#D0EBFF", stroke: "#1C7ED6", text: "#0B2E57" },
    external: { fill: "#E9ECEF", stroke: "#495057", text: "#212529" },
  } satisfies Record<NodeKind, { fill: string; stroke: string; text: string }>,
} as const;
```

- [ ] **Step 5: Implement `diagrams/src/timing.ts`**

```ts
export const WIDTH = 1200;
export const HEIGHT = 675;
export const FPS = 24;
/** Frames before the first edge/step lights up. */
export const INTRO = 18;
/** Frames each edge/step owns. */
export const STEP = 36;
/** Frames the finished diagram stays on screen (the PNG is its last frame). */
export const HOLD = 48;

export function durationFor(units: number): number {
  return INTRO + units * STEP + HOLD;
}

/** 0→1 progress of unit `i` at `frame`. */
export function unitProgress(frame: number, i: number): number {
  const start = INTRO + i * STEP;
  return Math.min(1, Math.max(0, (frame - start) / (STEP * 0.6)));
}
```

- [ ] **Step 6: Run** `pnpm --filter @3mrai/diagrams test && pnpm --filter @3mrai/diagrams typecheck` → PASS (22 icon cases). If the `@remotion/google-fonts/Inter` import breaks vitest in node, the test file does not import `tokens.ts`, so it is unaffected.

- [ ] **Step 7: Commit** (menu) — `feat(diagrams): add theme tokens, timing and the AWS icon adapter`

---

### Task 4: Shared components + `ArchitectureMap` + Root/Studio

**Files:**
- Create: `diagrams/src/primitives/layout.ts`, `diagrams/src/primitives/shared/{NodeBox,Arrow,Title,Legend,Caption}.tsx`, `diagrams/src/primitives/ArchitectureMap.tsx`, `diagrams/src/Root.tsx`, `diagrams/src/index.ts`, `diagrams/test/layout.test.ts`
- Modify: `Makefile` (`diagrams-studio`)

**Interfaces:**
- Consumes: schemas, `tokens`, `awsIcon`, timing.
- Produces: `type Rect = { x: number; y: number; w: number; h: number }`; `layoutArchitecture(d: ArchitectureData, w: number, h: number): { zones: Record<string, Rect>; nodes: Record<string, Rect> }`; `edgePoints(a: Rect, b: Rect): { x1: number; y1: number; x2: number; y2: number }`; components `NodeBox`, `Arrow`, `Title`, `Legend`, `Caption`, `ArchitectureMap`; `Root` registering compositions from `catalog`.

- [ ] **Step 1: Failing layout test** — `diagrams/test/layout.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { edgePoints, layoutArchitecture } from "../src/primitives/layout";

const d = {
  title: "T",
  zones: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
  nodes: [
    { id: "n1", label: "N1", kind: "edge" as const, zone: "a" },
    { id: "n2", label: "N2", kind: "compute" as const, zone: "b" },
    { id: "n3", label: "N3", kind: "data" as const, zone: "b" },
  ],
  edges: [],
};

describe("layoutArchitecture", () => {
  const l = layoutArchitecture(d, 1200, 675);
  it("places zones left to right in declaration order", () => {
    expect(l.zones.a!.x).toBeLessThan(l.zones.b!.x);
  });
  it("keeps every node inside its zone and inside the canvas", () => {
    for (const n of d.nodes) {
      const r = l.nodes[n.id]!, z = l.zones[n.zone]!;
      expect(r.x).toBeGreaterThanOrEqual(z.x);
      expect(r.x + r.w).toBeLessThanOrEqual(z.x + z.w);
      expect(r.y + r.h).toBeLessThanOrEqual(675);
    }
  });
  it("stacks nodes of one zone without overlap", () => {
    expect(l.nodes.n2!.y + l.nodes.n2!.h).toBeLessThanOrEqual(l.nodes.n3!.y);
  });
});

describe("edgePoints", () => {
  it("connects facing sides of horizontally separated boxes", () => {
    const p = edgePoints({ x: 0, y: 0, w: 100, h: 40 }, { x: 300, y: 0, w: 100, h: 40 });
    expect(p).toEqual({ x1: 100, y1: 20, x2: 300, y2: 20 });
  });
  it("connects top/bottom for vertically stacked boxes", () => {
    const p = edgePoints({ x: 0, y: 0, w: 100, h: 40 }, { x: 0, y: 200, w: 100, h: 40 });
    expect(p).toEqual({ x1: 50, y1: 40, x2: 50, y2: 200 });
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement `diagrams/src/primitives/layout.ts`** (architecture part; Tasks 5–6 append to it)

```ts
import type { ArchitectureData } from "../schema";

export type Rect = { x: number; y: number; w: number; h: number };

const PAD = 24;
const TOP = 96; // title band
const ZONE_HEADER = 32;
const NODE_H = 56;
const GAP = 14;

export function layoutArchitecture(d: ArchitectureData, w: number, h: number) {
  const zones: Record<string, Rect> = {};
  const nodes: Record<string, Rect> = {};
  const zw = (w - PAD * (d.zones.length + 1)) / d.zones.length;
  d.zones.forEach((z, i) => {
    const zone = { x: PAD + i * (zw + PAD), y: TOP, w: zw, h: h - TOP - PAD };
    zones[z.id] = zone;
    const members = d.nodes.filter((n) => n.zone === z.id);
    const nodeH = Math.min(NODE_H, (zone.h - ZONE_HEADER - GAP * (members.length + 1)) / members.length);
    members.forEach((n, j) => {
      nodes[n.id] = { x: zone.x + GAP, y: zone.y + ZONE_HEADER + GAP + j * (nodeH + GAP), w: zone.w - 2 * GAP, h: nodeH };
    });
  });
  return { zones, nodes };
}

export function edgePoints(a: Rect, b: Rect) {
  const acx = a.x + a.w / 2, acy = a.y + a.h / 2, bcx = b.x + b.w / 2, bcy = b.y + b.h / 2;
  if (Math.abs(bcx - acx) >= Math.abs(bcy - acy)) {
    const right = bcx > acx;
    return { x1: right ? a.x + a.w : a.x, y1: acy, x2: right ? b.x : b.x + b.w, y2: bcy };
  }
  const down = bcy > acy;
  return { x1: acx, y1: down ? a.y + a.h : a.y, x2: bcx, y2: down ? b.y : b.y + b.h };
}
```

- [ ] **Step 4: Run** → PASS (5 layout tests).

- [ ] **Step 5: Shared components**

```tsx
// diagrams/src/primitives/shared/NodeBox.tsx
import type { AwsService, NodeKind } from "../../schema";
import { awsIcon } from "../../theme/aws-icons";
import { tokens } from "../../theme/tokens";
import type { Rect } from "../layout";

export function NodeBox(props: Rect & { label: string; kind: NodeKind; aws?: AwsService; opacity?: number; highlight?: boolean }) {
  const c = tokens.kind[props.kind];
  const Icon = props.aws ? awsIcon(props.aws) : null;
  const icon = Math.min(36, props.h - 16);
  return (
    <div
      style={{
        position: "absolute", left: props.x, top: props.y, width: props.w, height: props.h,
        background: c.fill, border: `2px solid ${props.highlight ? tokens.accent : c.stroke}`, borderRadius: 10,
        display: "flex", alignItems: "center", gap: 10, padding: "0 12px", boxSizing: "border-box",
        color: c.text, fontFamily: tokens.font, fontWeight: 600, fontSize: 18, opacity: props.opacity ?? 1,
        boxShadow: props.highlight ? `0 0 0 4px ${tokens.accent}33` : "none",
      }}
    >
      {Icon ? <Icon size={icon} /> : null}
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{props.label}</span>
    </div>
  );
}
```

```tsx
// diagrams/src/primitives/shared/Arrow.tsx
import { tokens } from "../../theme/tokens";

/** An SVG arrow drawn from (x1,y1) to (x2,y2); `progress` 0→1 animates the stroke. */
export function Arrow(p: { x1: number; y1: number; x2: number; y2: number; progress: number; label?: string; dashed?: boolean; active?: boolean; id: string }) {
  const len = Math.hypot(p.x2 - p.x1, p.y2 - p.y1);
  const colour = p.active ? tokens.accent : tokens.muted;
  return (
    <g opacity={p.progress > 0 ? 1 : 0}>
      <defs>
        <marker id={`h-${p.id}`} markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto">
          <path d="M0,0 L10,5 L0,10 z" fill={colour} />
        </marker>
      </defs>
      <line
        x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={colour} strokeWidth={p.active ? 3 : 2}
        strokeDasharray={p.dashed ? "8 6" : `${len}`} strokeDashoffset={p.dashed ? 0 : len * (1 - p.progress)}
        markerEnd={p.progress >= 1 ? `url(#h-${p.id})` : undefined}
      />
      {p.label && p.progress >= 1 ? (
        <text x={(p.x1 + p.x2) / 2} y={(p.y1 + p.y2) / 2 - 8} textAnchor="middle" fontFamily={tokens.font} fontSize={14} fill={tokens.ink}
          stroke={tokens.bg} strokeWidth={4} paintOrder="stroke">{p.label}</text>
      ) : null}
    </g>
  );
}
```

```tsx
// diagrams/src/primitives/shared/Title.tsx
import { tokens } from "../../theme/tokens";

export function Title({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ position: "absolute", left: 24, top: 18, fontFamily: tokens.font, color: tokens.ink }}>
      <div style={{ fontSize: 30, fontWeight: 700 }}>{title}</div>
      {subtitle ? <div style={{ fontSize: 17, color: tokens.muted, marginTop: 4 }}>{subtitle}</div> : null}
    </div>
  );
}
```

```tsx
// diagrams/src/primitives/shared/Caption.tsx
import { tokens } from "../../theme/tokens";

/** The one-line caption bar at the bottom of a flow. */
export function Caption({ n, text }: { n: number; text: string }) {
  return (
    <div style={{ position: "absolute", left: 24, right: 24, bottom: 18, height: 48, borderRadius: 10, background: tokens.ink,
      color: "#FFFFFF", fontFamily: tokens.font, fontSize: 20, display: "flex", alignItems: "center", gap: 14, padding: "0 16px" }}>
      <span style={{ background: tokens.accent, borderRadius: 999, width: 30, height: 30, display: "grid", placeItems: "center", fontWeight: 700 }}>{n}</span>
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{text}</span>
    </div>
  );
}
```

```tsx
// diagrams/src/primitives/shared/Legend.tsx
import type { NodeKind } from "../../schema";
import { tokens } from "../../theme/tokens";

export function Legend({ kinds }: { kinds: NodeKind[] }) {
  return (
    <div style={{ position: "absolute", right: 24, top: 24, display: "flex", gap: 12, fontFamily: tokens.font, fontSize: 14, color: tokens.ink }}>
      {[...new Set(kinds)].map((k) => (
        <span key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 14, borderRadius: 4, background: tokens.kind[k].fill, border: `2px solid ${tokens.kind[k].stroke}` }} />
          {k}
        </span>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: `ArchitectureMap.tsx`** — zones fade in during INTRO, then edge `i` animates in its window; the edge currently animating and its two nodes are highlighted; the last frame shows everything un-highlighted.

```tsx
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import type { ArchitectureData } from "../schema";
import { tokens } from "../theme/tokens";
import { INTRO, STEP, unitProgress } from "../timing";
import { edgePoints, layoutArchitecture } from "./layout";
import { Arrow } from "./shared/Arrow";
import { Legend } from "./shared/Legend";
import { NodeBox } from "./shared/NodeBox";
import { Title } from "./shared/Title";

export function ArchitectureMap({ data }: { data: ArchitectureData }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const l = layoutArchitecture(data, width, height);
  const fade = interpolate(frame, [0, INTRO], [0, 1], { extrapolateRight: "clamp" });
  const current = Math.floor((frame - INTRO) / STEP);
  const active = current >= 0 && current < data.edges.length ? data.edges[current] : undefined;

  return (
    <AbsoluteFill style={{ background: tokens.bg }}>
      <Title title={data.title} subtitle={data.subtitle} />
      <Legend kinds={data.nodes.map((n) => n.kind)} />
      {data.zones.map((z) => {
        const r = l.zones[z.id]!;
        return (
          <div key={z.id} style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, opacity: fade,
            background: tokens.zoneFill, border: `1.5px dashed ${tokens.zoneStroke}`, borderRadius: 14 }}>
            <div style={{ fontFamily: tokens.font, fontSize: 15, fontWeight: 600, color: tokens.muted, padding: "8px 12px" }}>{z.label}</div>
          </div>
        );
      })}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {data.edges.map((e, i) => (
          <Arrow key={i} id={`a${i}`} {...edgePoints(l.nodes[e.from]!, l.nodes[e.to]!)} label={e.label}
            progress={unitProgress(frame, i)} active={e === active} />
        ))}
      </svg>
      {data.nodes.map((n) => (
        <NodeBox key={n.id} {...l.nodes[n.id]!} label={n.label} kind={n.kind} aws={n.aws} opacity={fade}
          highlight={active !== undefined && (active.from === n.id || active.to === n.id)} />
      ))}
    </AbsoluteFill>
  );
}
```

- [ ] **Step 7: `Root.tsx` and `index.ts`** — Root dispatches on `primitive`; FlowSequence/DependencyGraph cases are added in Tasks 5–6.

```tsx
// diagrams/src/Root.tsx
import { Composition } from "remotion";
import { catalog, type CatalogEntry } from "./catalog";
import { ArchitectureMap } from "./primitives/ArchitectureMap";
import { durationFor, FPS, HEIGHT, WIDTH } from "./timing";

function view(e: CatalogEntry) {
  switch (e.primitive) {
    case "architecture":
      return { component: ArchitectureMap, units: e.data.edges.length };
    default:
      throw new Error(`primitive ${e.primitive} is not registered yet`);
  }
}

export function Root() {
  return (
    <>
      {catalog.map((e) => {
        const { component, units } = view(e);
        return (
          <Composition key={e.id} id={e.id} component={component as never} defaultProps={{ data: e.data }}
            durationInFrames={durationFor(units)} fps={FPS} width={WIDTH} height={HEIGHT} />
        );
      })}
    </>
  );
}
```

```ts
// diagrams/src/index.ts
import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
```

- [ ] **Step 8: Studio target + smoke entry.** Makefile:

```make
diagrams-studio: ## Open Remotion Studio to browse/scrub every diagram interactively
	pnpm --filter @3mrai/diagrams studio
```

Temporarily add to `catalog` a `smoke-architecture` entry using the 3-node data from `layout.test.ts` with two edges, `output: "docs/00-overview/diagrams/smoke-architecture"`, `watches: ["diagrams/src/primitives/**"]`. Run `nvm use && pnpm --filter @3mrai/diagrams browser && pnpm --filter @3mrai/diagrams exec remotion still src/index.ts smoke-architecture out/smoke.png --frame=100`. Read `diagrams/out/smoke.png` with the Read tool and check: zones visible, icons rendered, arrows with heads, dark text on pastel. **Remove the smoke entry afterwards** (outputs are only produced via Task 7's renderer).

- [ ] **Step 9: Run** `pnpm --filter @3mrai/diagrams test && pnpm --filter @3mrai/diagrams typecheck` and the comment validator on the new files → green.

- [ ] **Step 10: Commit** (menu) — `feat(diagrams): add ArchitectureMap primitive and Studio entry point`

---

### Task 5: `FlowSequence` primitive

**Files:**
- Create: `diagrams/src/primitives/FlowSequence.tsx`
- Modify: `diagrams/src/primitives/layout.ts` (append), `diagrams/src/Root.tsx` (add case), `diagrams/test/layout.test.ts` (append)

**Interfaces:**
- Produces: `layoutFlow(d: FlowData, w: number, h: number): { lanes: Record<string, { x: number; header: Rect }>; rowY: (i: number) => number }`; `FlowSequence({ data }: { data: FlowData })`.

- [ ] **Step 1: Append failing tests to `diagrams/test/layout.test.ts`**

```ts
import { layoutFlow } from "../src/primitives/layout";

describe("layoutFlow", () => {
  const flow = {
    title: "F",
    actors: ["a", "b", "c"].map((id) => ({ id, label: id.toUpperCase(), kind: "compute" as const })),
    steps: Array.from({ length: 10 }, (_, i) => ({ from: "a", to: i % 2 ? "b" : "c", label: `s${i}`, caption: "c" })),
  };
  const l = layoutFlow(flow, 1200, 675);
  it("orders lanes left to right as declared", () => {
    expect(l.lanes.a!.x).toBeLessThan(l.lanes.b!.x);
    expect(l.lanes.b!.x).toBeLessThan(l.lanes.c!.x);
  });
  it("fits 10 rows above the caption bar", () => {
    expect(l.rowY(9)).toBeLessThan(675 - 18 - 48 - 8);
    expect(l.rowY(1)).toBeGreaterThan(l.rowY(0));
  });
});
```

- [ ] **Step 2: Run** → FAIL (`layoutFlow` not exported).

- [ ] **Step 3: Append to `layout.ts`**

```ts
import type { FlowData } from "../schema";

const LANE_TOP = 96;
const HEADER_H = 52;
const CAPTION_SPACE = 18 + 48 + 16;

export function layoutFlow(d: FlowData, w: number, h: number) {
  const laneW = (w - PAD * 2) / d.actors.length;
  const lanes: Record<string, { x: number; header: Rect }> = {};
  d.actors.forEach((a, i) => {
    const x = PAD + laneW * i + laneW / 2;
    lanes[a.id] = { x, header: { x: x - Math.min(200, laneW - 16) / 2, y: LANE_TOP, w: Math.min(200, laneW - 16), h: HEADER_H } };
  });
  const firstRow = LANE_TOP + HEADER_H + 30;
  const rowH = (h - CAPTION_SPACE - firstRow) / Math.max(d.steps.length, 1);
  return { lanes, rowY: (i: number) => firstRow + rowH * i + rowH / 2 };
}
```

(Merge the `import type` lines at the top of the file with the existing schema import.)

- [ ] **Step 4: Run** → PASS.

- [ ] **Step 5: `FlowSequence.tsx`** — lanes (header box + dashed lifeline) visible from the start; step `i` draws its arrow in its window with a numbered label; the caption bar shows the current step; on the final hold the caption shows the last step and every arrow stays drawn. A self-step (`from === to`) is drawn as a short loop to the right of the lane.

```tsx
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { FlowData } from "../schema";
import { tokens } from "../theme/tokens";
import { INTRO, STEP, unitProgress } from "../timing";
import { layoutFlow } from "./layout";
import { Arrow } from "./shared/Arrow";
import { Caption } from "./shared/Caption";
import { NodeBox } from "./shared/NodeBox";
import { Title } from "./shared/Title";

export function FlowSequence({ data }: { data: FlowData }) {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const l = layoutFlow(data, width, height);
  const current = Math.min(data.steps.length - 1, Math.max(0, Math.floor((frame - INTRO) / STEP)));
  const bottom = height - 18 - 48 - 16;

  return (
    <AbsoluteFill style={{ background: tokens.bg }}>
      <Title title={data.title} subtitle={data.subtitle} />
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {data.actors.map((a) => {
          const lane = l.lanes[a.id]!;
          return <line key={a.id} x1={lane.x} y1={lane.header.y + lane.header.h} x2={lane.x} y2={bottom} stroke={tokens.zoneStroke} strokeWidth={2} strokeDasharray="4 6" />;
        })}
        {data.steps.map((s, i) => {
          const y = l.rowY(i), from = l.lanes[s.from]!.x, to = l.lanes[s.to]!.x;
          const self = s.from === s.to;
          return (
            <Arrow key={i} id={`s${i}`} x1={from} y1={y} x2={self ? from + 60 : to} y2={self ? y + 12 : y}
              label={`${i + 1}. ${s.label}`} dashed={s.async} progress={unitProgress(frame, i)} active={i === current && frame >= INTRO} />
          );
        })}
      </svg>
      {data.actors.map((a) => (
        <NodeBox key={a.id} {...l.lanes[a.id]!.header} label={a.label} kind={a.kind} aws={a.aws}
          highlight={frame >= INTRO && (data.steps[current]!.from === a.id || data.steps[current]!.to === a.id)} />
      ))}
      {frame >= INTRO ? <Caption n={current + 1} text={data.steps[current]!.caption} /> : null}
    </AbsoluteFill>
  );
}
```

- [ ] **Step 6: Register in `Root.tsx`** — add `case "flow": return { component: FlowSequence, units: e.data.steps.length };` and its import.

- [ ] **Step 7: Smoke-render** a temporary 3-actor/4-step flow entry (one async step, one self-step) as in Task 4 Step 8, inspect the PNG (`--frame=` last), then remove the temporary entry.

- [ ] **Step 8: Tests + typecheck + comment validator** → green.

- [ ] **Step 9: Commit** (menu) — `feat(diagrams): add FlowSequence primitive`

---

### Task 6: `DependencyGraph` primitive (static)

**Files:**
- Create: `diagrams/src/primitives/DependencyGraph.tsx`
- Modify: `layout.ts` (append `layoutDependency`), `Root.tsx`, `test/layout.test.ts`

**Interfaces:**
- Produces: `layoutDependency(d: DependencyData, w: number, h: number): { phases: Record<string, Rect>; tasks: Record<string, Rect> }`; `DependencyGraph({ data })`. Duration: `units = 0` (INTRO + HOLD); its catalog entries are PNG-only (Task 7 `animated: false`).

- [ ] **Step 1: Failing test** (append):

```ts
import { layoutDependency } from "../src/primitives/layout";

describe("layoutDependency", () => {
  const d = {
    title: "M",
    phases: [{ id: "p1", label: "P1" }, { id: "p2", label: "P2" }],
    tasks: [
      { id: "JE-1", label: "A", phase: "p1" },
      { id: "JE-2", label: "B", phase: "p2" },
      { id: "JE-3", label: "C", phase: "p2" },
    ],
    deps: [{ from: "JE-1", to: "JE-2" }],
  };
  const l = layoutDependency(d, 1200, 675);
  it("puts each task inside its phase column", () => {
    for (const t of d.tasks) {
      const r = l.tasks[t.id]!, p = l.phases[t.phase]!;
      expect(r.x).toBeGreaterThanOrEqual(p.x);
      expect(r.x + r.w).toBeLessThanOrEqual(p.x + p.w);
    }
  });
});
```

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — `layoutDependency` reuses `layoutArchitecture` (phases are zones, tasks are nodes):

```ts
import type { DependencyData } from "../schema";

export function layoutDependency(d: DependencyData, w: number, h: number) {
  const { zones, nodes } = layoutArchitecture(
    { title: d.title, zones: d.phases, nodes: d.tasks.map((t) => ({ id: t.id, label: t.label, kind: "compute" as const, zone: t.phase })), edges: [] },
    w,
    h,
  );
  return { phases: zones, tasks: nodes };
}
```

WARNING: `layoutArchitecture` takes `ArchitectureData`, whose node `label` is capped at 22 while tasks allow 30 — the layout ignores label length, so this call is safe; do NOT route it through `ArchitectureData.parse`.

`DependencyGraph.tsx` renders like `ArchitectureMap` with every arrow at `progress=1`, task boxes labelled `"<id> <label>"`, and no highlight; it composes `Title`, phase columns, `Arrow`, `NodeBox` (kind `compute`, no icon).

```tsx
import { AbsoluteFill, useVideoConfig } from "remotion";
import type { DependencyData } from "../schema";
import { tokens } from "../theme/tokens";
import { edgePoints, layoutDependency } from "./layout";
import { Arrow } from "./shared/Arrow";
import { NodeBox } from "./shared/NodeBox";
import { Title } from "./shared/Title";

export function DependencyGraph({ data }: { data: DependencyData }) {
  const { width, height } = useVideoConfig();
  const l = layoutDependency(data, width, height);
  return (
    <AbsoluteFill style={{ background: tokens.bg }}>
      <Title title={data.title} />
      {data.phases.map((p) => {
        const r = l.phases[p.id]!;
        return (
          <div key={p.id} style={{ position: "absolute", left: r.x, top: r.y, width: r.w, height: r.h, background: tokens.zoneFill,
            border: `1.5px dashed ${tokens.zoneStroke}`, borderRadius: 14 }}>
            <div style={{ fontFamily: tokens.font, fontSize: 15, fontWeight: 600, color: tokens.muted, padding: "8px 12px" }}>{p.label}</div>
          </div>
        );
      })}
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {data.deps.map((e, i) => <Arrow key={i} id={`d${i}`} {...edgePoints(l.tasks[e.from]!, l.tasks[e.to]!)} progress={1} />)}
      </svg>
      {data.tasks.map((t) => <NodeBox key={t.id} {...l.tasks[t.id]!} label={`${t.id} ${t.label}`} kind="compute" />)}
    </AbsoluteFill>
  );
}
```

Register in `Root.tsx`: `case "dependency": return { component: DependencyGraph, units: 0 };`.

- [ ] **Step 4: Run** tests → PASS; smoke still with a temporary entry; inspect; remove the entry.

- [ ] **Step 5: Commit** (menu) — `feat(diagrams): add DependencyGraph primitive for milestone plans`

---

### Task 7: Renderer and `diagrams-render`

**Files:**
- Create: `diagrams/src/scripts/render.ts`
- Modify: `diagrams/src/catalog.ts` (add optional `animated?: boolean`, default true; dependency entries set `false`), `Makefile`

**Interfaces:**
- Consumes: `catalog`, `src/index.ts`.
- Produces: CLI `pnpm --filter @3mrai/diagrams render [id ...]` (env `ID=a,b` via Make) writing `<output>.gif` (if animated) and `<output>.png` (last frame) relative to repo root, printing size per file and a WARNING line for any GIF > 2 MB.

- [ ] **Step 1: Add `animated?: boolean` to `Base` in `catalog.ts`** with the doc comment `/** false → PNG only (DependencyGraph). Default true. */`.

- [ ] **Step 2: Implement `render.ts`**

```ts
import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { catalog } from "../catalog";

const pkgRoot = new URL("../../", import.meta.url).pathname;
const repoRoot = new URL("../../../", import.meta.url).pathname;
const GIF_BUDGET = 2 * 1024 * 1024;

const wanted = process.argv.slice(2).flatMap((a) => a.split(",")).filter(Boolean);
const unknownIds = wanted.filter((id) => !catalog.some((e) => e.id === id));
if (unknownIds.length) {
  console.error(`unknown diagram id(s): ${unknownIds.join(", ")}`);
  process.exit(1);
}
const entries = wanted.length ? catalog.filter((e) => wanted.includes(e.id)) : catalog;

const serveUrl = await bundle({ entryPoint: join(pkgRoot, "src/index.ts") });
const kb = (p: string) => `${Math.round(statSync(p).size / 1024)} KB`;

for (const e of entries) {
  const composition = await selectComposition({ serveUrl, id: e.id, inputProps: { data: e.data } });
  const base = join(repoRoot, e.output);
  mkdirSync(dirname(base), { recursive: true });
  if (e.animated !== false) {
    // WHY: 24 fps composition, every 2nd frame → ~12 fps GIF; scale 1 keeps it at 1200px wide.
    await renderMedia({ serveUrl, composition, codec: "gif", everyNthFrame: 2, outputLocation: `${base}.gif`, inputProps: { data: e.data } });
    const size = statSync(`${base}.gif`).size;
    console.log(`${e.id}.gif ${kb(`${base}.gif`)}${size > GIF_BUDGET ? "  WARNING: over the 2 MB budget" : ""}`);
  }
  await renderStill({ serveUrl, composition, frame: composition.durationInFrames - 1, output: `${base}.png`, inputProps: { data: e.data } });
  console.log(`${e.id}.png ${kb(`${base}.png`)}`);
}
```

- [ ] **Step 3: Makefile**

```make
diagrams-render: ## Render diagrams to the vault (all, or ID=a,b). GIF + last-frame PNG; warns over 2 MB
	pnpm --filter @3mrai/diagrams browser
	pnpm --filter @3mrai/diagrams render $(subst $(comma), ,$(ID))
```

Define `comma := ,` near the Diagrams section if the Makefile does not already. Add `diagrams-render diagrams-studio` to `.PHONY`.

- [ ] **Step 4: Verify** — `nvm use && make diagrams-render ID=does-not-exist` → exits 1 with "unknown diagram id(s)". With an empty catalog, `make diagrams-render` → completes with no output files.

- [ ] **Step 5: Commit** (menu) — `feat(diagrams): add GIF/PNG renderer and make targets`

---

### Task 8: Remotion skills, `diagram-impl` agent, `diagrams/CLAUDE.md`, audit hook

**Files:**
- Create: `.ai/skills/remotion-*/` (12 dirs, from the vendor), `.agents/skills/remotion-*` (symlinks), `.claude/agents/diagram-impl.md`, `diagrams/CLAUDE.md`
- Modify: `skills-lock.json`, `.ai/skills/spec-implementation-audit/SKILL.md` (the real file; check `readlink -f .claude/skills/spec-implementation-audit` first), root `CLAUDE.md`

- [ ] **Step 1: Install the skills.** `nvm use && pnpm dlx skills add remotion-dev/skills`. Choose the project scope. Confirm where the CLI wrote them; the target is `.ai/skills/<name>/` (move them there if it wrote elsewhere, keeping `skills-lock.json` entries). Then, per `[[skill-propagation]]`, for each `remotion-*` dir: `ln -s ../../.ai/skills/<name> .agents/skills/<name>` (symlink, never a copy). Make each available to Claude Code under `.claude/skills/` the same way existing propagated skills are (inspect `ls -la .claude/skills/floci` and mirror it).

- [ ] **Step 2: `diagrams/CLAUDE.md`** — contents (English): stack + versions (Global Constraints), the three primitives and when to use each (architecture = static topology, flow = ordered interaction among ≤7 actors, dependency = milestone plans), detail level (≤ ~12 nodes; architecture maps ≤18 grouped by zone; ≤10 steps; captions one line ≤90 chars; names not endpoints/fields/payloads), "read the source before drawing" list (architecture → `infra/modules/**`, `infra/environments/{local,preprod}/**`, `docker-compose*.yml`; flows → handlers + `services/<svc>/openapi.yaml`), every new entry needs `watches` that match real files (the catalog test enforces it), the icon adapter rule, output location rule (`diagrams/` beside the owning vault section; `output` without extension), the verify loop (`make diagrams-render ID=<id>` → Read the PNG → check contrast/clipping → `make diagrams-check` → report GIF size), and the write boundary (only `diagrams/**` and `docs/**/diagrams/*.{gif,png}`; never `.md` under `docs/`; never git).

- [ ] **Step 3: `.claude/agents/diagram-impl.md`** — frontmatter mirrors `e2e-impl.md`:

```markdown
---
name: diagram-impl
model: opus
skills:
  - remotion-best-practices
  - remotion-markup
  - remotion-render
  - remotion-studio
  - remotion-docs
  - typescript-pro
description: >-
  Diagram implementer for the 3MRAI Remotion package (diagrams/). Use to add,
  update or re-render an animated flow/architecture diagram or a milestone
  dependency graph. Reads the real code and Terraform before drawing, edits only
  diagrams/** and the rendered docs/**/diagrams/*.{gif,png}, never touches .md
  notes, git or Linear, and leaves the work in the working tree for the main
  session to commit.
tools: [Read, Write, Edit, Bash, Glob, Grep, Skill]
---
```

Body sections, following `e2e-impl.md`'s shape: *Hard rules* (no git writes, no Linear, no `.md` under `docs/` — report embed needs in the handoff, stay in task, comment rules with the validator command); *How to operate* (0 load skills; 1 read `diagrams/CLAUDE.md`; 2 read the sources the diagram depicts; 3 edit data/catalog; 4 `pnpm --filter @3mrai/diagrams test`; 5 render by ID and Read the PNG; 6 `make diagrams-check`); *Handoff* (files changed, GIF sizes, embed requests for `obsidian-vault`, lesson candidates).

- [ ] **Step 4: Audit hook** — in `spec-implementation-audit/SKILL.md`, in the code → docs direction, add a step: "Run `make diagrams-check`. Every `STALE?` line is a code → docs gap: re-render via `diagram-impl`, or record a one-line justification for the PR's `## Diagrams` section."

- [ ] **Step 5: Root `CLAUDE.md`** — add under Working rules a `### Diagrams` subsection (≤5 lines): diagrams are Remotion renders from `diagrams/`; a change to a diagrammed flow or an AWS resource re-renders in the same PR; run `make diagrams-check` before a PR; attach the GIF under `## Diagrams` in the PR body when a flow is new/affected; full convention `docs/shared/conventions/diagrams.md` → `diagrams`. Add `diagram-impl` to the Subagents list and to the domain-layer implementer list (seven → eight).

- [ ] **Step 6: Sync** — dispatch the `ai-config-sync` agent, then `nvm use && make ai-sync && make ai-sync-check` → "OK". Verify the remotion skills appear under `.cursor/`, `.gemini/` etc. with the direct comparison from `[[skill-propagation]]` § Checking what is missing.

- [ ] **Step 7: Commit** (menu) — `feat(agents): add diagram-impl agent and Remotion skills`

---

### Task 9: Architecture + system-context diagrams (replaces draw.io content)

**Executor:** `diagram-impl`.

**Files:**
- Create: `diagrams/src/data/architecture/{dev-floci,preprod}.ts`, `diagrams/src/data/system-context/{l1,l2}.ts`
- Modify: `diagrams/src/catalog.ts`
- Renders: `docs/00-overview/diagrams/{architecture-dev-floci,architecture-preprod,system-context-l1,system-context-l2}.{gif,png}`

- [ ] **Step 1:** Read `docs/00-overview/architecture.md`, `docs/00-overview/system-context.md`, the existing `.drawio.svg` files (for what they depicted), `infra/environments/local/**`, `infra/environments/preprod/**`, `infra/modules/**`, `docker-compose.yml`, `docker-compose.preprod.yml`.
- [ ] **Step 2:** Write each data file exporting a typed constant, e.g.

```ts
import type { ArchitectureData } from "../../schema";

export const architectureDevFloci: ArchitectureData = {
  title: "Architecture — local dev (Floci)",
  subtitle: "Every AWS service runs on the Floci emulator at :4566",
  zones: [/* e.g. client, edge, services, async, data — from the real Terraform */],
  nodes: [/* ≤18, each with aws: where it is an AWS service */],
  edges: [/* in the order the animation should reveal them */],
};
```

`architecture-preprod` differs where the real config differs (ECS tasks behind ALB on its own Floci, ECR) — derive it, do not copy dev.
- [ ] **Step 3:** Catalog entries with watches: dev → `["infra/modules/**", "infra/environments/local/**", "docker-compose.yml"]`; preprod → `["infra/modules/**", "infra/environments/preprod/**", "docker-compose.preprod.yml"]`; system-context → `["infra/modules/api-gateway/**", "infra/modules/cognito/**", "services/*/openapi.yaml"]` (adjust only to globs that match tracked files).
- [ ] **Step 4:** `pnpm --filter @3mrai/diagrams test` → PASS; `make diagrams-render ID=architecture-dev-floci,architecture-preprod,system-context-l1,system-context-l2`; Read each PNG; fix contrast/clipping; GIFs ≤ ~2 MB.
- [ ] **Step 5: Commit** (menu) — `docs(infra): re-create architecture and system-context diagrams in Remotion`

---

### Task 10: Milestone dependency graphs (PNG)

**Executor:** `diagram-impl`.

- [ ] **Step 1:** Read `docs/plans/{users-service,services-infra-scaffold,documentation-vault}-milestone.md` and the matching `docs/plans/diagrams/*-deps.drawio.svg` (the `content` attribute holds the graph). For `users-service`, include the tasks the note's callout says the old diagram lacked.
- [ ] **Step 2:** `diagrams/src/data/milestones/{users-service,services-infra-scaffold,documentation-vault}.ts` (`DependencyData`), catalog entries with `primitive: "dependency"`, `animated: false`, `output: "docs/plans/diagrams/<slug>-deps"`, `watches: ["docs/plans/<slug>-milestone.md"]`.
- [ ] **Step 3:** Test, `make diagrams-render ID=<3 ids>`, Read each PNG.
- [ ] **Step 4: Commit** (menu) — `docs(vault): re-create milestone dependency graphs in Remotion`

---

### Tasks 11–15: Flow diagrams

**Executor:** `diagram-impl`, one task per group. Each task: read the listed sources → write `diagrams/src/data/flows/<id>.ts` (`FlowData`, ≤7 actors, ≤10 steps, `async: true` for queue/topic/webhook hops) → catalog entry (`primitive: "flow"`) → test → render by ID → Read PNG → commit via menu. Output folder per the owning section below.

| Task | id | Sources to read | watches | output |
|---|---|---|---|---|
| 11 | `users-signup-otp` | `services/users/src/**` sign-up, `infra/modules/cognito/**`, `functions/events-pipeline/src/handlers/**` | `services/users/src/**`, `infra/modules/cognito/**`, `functions/events-pipeline/src/handlers/**` | `docs/domains/users/specs/diagrams/` |
| 11 | `users-password-reset` | `docs/shared/decisions/ADR-0020-self-owned-password-reset.md`, users reset handlers, events-pipeline handler | same as above | `docs/domains/users/specs/diagrams/` |
| 11 | `orders-checkout-stripe` | `services/orders/**` checkout/webhook, `services/orders/openapi.yaml`, events-pipeline order handler | `services/orders/**`, `functions/events-pipeline/src/handlers/**` | `docs/domains/orders/specs/diagrams/` |
| 11 | `tracking-notification` | `services/tracking-go/**` webhook, `infra/modules/messaging/**`, `functions/realtime-events/**` | `services/tracking-go/**`, `infra/modules/messaging/**`, `functions/realtime-events/**` | `docs/domains/tracking/specs/diagrams/` |
| 11 | `observability-telemetry` | `observability/**`, `docs/shared/conventions/logging-context.md`, ADR-0019 | `observability/**`, `docker-compose.yml` | `docs/shared/observability/diagrams/` |
| 12 | `auth-passwordless-otp-signin` | `infra/modules/cognito/otp-challenge-lambda/**`, `functions/events-pipeline/src/handlers/auth-otp-requested.ts`, `apps/web/src/app/features/auth/**` | `infra/modules/cognito/**`, `functions/events-pipeline/src/handlers/**` | `docs/domains/users/specs/diagrams/` |
| 12 | `auth-password-signin-refresh` | `infra/modules/cognito/pre-token-lambda/**`, `infra/modules/api-gateway/**`, refresh spec 2026-07-11 | `infra/modules/cognito/**`, `infra/modules/api-gateway/**` | `docs/domains/users/specs/diagrams/` |
| 12 | `users-cognito-identity-webhook` | spec 2026-07-09-users-cognito-webhook, `services/users/src/**` | `services/users/src/**`, `infra/modules/cognito/**` | `docs/domains/users/specs/diagrams/` |
| 12 | `users-account-deletion-cascade` | spec 2026-08-25-account-deletion, users/orders/tracking delete handlers | `services/users/src/**`, `services/orders/**`, `services/tracking-go/**` | `docs/domains/users/specs/diagrams/` |
| 13 | `orders-catalogue-cart` | `apps/web/src/app/features/{catalogue,cart}/**`, cart spec 2026-08-25, `services/orders/**` | `services/orders/**`, `apps/web/src/app/features/cart/**` | `docs/domains/orders/specs/diagrams/` |
| 13 | `response-cache` | spec 2026-08-25-response-caching-layer, `services/users/src/shared/cache/**` | `services/*/src/shared/cache/**`, `infra/modules/**` (narrow to the cache module that exists) | `docs/shared/patterns/diagrams/` |
| 13 | `checkout-address-geocoding-proxy` | spec 2026-09-06-address-geocoding-proxy, `infra/modules/compute/nginx/**` | `infra/modules/compute/nginx/**` | `docs/domains/orders/specs/diagrams/` |
| 14 | `tracking-outbox-relay` | `services/tracking-go/internal/{outbox,bus}/**` | `services/tracking-go/internal/outbox/**`, `services/tracking-go/internal/bus/**` | `docs/domains/tracking/specs/diagrams/` |
| 14 | `events-pipeline-fanout-dlq` | `functions/events-pipeline/src/{handlers,pipeline}/**`, `infra/modules/messaging/**` | `functions/events-pipeline/src/**`, `infra/modules/messaging/**` | `docs/domains/events-pipeline/specs/diagrams/` |
| 14 | `websocket-lifecycle` | `functions/realtime-events/src/**`, `infra/modules/api-gateway-ws/**` | `functions/realtime-events/**`, `infra/modules/api-gateway-ws/**` | `docs/infrastructure/specs/diagrams/` |
| 15 | `business-metrics` | `services/users/src/shared/metrics/**`, `infra/environments/preprod/main.tf`, `observability/dashboards/business-metrics.dashboard.json` | `services/*/src/shared/metrics/**`, `observability/**` | `docs/shared/observability/diagrams/` |
| 15 | `browser-rum` | `docs/shared/conventions/browser-rum.md`, spec 2026-09-19-web-rum-integration | `apps/web/src/app/core/**` (narrow to the RUM code that exists), `observability/dashboards/rum.dashboard.json` | `docs/shared/observability/diagrams/` |
| 15 | `preprod-deploy` | `infra/environments/preprod/scripts/**`, `docs/infrastructure/runbooks/preprod.md` | `infra/environments/preprod/**`, `docker-compose.preprod.yml` | `docs/infrastructure/runbooks/diagrams/` |
| 15 | `terraform-two-phase-apply` | `docs/infrastructure/decisions/two-phase-terraform-apply.md`, `Makefile` (`bootstrap*`, `post-infra`) | `infra/environments/local/**`, `Makefile` | `docs/infrastructure/decisions/diagrams/` |

(Task 11 = initial flows; 12 = auth; 13 = shopping; 14 = events/realtime; 15 = observability/ops.) Before writing a watch glob, confirm it matches a tracked file (`git ls-files '<glob>'`); the catalog test enforces it. Commit messages: `docs(<area>): add <group> flow diagrams`.

---

### Task 16: Vault — ADR, convention, PR rule, embeds, draw.io references

**Executor:** `obsidian-vault` (sole writer of `docs/` `.md`). One brief, in English.

- [ ] **Step 1:** Create `docs/shared/decisions/ADR-0023-remotion-diagrams.md` (accepted; supersedes ADR-0015; context = draw.io static and hard to keep current, decision = spec decisions 2/4/5/6, consequences incl. icon-package risk + adapter). Set ADR-0015 `status: superseded`, `superseded-by: ADR-0023-remotion-diagrams`, tags updated; its body untouched.
- [ ] **Step 2:** Create `docs/shared/conventions/diagrams.md`: tool + package, outputs, location, catalog/`watches`, detail level, legibility rules, keep-current rule, `diagrams-check` usage and how to dismiss a warning, PR `## Diagrams` rule, `diagram-impl` write boundary, icon adapter rule.
- [ ] **Step 3:** Rename `docs/lessons/drawio-diagram-legibility.md` → `docs/lessons/diagram-legibility.md`, generalized (dark text on pastel; layouts that fit; verify by reading the rendered PNG); update every inbound link.
- [ ] **Step 4:** `docs/shared/conventions/git-workflow.md` — add the `## Diagrams` PR-body rule next to `## References`: mandatory when `diagrams-check` flagged something, optional otherwise; embed the GIF via the branch's raw URL `https://github.com/je-martinez/3-microservices-running-on-aws-infrastructure/raw/<branch>/<path>.gif` plus one line on what changed.
- [ ] **Step 5:** Embeds: `architecture.md` → `![[architecture-dev-floci.gif]]` and `![[architecture-preprod.gif]]`; `system-context.md` → L1/L2 GIFs; each owning note from the Task 11–15 table embeds its flow GIF in the relevant section (users/orders/tracking/events-pipeline service specs, `docs/shared/observability/*`, `docs/shared/patterns/*`, `docs/infrastructure/specs|runbooks|decisions/*` — the owning note is the one in the same folder as the `diagrams/` subfolder); the 3 milestone plans → `![[<slug>-deps.png]]` (drop the users-service "still reflects only JE-25…JE-37" callout if the new graph covers all tasks); `stripe-payments-milestone.md` → remove its draw.io mention.
- [ ] **Step 6:** `milestone-plan.md` — deps diagram is a `DependencyGraph` catalog entry rendered to `docs/plans/diagrams/<slug>-deps.png`; links `[[diagrams]]` and `[[ADR-0023-remotion-diagrams]]` instead of ADR-0015. `mcp-servers.md` → pencil only (title too). `scripting-language.md` → drop `drawio-to-svg.mjs`, mention `diagrams/src/scripts/*.ts` under the Node-ecosystem exception. `index.md` → ADR-0023, `[[diagrams]]`, `[[diagram-legibility]]` entries; ADR-0015 entry marked superseded.
- [ ] **Step 7:** Spec `2026-10-06-remotion-diagrams-design.md` — move `diagrams`, `ADR-0023-remotion-diagrams`, `diagram-legibility` into `propagates-to:` as wikilinks, add the owning notes from Step 5, replace `[[drawio-diagram-legibility]]`, drop the "Targets not yet created" callout; bump `updated:`. Index this plan from `docs/plans/index.md`.
- [ ] **Step 8:** `nvm use && node scripts/validate-vault.mjs` → green.
- [ ] **Step 9: Commit** (menu) — `docs(vault): adopt Remotion diagrams convention and supersede ADR-0015`

---

### Task 17: Retire draw.io

**Files:**
- Delete: `docs/00-overview/diagrams/{architecture,system-context-l1,system-context-l2}.drawio.svg`, `docs/plans/diagrams/{users-service,services-infra-scaffold,documentation-vault}-deps.drawio.svg`, `scripts/drawio-to-svg.mjs`
- Modify: `.mcp.json` (remove `drawio`), `.claude/settings.local.json` (remove drawio permission entries), `scripts/validate-vault.mjs:125-127,167` (comment examples → `architecture-dev-floci.gif`)
- Regenerate (never by hand): `.cursor/mcp.json`, `.gemini/settings.json`, `.codex/config.toml`, `opencode.json`, `.ai/settings.json`, `.vscode/mcp.json`

- [ ] **Step 1:** Delete the files listed above (`git rm`).
- [ ] **Step 2:** Edit `.mcp.json`, `.claude/settings.local.json`, `validate-vault.mjs` comments.
- [ ] **Step 3:** `nvm use && make ai-sync && make ai-sync-check` → OK; confirm projections lost `drawio`.
- [ ] **Step 4: Verify no live reference remains**

Run:
```bash
grep -rIil 'drawio\|draw\.io' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=worktrees . \
  | grep -v -e 'ADR-0015-drawio-diagrams.md' -e 'sources/first-prompt-es.md' \
            -e '2026-06-27-milestone-plan-convention-design.md' -e '2026-07-19-scripts-to-python-migration-design.md' \
            -e '2026-10-06-remotion-diagrams' -e 'ADR-0023-remotion-diagrams.md' -e 'conventions/diagrams.md' -e 'lessons/diagram-legibility.md'
```
Expected: no output. (The kept historical items, the spec/plan, and the new notes that explain the migration are excluded.)
- [ ] **Step 5:** `node scripts/validate-vault.mjs` → green (no broken `.drawio.svg` embeds).
- [ ] **Step 6: Commit** (menu) — `chore(vault)!: retire draw.io diagrams, script and MCP server`

---

### Task 18: Final verification and gap audit

- [ ] **Step 1:** `nvm use && pnpm --filter @3mrai/diagrams test && pnpm --filter @3mrai/diagrams typecheck` → PASS (catalog test now runs 26 entries × 4 checks).
- [ ] **Step 2:** `make diagrams-render` (all 26) — every GIF ≤ ~2 MB (no WARNING lines; if any, reduce steps/nodes or pass `scale: 0.8` for that entry and note it); Read every PNG.
- [ ] **Step 3:** `make lint-comments`, `node scripts/validate-vault.mjs`, `make ai-sync-check` → green.
- [ ] **Step 4:** `make diagrams-check` → every listed entry shows `updated`.
- [ ] **Step 5:** Run the `spec-implementation-audit` skill (spec → code, code → docs, plan → repo). Close gaps; re-run.
- [ ] **Step 6:** Report total committed binary size (`du -ch docs/**/diagrams/*.{gif,png}`).
- [ ] **Step 7:** Main session proposes the PR `feature/remotion-diagrams` → `main` via the menu, with a `## Diagrams` section showing `architecture-dev-floci.gif` and one flow, and `## References` (spec, plan, ADR-0023, convention).

## Related

- [[2026-10-06-remotion-diagrams-design]]
- [[ADR-0015-drawio-diagrams]]
- [[drawio-diagram-legibility]]
- [[skill-propagation]]
- [[doc-propagation]]
- [[code-comments]]
- [[git-workflow]]
