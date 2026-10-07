import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import picomatch from "picomatch";
import { describe, expect, it } from "vitest";
import { AwsDiagramData } from "../src/aws/schema";
import { catalog } from "../src/catalog";

const repoRoot = new URL("../../", import.meta.url).pathname;
const tracked = execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" }).split("\n");

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
  it.each(catalog.map((e) => [e.id, e] as const))("%s data matches the aws schema", (_id, e) => {
    expect(() => AwsDiagramData.parse(e.data)).not.toThrow();
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
