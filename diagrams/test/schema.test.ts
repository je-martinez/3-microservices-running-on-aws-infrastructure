import { describe, expect, it } from "vitest";
import { ArchitectureData, DependencyData, FlowData } from "../src/schema";

// ZodError.message is a JSON dump (quotes escaped), so assert on the issue messages instead.
function issues(schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }, v: unknown) {
  const r = schema.safeParse(v);
  expect(r.success).toBe(false);
  return (r.error?.issues ?? []).map((i) => i.message);
}

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
    expect(issues(ArchitectureData, bad)).toContainEqual(expect.stringMatching(/unknown node "ghost"/));
  });
  it("rejects a node in an unknown zone", () => {
    const bad = { ...arch, nodes: [{ ...arch.nodes[0], zone: "nowhere" }, arch.nodes[1]] };
    expect(issues(ArchitectureData, bad)).toContainEqual(expect.stringMatching(/unknown zone "nowhere"/));
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
    expect(issues(FlowData, bad)).toContainEqual(expect.stringMatching(/unknown actor "ghost"/));
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
    expect(issues(DependencyData, bad)).toContainEqual(expect.stringMatching(/unknown task "JE-0"/));
  });
});
