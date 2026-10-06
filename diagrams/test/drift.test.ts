import { describe, expect, it } from "vitest";
import { affectedDiagrams } from "../src/scripts/drift";

const entries = [
  { id: "arch", output: "docs/00-overview/diagrams/arch", source: "diagrams/src/data/architecture/arch.ts", watches: ["infra/modules/**", "docker-compose.yml"] },
  { id: "otp", output: "docs/domains/users/specs/diagrams/otp", source: "diagrams/src/data/flows/otp.ts", watches: ["infra/modules/cognito/**", "services/users/src/**"] },
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

describe("affectedDiagrams implicit watches", () => {
  it("flags an entry whose own data module changed without a re-render", () => {
    expect(affectedDiagrams(["diagrams/src/data/flows/otp.ts"], entries)).toEqual([
      { id: "otp", status: "stale", matches: ["diagrams/src/data/flows/otp.ts"] },
    ]);
  });
  it("reports updated when the data module and its render changed together", () => {
    const r = affectedDiagrams(["diagrams/src/data/flows/otp.ts", "docs/domains/users/specs/diagrams/otp.gif"], entries);
    expect(r).toEqual([{ id: "otp", status: "updated", matches: ["diagrams/src/data/flows/otp.ts"] }]);
  });
  it.each(["diagrams/src/primitives/layout.ts", "diagrams/src/theme/tokens.ts", "diagrams/src/schema.ts", "diagrams/src/timing.ts"])(
    "flags every entry when shared rendering code %s changed",
    (f) => {
      expect(affectedDiagrams([f], entries).map((r) => [r.id, r.status])).toEqual([["arch", "stale"], ["otp", "stale"]]);
    },
  );
  it("keeps only the re-rendered entries off the stale list after a primitives change", () => {
    const r = affectedDiagrams(["diagrams/src/primitives/Arrow.tsx", "docs/00-overview/diagrams/arch.png"], entries);
    expect(r.map((x) => [x.id, x.status])).toEqual([["arch", "updated"], ["otp", "stale"]]);
  });
});

describe("affectedDiagrams ignores test files", () => {
  it.each([
    "services/users/src/users/commands/register.command.test.ts",
    "services/users/src/users/register.spec.ts",
    "infra/modules/cognito/main_test.go",
    "services/users/src/test/helpers.ts",
    "services/users/src/tests/fixtures.ts",
    "services/users/src/__tests__/x.ts",
  ])("does not flag a diagram for %s", (f) => {
    expect(affectedDiagrams([f], entries)).toEqual([]);
  });
  it("still flags the non-test files of the same diff", () => {
    const r = affectedDiagrams(["services/users/src/a.test.ts", "services/users/src/a.ts"], entries);
    expect(r).toEqual([{ id: "otp", status: "stale", matches: ["services/users/src/a.ts"] }]);
  });
});
