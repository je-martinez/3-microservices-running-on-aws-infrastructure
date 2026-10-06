import { Composition } from "remotion";
import { catalog, type CatalogEntry } from "./catalog";
import { ArchitectureMap } from "./primitives/ArchitectureMap";
import { DependencyGraph } from "./primitives/DependencyGraph";
import { FlowSequence } from "./primitives/FlowSequence";
import { durationFor, FPS, HEIGHT, WIDTH } from "./timing";

function view(e: CatalogEntry) {
  switch (e.primitive) {
    case "architecture":
      return { component: ArchitectureMap, units: e.data.edges.length };
    case "flow":
      return { component: FlowSequence, units: e.data.steps.length };
    case "dependency":
      return { component: DependencyGraph, units: 0 };
    default:
      throw new Error(`unregistered primitive ${(e as { primitive: string }).primitive}`);
  }
}

export function Root() {
  return (
    <>
      {catalog.map((e) => {
        const { component, units } = view(e);
        return (
          <Composition key={e.id} id={e.id} component={component as never} defaultProps={{ data: e.data }}
            durationInFrames={durationFor(units)} fps={FPS} width={WIDTH} height={HEIGHT} />
        );
      })}
    </>
  );
}
