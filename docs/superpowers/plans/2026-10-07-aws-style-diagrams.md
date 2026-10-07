---
title: "AWS-Style Diagrams Implementation Plan"
type: plan
area: shared
status: active
created: 2026-10-07
updated: 2026-10-07
tags:
  - type/plan
  - area/shared
  - status/active
related:
  - "[[2026-10-07-aws-style-diagrams-design]]"
  - "[[2026-10-06-remotion-diagrams-design]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[diagrams]]"
  - "[[diagram-legibility]]"
propagates-to:
  - "[[diagrams]]"
  - "[[ADR-0023-remotion-diagrams]]"
  - "[[diagram-legibility]]"
  - "[[architecture]]"
  - "[[system-context]]"
  - "[[users-service-milestone]]"
  - "[[services-infra-scaffold-milestone]]"
  - "[[documentation-vault-milestone]]"
---

# AWS-Style Diagrams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle all 26 Remotion diagrams to the AWS reference-architecture visual language with one ELK-laid-out primitive (`AwsDiagram`), official group/generic icons, numbered step badges, and update the `diagram-impl` agent so future diagrams follow it.

**Architecture:** A new zod schema (`AwsDiagramData`: groups, nodes, edges, steps) is laid out by ELK (`elkjs`, layered, orthogonal, hierarchical) inside Remotion's `calculateMetadata`, which passes positions, routes and canvas size as props to the `AwsDiagram` component. The new primitive lands beside the old ones; each content group migrates in parallel; the old primitives are deleted last.

**Tech Stack:** Remotion 4.0.533 (existing pins), elkjs 0.12.0 (EPL-2.0 OR GPL-3.0), @remotion/google-fonts (Arimo), @nxavis/aws-icons 0.0.5, official AWS Architecture Icons asset package (group + generic SVGs), Python 3 (icon fetch script), vitest, zod 4.5.4.

**Spec:** `docs/superpowers/specs/2026-10-07-aws-style-diagrams-design.md` (builds on `docs/superpowers/specs/2026-10-06-remotion-diagrams-design.md`)

## Global Constraints

- pnpm only (`pnpm --filter @3mrai/diagrams add -E …`); `nvm use` before Node; all `remotion`/`@remotion/*` stay at exactly `4.0.533`; `elkjs` pinned exactly (`-E`).
- New scripts are Python (scripting-language convention); run from the repo venv `.venv/bin/python` (`make scripts-setup` creates it).
- Only `diagrams/src/theme/aws-icons.ts` imports `@nxavis/aws-icons` or reads `diagrams/public/aws-icons/`.
- Visual: white canvas; Arimo font; service icon ~48px, label below (≤2 lines), optional italic sublabel; group containers with official corner icon + label; connectors thin black orthogonal, solid sync / dashed async; numbered badges = rounded blue squares, white number; step-list panel under the diagram on the last frame.
- Output: GIF + last-frame PNG when the diagram has `steps`; PNG only when it has none. GIF ≤ ~2 MB, ~12 fps (`everyNthFrame: 2` on 24 fps), scaled to ≤1200px wide; PNG at full layout size. Never animate the whole canvas.
- Detail level unchanged: ≤ ~12 nodes (architecture ≤18), ≤10 steps, captions one line ≤90 chars, names only (no endpoints/fields/payloads); content read from real code/Terraform.
- Dispatched agents never run git writes; the controller commits each task. Only `obsidian-vault` edits `docs/**/*.md`; `diagram-impl` writes `diagrams/**` and `docs/**/diagrams/*.{gif,png}`.
- Comments: five tags, present tense; `python3 scripts/validate-comments.py <files>` clean.

## Review Focus

- **A step referencing an unknown edge id, or an edge referencing a node absent from the diagram** → schema `superRefine` rejects it (Task 2).
- **A node whose `group` names a group, or a group whose `parent` forms a cycle** → schema rejects; layout never loops (Task 2).
- **ELK placing a node outside its group, or an edge route crossing a node it does not connect** → real-ELK layout tests (Task 3).
- **Very wide layouts** (many groups side by side) → GIF scaled to 1200px, PNG legible at full size; test that `gifScale(width)` ≤ 1 and the composition size equals the layout size (Tasks 3–4).
- **A diagram with steps whose last frame still shows a highlight, or without steps that still emits a GIF** → timing/output tests (Task 4).

---

## File Structure

