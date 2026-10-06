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
