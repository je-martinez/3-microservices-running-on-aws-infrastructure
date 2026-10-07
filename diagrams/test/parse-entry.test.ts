import { describe, expect, it } from "vitest";
import { catalog } from "../src/catalog";
import { parseEntry } from "../src/scripts/parse-entry";

describe("parseEntry", () => {
  it("returns the parsed data of a valid entry", () => {
    const e = catalog[0]!;
    expect(parseEntry(e)).toEqual(e.data);
  });
  it("fails with the entry id and the zod issues", () => {
    const e = catalog.find((x) => x.primitive === "flow")!;
    const broken = { ...e, id: "broken-flow", data: { ...e.data, steps: [{ from: "web", to: "nobody", label: "x", caption: "y" }] } } as typeof e;
    expect(() => parseEntry(broken)).toThrow(/broken-flow[\s\S]*unknown actor "nobody"/);
  });
});
