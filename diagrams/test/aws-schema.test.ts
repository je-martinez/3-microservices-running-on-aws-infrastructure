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
  it("rejects an edge to an unknown node or group", () => {
    expect(issues({ ...ok, edges: [{ id: "e1", from: "browser", to: "ghost" }] })).toContain('unknown node or group "ghost"');
  });
  it("accepts a group as an edge endpoint", () => {
    const d = AwsDiagramData.parse({ ...ok, edges: [{ id: "g1", from: "vpc", to: "browser" }, { id: "g2", from: "browser", to: "cloud" }], steps: [] });
    expect(d.edges.map((e) => [e.from, e.to])).toEqual([ ["vpc", "browser"], ["browser", "cloud"] ]);
  });
  it.each([
    ["a group to its own node", "vpc", "users"],
    ["a node to a group containing it", "users", "cloud"],
    ["a group to its child group", "cloud", "vpc"],
    ["a group to itself", "vpc", "vpc"],
  ])("rejects an edge from %s", (_what, from, to) => {
    expect(issues({ ...ok, edges: [{ id: "bad", from, to }], steps: [] })).toContain('edge "bad" connects a group to itself or its own content');
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
  it("rejects duplicate edge ids", () => {
    expect(issues({ ...ok, edges: [...ok.edges, { id: "e1", from: "gw", to: "users" }] })).toContain('duplicate edge id "e1"');
  });
  it("points issues at the failing entry", () => {
    const r = AwsDiagramData.safeParse({ ...ok, edges: [ok.edges[0], { id: "e2", from: "gw", to: "ghost" }] });
    expect(r.success ? [] : r.error.issues.map((i) => i.path.join("."))).toContain("edges.1");
  });
  it("caps nodes at 24, steps at 10, captions at 90 chars", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, label: `N${i}`, icon: "lambda" as const }));
    expect(AwsDiagramData.safeParse({ ...ok, nodes: many, edges: [], steps: [] }).success).toBe(false);
    expect(AwsDiagramData.safeParse({ ...ok, steps: Array.from({ length: 11 }, () => ok.steps[0]) }).success).toBe(false);
    expect(AwsDiagramData.safeParse({ ...ok, steps: [{ edges: ["e1"], caption: "x".repeat(91) }] }).success).toBe(false);
  });
});

describe("ECS clusters, VPC lanes and resource icons", () => {
  const lanes = [{ label: "us-east-1a", sublabel: "Public subnet 10.1.1.0/24" }, { label: "us-east-1b" }];
  const vpcWith = (extra: object) => ({ ...ok, groups: [ok.groups[0], { ...ok.groups[1], ...extra }] });
  it("accepts an ecs-cluster group and the ECS task, ECS service and ALB resource icons", () => {
    const d = AwsDiagramData.parse({
      ...ok,
      groups: [...ok.groups, { id: "cluster", kind: "ecs-cluster", label: "ECS cluster", parent: "vpc" }],
      nodes: [...ok.nodes, { id: "t", label: "Orders", sublabel: "Fargate · 1 task", icon: "ecs-task", group: "cluster" },
        { id: "s", label: "Svc", icon: "ecs-service", group: "cluster" }, { id: "lb", label: "ALB", icon: "alb", group: "vpc" }],
    });
    expect(d.groups.map((g) => g.kind)).toContain("ecs-cluster");
  });
  it("accepts 2 or 3 lanes on a vpc", () => {
    expect(AwsDiagramData.parse(vpcWith({ lanes })).groups[1]!.lanes).toEqual(lanes);
    expect(() => AwsDiagramData.parse(vpcWith({ lanes: [...lanes, { label: "us-east-1c" }] }))).not.toThrow();
  });
  const tooFew = [lanes[0]];
  const tooMany = [...lanes, { label: "c" }, { label: "d" }];
  it.each([ [tooFew], [tooMany] ])("rejects %j lanes (2 to 3 only)", (l) => {
    expect(AwsDiagramData.safeParse(vpcWith({ lanes: l })).success).toBe(false);
  });
  it("rejects lanes on a group that is not a vpc", () => {
    expect(issues({ ...ok, groups: [{ ...ok.groups[0], lanes }, ok.groups[1]] })).toContain('group "cloud" has lanes, but only a vpc may');
  });
  it("rejects a lane label over 40 characters", () => {
    expect(AwsDiagramData.safeParse(vpcWith({ lanes: [{ label: "x".repeat(41) }, { label: "b" }] })).success).toBe(false);
  });
});
