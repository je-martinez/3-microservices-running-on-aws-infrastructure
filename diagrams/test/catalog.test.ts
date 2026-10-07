import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import { catalog } from "../src/catalog";
import { depPath, layoutDependency, type Rect } from "../src/primitives/layout";
import { ArchitectureData, DependencyData, FlowData } from "../src/schema";
import { HEIGHT, WIDTH } from "../src/timing";

const repoRoot = new URL("../../", import.meta.url).pathname;
const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" }).split("\n");
const schemas = { architecture: ArchitectureData, flow: FlowData, dependency: DependencyData };

describe("catalog", () => {
  it("has unique ids and outputs", () => {
    expect(new Set(catalog.map((e) => e.id)).size).toBe(catalog.length);
    expect(new Set(catalog.map((e) => e.output)).size).toBe(catalog.length);
  });
  it("has unique output basenames (Obsidian resolves an embed by basename)", () => {
    const base = catalog.map((e) => e.output.split("/").pop());
    expect(base.filter((b, i) => base.indexOf(b) !== i)).toEqual([]);
  });
  it.each(catalog.map((e) => [e.id, e] as const))("%s: source is its tracked data module", (_id, e) => {
    expect(e.source).toMatch(/^diagrams\/src\/data\/.+\.ts$/);
    expect(existsSync(join(repoRoot, e.source)), `${e.source} does not exist`).toBe(true);
    expect(tracked, `${e.source} is not tracked by git`).toContain(e.source);
  });
  it.each(catalog.map((e) => [e.id, e] as const))("%s data matches its primitive schema", (_id, e) => {
    expect(() => schemas[e.primitive].parse(e.data)).not.toThrow();
  });
  it.each(catalog.map((e) => [e.id, e] as const))("%s: every watch glob matches a tracked file", (_id, e) => {
    for (const glob of e.watches) {
      const isMatch = picomatch(glob);
      expect(tracked.some((f) => isMatch(f)), `glob "${glob}" matches nothing`).toBe(true);
    }
  });
  it.each(catalog.map((e) => [e.id, e] as const))("%s output lives in a docs diagrams/ folder", (_id, e) => {
    expect(e.output).toMatch(/^docs\/.+\/diagrams\/[a-z0-9-]+$/);
  });
  const deps = catalog.flatMap((e) => (e.primitive === "dependency" ? [[e.id, e.data] as const] : []));
  it.each(deps)("%s: no dependency arrow runs through a task it does not connect", (_id, d) => {
    const l = layoutDependency(d, WIDTH, HEIGHT);
    const rects = Object.values(l.tasks);
    const inside = (x: number, y: number, r: Rect) => x > r.x + 1 && x < r.x + r.w - 1 && y > r.y + 1 && y < r.y + r.h - 1;
    for (const e of d.deps) {
      const a = l.tasks[e.from]!, b = l.tasks[e.to]!;
      const nums = depPath(a, b, rects).d.split(" ");
      const pts: [number, number][] = [];
      let x = 0, y = 0;
      for (let i = 0; i < nums.length;) {
        const c = nums[i++];
        if (c === "M" || c === "L") { x = Number(nums[i++]); y = Number(nums[i++]); } else if (c === "H") x = Number(nums[i++]); else if (c === "V") y = Number(nums[i++]);
        pts.push([x, y]);
      }
      for (let s = 1; s < pts.length; s++) for (let k = 0; k <= 100; k++) {
        const [x1, y1] = pts[s - 1]!, [x2, y2] = pts[s]!;
        const px = x1 + ((x2 - x1) * k) / 100, py = y1 + ((y2 - y1) * k) / 100;
        const hit = d.tasks.find((t) => t.id !== e.from && t.id !== e.to && inside(px, py, l.tasks[t.id]!));
        expect(hit, `${e.from} -> ${e.to} crosses ${hit?.id}`).toBeUndefined();
      }
    }
  });
});
