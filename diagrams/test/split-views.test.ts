import { describe, expect, it } from "vitest";
import { AwsDiagramData } from "../src/aws/schema";
import { catalog } from "../src/catalog";
import { combinedMaps } from "./fixtures/combined-maps";

const view = (id: string) => {
  const e = catalog.find((c) => c.id === id);
  if (!e) throw new Error(`no catalog entry ${id}`);
  return AwsDiagramData.parse(e.data);
};

// A map split into a request-path view and an events view loses nothing: their union holds every node
// (with its icon) and every edge (with its endpoints) of the full map.
describe("split architecture views", () => {
  it.each(Object.entries(combinedMaps))("%s and its -events view cover the full map", (id, full) => {
    const views = [view(id), view(`${id}-events`)];
    const nodes = new Set(views.flatMap((v) => v.nodes.map((n) => `${n.id}:${n.icon}`)));
    const edges = new Set(views.flatMap((v) => v.edges.map((e) => `${e.id}:${e.from}->${e.to}`)));
    for (const [n, icon] of full.nodes) expect(nodes.has(`${n}:${icon}`), `node ${n} (${icon}) in neither view`).toBe(true);
    for (const [e, from, to] of full.edges) expect(edges.has(`${e}:${from}->${to}`), `edge ${e} ${from}->${to} in neither view`).toBe(true);
  });
});
