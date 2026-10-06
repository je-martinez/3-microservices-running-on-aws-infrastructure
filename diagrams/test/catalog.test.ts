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
      const isMatch = picomatch(glob);
      expect(tracked.some((f) => isMatch(f)), `glob "${glob}" matches nothing`).toBe(true);
    }
  });
  it.each(catalog.map((e) => [e.id, e] as const))("%s output lives in a docs diagrams/ folder", (_id, e) => {
    expect(e.output).toMatch(/^docs\/.+\/diagrams\/[a-z0-9-]+$/);
  });
});
