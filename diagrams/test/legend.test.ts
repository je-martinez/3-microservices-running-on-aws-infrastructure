import { describe, expect, it } from "vitest";
import { legendKinds } from "../src/primitives/shared/Legend";

describe("legendKinds", () => {
  it("lists each kind once, in the tokens.kind order regardless of node order", () => {
    expect(legendKinds(["external", "data", "compute", "data", "edge"])).toEqual(["compute", "data", "edge", "external"]);
  });
});