```
diagrams/
  scripts/fetch_aws_icons.py            Python: download official package, extract the icons we use
  scripts/test_fetch_aws_icons.py       pytest for the selection/manifest logic
  public/aws-icons/{group,generic}/*.svg + manifest.json   committed official SVGs
  src/aws/schema.ts                     AwsDiagramData zod schema (+ GroupKind, GenericIcon)
  src/aws/measure.ts                    deterministic text-size estimate shared by layout and tests
  src/aws/layout.ts                     toElkGraph + layoutDiagram (ELK) → DiagramLayout
  src/aws/timing.ts                     durations, active step, gifScale
  src/aws/AwsDiagram.tsx                composition component
  src/aws/parts/{Group,NodeView,Connector,StepBadge,CaptionBar,StepList}.tsx
  src/theme/aws-style.ts                AWS colours, sizes, group styles
  src/theme/aws-icons.ts                (extended) service + group + generic icon lookup
  test/aws-schema.test.ts, test/aws-layout.test.ts, test/aws-timing.test.ts
```
Old `src/primitives/**`, `src/schema.ts` (old parts), `src/timing.ts` and their tests are deleted in Task 11.

---

### Task 1: Official group and generic icons

**Files:**
- Create: `diagrams/scripts/fetch_aws_icons.py`, `diagrams/scripts/test_fetch_aws_icons.py`, `diagrams/public/aws-icons/manifest.json`, `diagrams/public/aws-icons/group/*.svg`, `diagrams/public/aws-icons/generic/*.svg`
- Modify: `Makefile` (`diagrams-icons` target in the Diagrams section + `.PHONY`)

**Interfaces:**
- Produces: `diagrams/public/aws-icons/manifest.json` = `{ "package": "<zip file name>", "fetched": "<YYYY-MM-DD>", "group": { "<kind>": "group/<file>.svg" }, "generic": { "<name>": "generic/<file>.svg" } }` with keys exactly:
  - group: `aws-cloud` ← `AWS-Cloud-logo_32.svg`, `region` ← `Region_32.svg`, `vpc` ← `Virtual-private-cloud-VPC_32.svg`, `public-subnet` ← `Public-subnet_32.svg`, `private-subnet` ← `Private-subnet_32.svg`, `account` ← `AWS-Account_32.svg`, `corporate` ← `Corporate-data-center_32.svg`, `server` ← `Server-contents_32.svg` (used for `local-floci`)
  - generic (from `Resource-Icons_*/Res_General-Icons/Res_48_Light/`): `users` ← `Res_Users_48_Light.svg`, `client` ← `Res_Client_48_Light.svg`, `internet` ← `Res_Internet_48_Light.svg`, `server` ← `Res_Server_48_Light.svg`, `office-building` ← `Res_Office-building_48_Light.svg`, `firewall` ← `Res_Firewall_48_Light.svg`, `data-table` ← `Res_Data-Table_48_Light.svg`
  - Availability Zone and generic group have no official icon (dashed border, label only).

- [ ] **Step 1: Failing pytest** — `diagrams/scripts/test_fetch_aws_icons.py`

```python
import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("fetch", Path(__file__).with_name("fetch_aws_icons.py"))
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)

NAMES = [
    "Architecture-Group-Icons_07312026/AWS-Cloud-logo_32.svg",
    "__MACOSX/Architecture-Group-Icons_07312026/._AWS-Cloud-logo_32.svg",
    "Architecture-Group-Icons_07312026/Region_32.svg",
    "Resource-Icons_07312026/Res_General-Icons/Res_48_Light/Res_Users_48_Light.svg",
    "Resource-Icons_07312026/Res_General-Icons/Res_48_Dark/Res_Users_48_Dark.svg",
]


def test_package_url_is_found_in_page_html():
    html = '<a href="https://d1.awsstatic.com/x/Icon-package_07312026.abc.zip">Download</a>'
    assert fetch.find_package_url(html) == "https://d1.awsstatic.com/x/Icon-package_07312026.abc.zip"


def test_select_matches_wanted_files_and_skips_macos_metadata():
    picked = fetch.select(NAMES, {"aws-cloud": "AWS-Cloud-logo_32.svg"}, {"users": "Res_Users_48_Light.svg"})
    assert picked == {
        ("group", "aws-cloud"): "Architecture-Group-Icons_07312026/AWS-Cloud-logo_32.svg",
        ("generic", "users"): "Resource-Icons_07312026/Res_General-Icons/Res_48_Light/Res_Users_48_Light.svg",
    }


def test_select_raises_when_a_wanted_icon_is_missing():
    import pytest

    with pytest.raises(SystemExit, match="vpc"):
        fetch.select(NAMES, {"vpc": "Virtual-private-cloud-VPC_32.svg"}, {})
```

- [ ] **Step 2: Run RED** — `make scripts-setup && .venv/bin/python -m pytest diagrams/scripts/test_fetch_aws_icons.py -q` → FAIL (module missing).

- [ ] **Step 3: Implement `diagrams/scripts/fetch_aws_icons.py`**

