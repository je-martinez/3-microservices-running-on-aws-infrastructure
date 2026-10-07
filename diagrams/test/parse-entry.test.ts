import { describe, expect, it } from "vitest";
import { AwsDiagramData } from "../src/aws/schema";
import { catalog } from "../src/catalog";
import { parseEntry } from "../src/scripts/parse-entry";

describe("parseEntry", () => {
  it("returns the parsed data of a valid entry", () => {
    const e = catalog.find((x) => x.primitive === "aws")!;
    expect(parseEntry(e)).toEqual(AwsDiagramData.parse(e.data));
  });
  it("fails with the entry id and the zod issues", () => {
    const e = catalog.find((x) => x.primitive === "aws" && x.data.steps?.length)!;
    const broken = { ...e, id: "broken-flow", data: { ...e.data, steps: [{ edges: ["nobody"], caption: "y" }] } } as typeof e;
    expect(() => parseEntry(broken)).toThrow(/broken-flow[\s\S]*nobody/);
  });
});