```python
"""Fetch the official AWS Architecture Icons package and extract the group/generic icons diagrams use."""
from __future__ import annotations

import io
import json
import re
import sys
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

PAGE = "https://aws.amazon.com/architecture/icons/"
OUT = Path(__file__).resolve().parent.parent / "public" / "aws-icons"

GROUP = {
    "aws-cloud": "AWS-Cloud-logo_32.svg",
    "region": "Region_32.svg",
    "vpc": "Virtual-private-cloud-VPC_32.svg",
    "public-subnet": "Public-subnet_32.svg",
    "private-subnet": "Private-subnet_32.svg",
    "account": "AWS-Account_32.svg",
    "corporate": "Corporate-data-center_32.svg",
    "server": "Server-contents_32.svg",
}
GENERIC = {
    "users": "Res_Users_48_Light.svg",
    "client": "Res_Client_48_Light.svg",
    "internet": "Res_Internet_48_Light.svg",
    "server": "Res_Server_48_Light.svg",
    "office-building": "Res_Office-building_48_Light.svg",
    "firewall": "Res_Firewall_48_Light.svg",
    "data-table": "Res_Data-Table_48_Light.svg",
}


def find_package_url(html: str) -> str:
    match = re.search(r"https://[^\"' ]*Icon-package_[^\"' ]*\.zip", html)
    if not match:
        raise SystemExit(f"no Icon-package zip link found on {PAGE}")
    return match.group(0)


def select(names: list[str], group: dict[str, str], generic: dict[str, str]) -> dict[tuple[str, str], str]:
    usable = [n for n in names if not n.startswith("__MACOSX/")]
    picked: dict[tuple[str, str], str] = {}
    for kind, wanted in (("group", group), ("generic", generic)):
        for key, filename in wanted.items():
            hits = [n for n in usable if n.endswith("/" + filename)]
            if not hits:
                raise SystemExit(f"icon {kind}/{key} ({filename}) not found in the package")
            picked[(kind, key)] = hits[0]
    return picked


def main() -> None:
    request = urllib.request.Request(PAGE, headers={"User-Agent": "Mozilla/5.0"})
    html = urllib.request.urlopen(request, timeout=60).read().decode("utf-8", "replace")
    url = find_package_url(html)
    archive = zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(url, timeout=300).read()))
    picked = select(archive.namelist(), GROUP, GENERIC)
    manifest: dict[str, object] = {"package": url.rsplit("/", 1)[-1], "fetched": date.today().isoformat(), "group": {}, "generic": {}}
    for (kind, key), member in picked.items():
        target = OUT / kind / f"{key}.svg"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.read(member))
        manifest[kind][key] = f"{kind}/{key}.svg"  # type: ignore[index]
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wrote {len(picked)} icons from {manifest['package']}")


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: GREEN** — pytest → 3 passed. If `pytest` is missing from the venv, add it the way `scripts/pyproject.toml` declares dev deps and report.
- [ ] **Step 5: Makefile**

```make
diagrams-icons: scripts-setup ## Re-fetch the official AWS group/generic icons into diagrams/public/aws-icons
	.venv/bin/python diagrams/scripts/fetch_aws_icons.py
```

- [ ] **Step 6: Run it** — `make diagrams-icons` → 15 SVGs + manifest written. Open 2–3 SVGs with the Read tool (or render) to confirm they are the expected icons.
- [ ] **Step 7:** `python3 scripts/validate-comments.py diagrams/scripts/*.py Makefile` clean. Commit: `feat(diagrams): fetch official AWS group and generic icons`.

---

### Task 2: `AwsDiagramData` schema

**Files:**
- Create: `diagrams/src/aws/schema.ts`, `diagrams/test/aws-schema.test.ts`

**Interfaces:**
- Consumes: `AwsService` from `diagrams/src/schema.ts`.
- Produces: `GroupKind`, `GenericIcon`, `AwsDiagramData` (zod + inferred type).

- [ ] **Step 1: Failing test** — `diagrams/test/aws-schema.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { AwsDiagramData } from "../src/aws/schema";

const ok = {
  title: "Demo",
  direction: "RIGHT",
  groups: [
    { id: "cloud", kind: "aws-cloud", label: "AWS Cloud" },
    { id: "vpc", kind: "vpc", label: "VPC", parent: "cloud" },
  ],
  nodes: [
    { id: "browser", label: "Browser", icon: "client" },
    { id: "gw", label: "API Gateway", icon: "api-gateway", group: "cloud" },
    { id: "users", label: "Users", sublabel: "ECS task", icon: "ecs", group: "vpc" },
  ],
  edges: [
    { id: "e1", from: "browser", to: "gw", label: "HTTPS" },
    { id: "e2", from: "gw", to: "users" },
  ],
  steps: [{ edges: ["e1"], caption: "The browser calls the gateway." }, { edges: ["e2"], caption: "The gateway proxies to Users." }],
};

const issues = (v: unknown) => {
  const r = AwsDiagramData.safeParse(v);
  expect(r.success).toBe(false);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("AwsDiagramData", () => {
  it("accepts a valid diagram", () => {
    expect(AwsDiagramData.parse(ok).nodes).toHaveLength(3);
  });
  it("rejects an edge to an unknown node", () => {
    expect(issues({ ...ok, edges: [{ id: "e1", from: "browser", to: "ghost" }] })).toContain('unknown node "ghost"');
  });
  it("rejects a step referencing an unknown edge", () => {
    expect(issues({ ...ok, steps: [{ edges: ["nope"], caption: "x" }] })).toContain('unknown edge "nope"');
  });
  it("rejects a node in an unknown group", () => {
    expect(issues({ ...ok, nodes: [{ id: "x", label: "X", icon: "lambda", group: "nowhere" }] })).toContain('unknown group "nowhere"');
  });
  it("rejects a group cycle", () => {
    const cyc = { ...ok, groups: [{ id: "a", kind: "generic", label: "A", parent: "b" }, { id: "b", kind: "generic", label: "B", parent: "a" }], nodes: [], edges: [], steps: [] };
    expect(issues(cyc)).toContain('group cycle at "a"');
  });
  it("rejects duplicate ids across nodes and groups", () => {
    expect(issues({ ...ok, nodes: [...ok.nodes, { id: "vpc", label: "Dup", icon: "lambda" }] })).toContain('duplicate id "vpc"');
  });
  it("caps nodes at 24, steps at 10, captions at 90 chars", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, label: `N${i}`, icon: "lambda" as const }));
    expect(AwsDiagramData.safeParse({ ...ok, nodes: many, edges: [], steps: [] }).success).toBe(false);
    expect(AwsDiagramData.safeParse({ ...ok, steps: Array.from({ length: 11 }, () => ok.steps[0]) }).success).toBe(false);
    expect(AwsDiagramData.safeParse({ ...ok, steps: [{ edges: ["e1"], caption: "x".repeat(91) }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: RED** — `pnpm --filter @3mrai/diagrams test -- aws-schema` → FAIL.
- [ ] **Step 3: Implement `diagrams/src/aws/schema.ts`**

```ts
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
```

WHY the hard cap is 24 nodes: milestone graphs hold up to 24 tasks; the ~12 (flows) / 18 (architecture) caps are authoring rules in `diagrams/CLAUDE.md`, not schema rules.

- [ ] **Step 4: GREEN** — all aws-schema tests pass; typecheck clean.
- [ ] **Step 5:** comment validator; commit `feat(diagrams): add the AwsDiagram data schema`.

---

### Task 3: ELK layout

**Files:**
- Create: `diagrams/src/aws/measure.ts`, `diagrams/src/aws/layout.ts`, `diagrams/src/theme/aws-style.ts`, `diagrams/test/aws-layout.test.ts`
- Modify: `diagrams/package.json` (add `elkjs` exact)

**Interfaces:**
- Consumes: `AwsDiagramData`.
- Produces:
  - `aws-style.ts`: `AWS = { font, canvasBg:"#FFFFFF", ink:"#16191F", muted:"#545B64", edge:"#16191F", accent:"#147EB4", badge:"#147EB4", iconSize:48, taskW:150, taskH:54, groupPad:20, groupHeader:34, labelFont:13, edgeLabelFont:12, titleH:64, stepRowH:22 }` and `GROUP_STYLE: Record<GroupKind, { stroke: string; fill: string; dashed: boolean; icon?: "aws-cloud"|"region"|"vpc"|"public-subnet"|"private-subnet"|"account"|"corporate"|"server" }>` with AWS guideline colours: aws-cloud `#242F3E` solid, icon aws-cloud; region `#00A4A6` dashed, icon region; az `#00A4A6` dashed; vpc `#8C4FFF` solid, icon vpc; public-subnet `#7AA116` solid, fill `#F2F6E8`, icon public-subnet; private-subnet `#00A4A6` solid, fill `#E6F6F7`, icon private-subnet; account `#E7157B` solid, icon account; generic `#7D8998` dashed; corporate `#7D8998` solid, icon corporate; local-floci `#7D8998` solid, icon server; phase `#7D8998` dashed, fill `#FAFAFA`.
  - `measure.ts`: `textWidth(text: string, px: number): number` (Arimo ≈ 0.56em/char, bold not used), `wrap(text: string, px: number, maxW: number, maxLines: number): string[]`.
  - `layout.ts`: `type Rect={x,y,w,h}`; `type DiagramLayout = { width:number; height:number; groups: Record<string, Rect>; nodes: Record<string, Rect & { labelLines: string[] }>; edges: Record<string, { points: {x:number;y:number}[]; label?: Rect }> }`; `async function layoutDiagram(d: AwsDiagramData): Promise<DiagramLayout>` — coordinates absolute, diagram area offset by `AWS.titleH` from the top.

- [ ] **Step 1:** `pnpm --filter @3mrai/diagrams add -E elkjs@0.12.0`.
- [ ] **Step 2: Failing tests** — `diagrams/test/aws-layout.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { layoutDiagram, type Rect } from "../src/aws/layout";
import { AwsDiagramData } from "../src/aws/schema";

const inside = (a: Rect, b: Rect) => a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.w <= b.x + b.w + 0.5 && a.y + a.h <= b.y + b.h + 0.5;
const segHitsRect = (p: { x: number; y: number }, q: { x: number; y: number }, r: Rect) => {
  const pad = 2;
  const [x1, x2] = [Math.min(p.x, q.x), Math.max(p.x, q.x)];
  const [y1, y2] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
  return x2 > r.x + pad && x1 < r.x + r.w - pad && y2 > r.y + pad && y1 < r.y + r.h - pad;
};

const data = AwsDiagramData.parse({
  title: "T",
  direction: "RIGHT",
  groups: [
    { id: "cloud", kind: "aws-cloud", label: "AWS Cloud" },
    { id: "vpc", kind: "vpc", label: "VPC", parent: "cloud" },
    { id: "priv", kind: "private-subnet", label: "Private subnet", parent: "vpc" },
  ],
  nodes: [
    { id: "web", label: "Browser", icon: "client" },
    { id: "gw", label: "API Gateway", icon: "api-gateway", group: "cloud" },
    { id: "users", label: "Users service", icon: "ecs", group: "priv" },
    { id: "orders", label: "Orders service", icon: "ecs", group: "priv" },
    { id: "db", label: "RDS Postgres", icon: "rds", group: "priv" },
    { id: "q", label: "Events queue", icon: "sqs", group: "cloud" },
  ],
  edges: [
    { id: "a", from: "web", to: "gw", label: "HTTPS" },
    { id: "b", from: "gw", to: "users" },
    { id: "c", from: "gw", to: "orders" },
    { id: "d", from: "users", to: "db" },
    { id: "e", from: "orders", to: "q", async: true },
  ],
});

describe("layoutDiagram (real ELK)", async () => {
  const l = await layoutDiagram(data);
  it("gives every node and group a box inside the canvas", () => {
    for (const r of [...Object.values(l.nodes), ...Object.values(l.groups)]) {
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(l.width);
      expect(r.y + r.h).toBeLessThanOrEqual(l.height);
    }
  });
  it("keeps every node inside its group and every group inside its parent", () => {
    for (const n of data.nodes) if (n.group) expect(inside(l.nodes[n.id]!, l.groups[n.group]!)).toBe(true);
    for (const g of data.groups) if (g.parent) expect(inside(l.groups[g.id]!, l.groups[g.parent]!)).toBe(true);
  });
  it("routes edges orthogonally", () => {
    for (const e of Object.values(l.edges)) {
      for (let i = 1; i < e.points.length; i++) {
        const [p, q] = [e.points[i - 1]!, e.points[i]!];
        expect(Math.abs(p.x - q.x) < 0.5 || Math.abs(p.y - q.y) < 0.5).toBe(true);
      }
    }
  });
  it("never routes an edge through a node it does not connect", () => {
    for (const e of data.edges) {
      const pts = l.edges[e.id]!.points;
      for (const n of data.nodes) {
        if (n.id === e.from || n.id === e.to) continue;
        for (let i = 1; i < pts.length; i++) expect(segHitsRect(pts[i - 1]!, pts[i]!, l.nodes[n.id]!), `${e.id} crosses ${n.id}`).toBe(false);
      }
    }
  });
  it("is deterministic", async () => {
    expect(await layoutDiagram(data)).toEqual(l);
  });
});
```

- [ ] **Step 3: RED.**
- [ ] **Step 4: Implement** `measure.ts`, `aws-style.ts`, `layout.ts`. `layout.ts` requirements (the implementer writes the code; these are binding):
  - `import ELK from "elkjs/lib/elk.bundled.js"` (works in Node/vitest and in the Remotion bundle; no web worker).
  - Root options: `elk.algorithm: "layered"`, `elk.direction: d.direction`, `elk.hierarchyHandling: "INCLUDE_CHILDREN"`, `elk.edgeRouting: "ORTHOGONAL"`, `elk.layered.spacing.nodeNodeBetweenLayers: "70"`, `elk.spacing.nodeNode: "40"`, `elk.spacing.edgeLabel: "6"`, `elk.layered.considerModelOrder.strategy: "NODES_AND_EDGES"` (data order is a layout hint), `elk.padding: "[top=20,left=20,bottom=20,right=20]"`.
  - Groups become compound ELK nodes nested by `parent`; padding `[top=groupHeader+groupPad, left=groupPad, bottom=groupPad, right=groupPad]`; nodes become children of their group (or root).
  - Node size: icon nodes `width = max(iconSize + 24, widest wrapped label line + 8)`, `height = iconSize + 6 + lines*16 (+16 if sublabel)`; `task` nodes `taskW × taskH`. Labels wrap to ≤2 lines at `labelFont` within `max(110, iconSize+60)` px.
  - Edges: each edge goes in the ELK graph (`hierarchyHandling` lets cross-group edges route); edge labels are ELK labels sized by `textWidth(label, edgeLabelFont)+8 × 16`, placement `elk.edgeLabels.placement: "CENTER"`.
  - Convert ELK's container-relative coordinates to absolute (sum ancestor offsets for nodes, groups, edge sections and labels; edge sections are relative to the edge's container, per ELK docs), then shift everything down by `titleH`. `width/height` = root size; `height += titleH`.
  - Edge `points` = startPoint + bendPoints + endPoint of the (single) section.
  - If the "never crosses" test fails for valid inputs, tune options (e.g. `elk.layered.nodePlacement.strategy: "NETWORK_SIMPLEX"`, larger spacing) — do NOT weaken the test; report which options were needed.
- [ ] **Step 5: GREEN** — tests + typecheck. Comment validator. Commit `feat(diagrams): lay out AWS diagrams with ELK`.

---

### Task 4: `AwsDiagram` component, timing, Root + renderer wiring

**Files:**
- Create: `diagrams/src/aws/timing.ts`, `diagrams/src/aws/AwsDiagram.tsx`, `diagrams/src/aws/parts/{Group,NodeView,Connector,StepBadge,CaptionBar,StepList}.tsx`, `diagrams/test/aws-timing.test.ts`
- Modify: `diagrams/src/theme/aws-icons.ts` (add `groupIconSrc(kind)`, `genericIconSrc(name)` via `staticFile("aws-icons/<path from manifest>")`; keep `awsIcon(service)`), `diagrams/src/catalog.ts` (add the `aws` variant), `diagrams/src/Root.tsx` (register `aws` entries with `calculateMetadata`), `diagrams/src/scripts/render.ts` (GIF only when steps exist; `scale`), `diagrams/test/catalog.test.ts` (validate `aws` entries)

**Interfaces:**
- Consumes: `AwsDiagramData`, `layoutDiagram`, `DiagramLayout`, `AWS`, `GROUP_STYLE`.
- Produces:
  - `timing.ts`: `AWS_FPS = 24`, `AWS_INTRO = 12`, `AWS_STEP = 36`, `AWS_HOLD = 48`; `stepPanelHeight(steps: number): number` (`steps === 0 ? 0 : 16 + steps * AWS.stepRowH`); `awsDuration(steps: number): number` (`steps === 0 ? 1 : AWS_INTRO + steps * AWS_STEP + AWS_HOLD`); `activeStep(frame: number, steps: number): number | undefined` (undefined before INTRO and during HOLD); `gifScale(width: number): number` (`Math.min(1, 1200 / width)`); `isAnimated(data): boolean` (`data.steps.length > 0`).
  - Catalog: `| (Base & { primitive: "aws"; data: AwsDiagramData })`; `animated` is derived for `aws` entries (`isAnimated`), not declared.
  - Composition props: `{ data: AwsDiagramData; layout?: DiagramLayout }`; `calculateMetadata` computes `layout`, `width = layout.width`, `height = layout.height + stepPanelHeight(steps)`, `durationInFrames = awsDuration(steps)`, `fps = AWS_FPS`.

- [ ] **Step 1: Failing timing test** — `diagrams/test/aws-timing.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { activeStep, awsDuration, AWS_HOLD, AWS_INTRO, AWS_STEP, gifScale, stepPanelHeight } from "../src/aws/timing";

describe("aws timing", () => {
  it("is one frame for a step-less diagram", () => {
    expect(awsDuration(0)).toBe(1);
    expect(stepPanelHeight(0)).toBe(0);
  });
  it("lights steps in order and clears the highlight on the hold", () => {
    expect(activeStep(0, 3)).toBeUndefined();
    expect(activeStep(AWS_INTRO, 3)).toBe(0);
    expect(activeStep(AWS_INTRO + AWS_STEP, 3)).toBe(1);
    expect(activeStep(awsDuration(3) - 1, 3)).toBeUndefined();
    expect(awsDuration(3)).toBe(AWS_INTRO + 3 * AWS_STEP + AWS_HOLD);
  });
  it("scales wide GIFs down to 1200px and never up", () => {
    expect(gifScale(2400)).toBe(0.5);
    expect(gifScale(900)).toBe(1);
  });
});
```

- [ ] **Step 2: RED → implement `timing.ts` → GREEN.**
- [ ] **Step 3: Component (binding behaviour; implementer writes the JSX):**
  - White `AbsoluteFill`; title (bold 22px) + subtitle (14px muted) in the top `titleH` band.
  - Groups drawn outermost first: rectangle with `GROUP_STYLE` stroke (1.5px, dashed where set) and fill; official corner icon 32px at top-left (none for `az`, `generic`, `phase`), label 14px beside it.
  - Nodes: service icon via `awsIcon`, generic via `<Img src={genericIconSrc}>`, `task` as a white card with 1.5px `#7D8998` border, id (bold 12px) over label (13px); label lines centred under the icon, sublabel italic.
  - Connectors: SVG polyline from `layout.edges[id].points`, 1.5px `AWS.edge` (dashed `6 4` when `async`), small open arrowhead (marker sized in user space, drawn last so no stroke covers it), label text at `layout.edges[id].label` with a white halo.
  - Steps: for the active step, its edges switch to `AWS.accent`, 2.5px; every step whose index ≤ active (or all, on the hold) shows a badge — 22×22 rounded square (`rx 4`), fill `AWS.badge`, white bold 13px number — placed at the midpoint of the longest segment of the step's first edge; if two badges land on the same edge, offset the second by 26px along the segment.
  - `CaptionBar` (only while a step is active): dark bar over the bottom of the diagram area: "n. caption".
  - `StepList` (frames ≥ hold start, and on the PNG): panel below the diagram, height `stepPanelHeight`, each row "badge n + caption" 13px.
  - No animation on groups/nodes (frame 0 shows the full diagram).
- [ ] **Step 4: Root + catalog + renderer.**
  - Root: `aws` entries register `<Composition component={AwsDiagram} schema={PropsSchema.aws} calculateMetadata={…} />` per the interface above (add `aws: z.object({ data: AwsDiagramData })` to the existing `PropsSchema`).
  - `render.ts`: for `aws` entries, `animated = isAnimated(data)`; GIF via `renderMedia({ …, scale: gifScale(composition.width) })`; PNG via `renderStill` at full size; still `parseEntry` first.
  - `catalog.test.ts`: `aws` entries validated by `AwsDiagramData`.
- [ ] **Step 5: Smoke render** — add a TEMPORARY `aws` entry (the Task 3 test data plus 3 steps, output under git-ignored `diagrams/out/`), `make diagrams-render ID=<id>`, Read the PNG and compare against the AWS reference style (groups with corner icons and colours, icons with labels below, orthogonal black connectors, blue numbered badges, step list). Fix until it reads like an AWS reference diagram. Remove the temporary entry.
- [ ] **Step 6:** tests, typecheck, comment validator. Commit `feat(diagrams): render AWS-style diagrams with numbered steps`.

---

### Tasks 5–10: Migrate content (parallel, one group each)

**Executor:** `diagram-impl`. Each task rewrites its group's data files to `AwsDiagramData` (`primitive: "aws"`), keeps `id`, `output`, `source`, `watches` unchanged, renders its IDs and Reads every PNG.

| Task | Group file | Entries |
|---|---|---|
| 5 | `architecture.catalog.ts`, `system-context.catalog.ts` | architecture-dev-floci, architecture-preprod, system-context-l1, system-context-l2 |
| 6 | `milestones.catalog.ts` | 3 milestone graphs (phases = `phase` groups, tasks = `task` nodes, edges = deps, no steps) |
| 7 | `flows-initial.catalog.ts` | 5 initial flows |
| 8 | `flows-auth.catalog.ts` | 4 auth flows |
| 9 | `flows-shopping.catalog.ts` | 3 shopping flows |
| 10 | `flows-events.catalog.ts`, `flows-ops.catalog.ts` | 3 events + 4 ops flows |

Rules for every migration task:
- Read the CURRENT data file (it already encodes the reviewed content) and the sources it lists; convert, don't re-invent. Every node/edge/step must stay traceable to code/Terraform/vault.
- Groups: put AWS-hosted resources inside `aws-cloud` (pre-prod) or `local-floci` (local dev) → `vpc` → `private-subnet`/`public-subnet` where the Terraform places them; serverless/regional services (SQS, SNS, Cognito, S3, SES, Lambda, API Gateway, DynamoDB) inside the cloud group but outside the VPC unless Terraform puts them in it; browser/users and third parties (Stripe, Geoapify, OpenObserve when outside AWS) in a `corporate` or no group. Flows choose the environment the flow runs in (state it in the subtitle) — local dev unless the flow is pre-prod-specific.
- Flows: actors → nodes; each connection once as an edge; steps reference edges in order (a repeated connection reuses its edge); keep the reviewed captions.
- Architecture maps keep everything the reviews restored (stores, queues, realtime path); a map may add steps for one request path only if it stays ≤10.
- Step-less entries become PNG-only: delete their stale `.gif` (`rm`, the controller stages it) and list the owning notes whose embed must switch to `.png` in the report.
- Commit (controller): `docs(<area>): restyle <group> diagrams in the AWS reference style`.

---

### Task 11: Remove the old primitives

**Files:**
- Delete: `diagrams/src/primitives/**`, old `ArchitectureData`/`FlowData`/`DependencyData` and helpers in `diagrams/src/schema.ts` (keep `AwsService`, `NodeKind` only if still referenced), `diagrams/src/timing.ts`, `diagrams/test/layout.test.ts`, `diagrams/test/schema.test.ts` parts for old schemas, `diagrams/test/dependency-arrows.test.ts`
- Modify: `diagrams/src/catalog.ts` (only the `aws` variant; drop `primitive` field or keep it fixed to `"aws"` — choose the smaller diff and report), `diagrams/src/Root.tsx`, `diagrams/src/scripts/render.ts`, `diagrams/src/scripts/drift.ts` (implicit watches now `diagrams/src/aws/**`, `diagrams/src/theme/**`, `diagrams/public/aws-icons/**`, `diagrams/src/schema.ts`), `diagrams/test/drift.test.ts`

- [ ] **Step 1:** `grep -rn "primitives/\|ArchitectureData\|FlowData\|DependencyData\|from \"../timing\"\|from \"./timing\"" diagrams/src diagrams/test` → only files listed above.
- [ ] **Step 2:** delete/modify; update drift implicit-watch tests first (RED → GREEN).
- [ ] **Step 3:** tests, typecheck, `make diagrams-render` (all 26) — renders must be byte-identical to Tasks 5–10 output (old primitives no longer used); `make diagrams-check`.
- [ ] **Step 4:** Commit `refactor(diagrams)!: drop the pre-AWS primitives`.

---

### Task 12: Agent guide and agent definition

**Files:** `diagrams/CLAUDE.md`, `.claude/agents/diagram-impl.md` (then `make ai-sync`)

- [ ] Replace the primitives section with the AwsDiagram model (groups/nodes/edges/steps, `direction`, ELK does layout — never hand-position), the group-kind decision table (from the migration rules above), icon sources (service = `AwsService`, generic = `GenericIcon`, `task` for milestones; Remotion `diagrams-icons` refresh), sync vs async edges, steps (reuse edges, ≤10, captions ≤90), PNG-only when no steps, the visual check against the AWS reference style, and remove the obsolete home-grown-layout authoring rules (≤10-char cross-zone labels, adjacent zones, sub-columns, self-step clipping, ARCH_STEP). Keep: detail level, read-sources-first, write boundary, verify loop, GIF budget, never animate the whole canvas.
- [ ] `make ai-sync`; commit `docs(agents): teach diagram-impl the AWS reference style`.

---

### Task 13: Vault

**Executor:** `obsidian-vault`.
- [ ] `docs/shared/conventions/diagrams.md`: AWS reference style, single primitive, ELK layout, group kinds, icons (official package + `@nxavis/aws-icons`, `make diagrams-icons`), steps + step list, PNG-only rule; remove the obsolete authoring rules.
- [ ] `docs/shared/decisions/ADR-0023-remotion-diagrams.md`: add `## Style revision (2026-10-07)` (AWS reference style, ELK — EPL-2.0 OR GPL-3.0, acceptable for a dev-only tool; official icon package).
- [ ] `docs/lessons/diagram-legibility.md`: home-grown layout lessons → "use a real layout engine"; keep the GIF-size lesson.
- [ ] Switch embeds `.gif` → `.png` for every entry Tasks 5–10 reported as PNG-only.
- [ ] Spec `2026-10-07-aws-style-diagrams-design.md`: `status`, `## Implementation deviations` if any were ruled, `updated:`; previous spec's deviations section: note it is superseded for style by the new spec.
- [ ] `node scripts/validate-vault.mjs` green; commit `docs(vault): adopt the AWS reference style for diagrams`.

---

### Task 14: Final verification and gap audit

- [ ] Tests, typecheck, `make lint-comments`, `node scripts/validate-vault.mjs`, `make ai-sync-check`, `make diagrams-check` (no `STALE?`).
- [ ] `make diagrams-render` (all); Read every PNG; GIFs ≤ ~2 MB; report total binary size.
- [ ] `grep -rn "ArchitectureMap\|FlowSequence\|DependencyGraph\|ARCH_STEP" --include=*.md --include=*.ts . | grep -v node_modules | grep -v superpowers/` → only historical mentions.
- [ ] Run `spec-implementation-audit` (spec → code, code → docs, plan → repo); close gaps; re-run.
- [ ] Update PR #130's body `## Diagrams` (new architecture + one flow GIF) via `gh pr edit` after the user confirms the push (A/B/C/D/E menu).

## Related

- [[2026-10-07-aws-style-diagrams-design]]
- [[2026-10-06-remotion-diagrams-design]]
- [[ADR-0023-remotion-diagrams]]
- [[diagrams]]
- [[diagram-legibility]]
- [[scripting-language]]
