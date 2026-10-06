import { Composition } from "remotion";
import { catalog, type CatalogEntry } from "./catalog";
import { ArchitectureMap } from "./primitives/ArchitectureMap";
import { DependencyGraph } from "./primitives/DependencyGraph";
import { FlowSequence } from "./primitives/FlowSequence";
import { ARCH_STEP, durationFor, FPS, HEIGHT, STEP, WIDTH } from "./timing";

function view(e: CatalogEntry) {
  switch (e.primitive) {
    case "architecture":
      return { component: ArchitectureMap, units: e.data.edges.length, step: ARCH_STEP };
    case "flow":
      return { component: FlowSequence, units: e.data.steps.length, step: STEP };
    case "dependency":
      return { component: DependencyGraph, units: 0, step: STEP };
    default:
      throw new Error(`unregistered primitive ${(e as { primitive: string }).primitive}`);
  }
}

export function Root() {
  return (
    <>
      {catalog.map((e) => {
        const { component, units, step } = view(e);
        return (
          <Composition key={e.id} id={e.id} component={component as never} defaultProps={{ data: e.data }}
            durationInFrames={durationFor(units, step)} fps={FPS} width={WIDTH} height={HEIGHT} />
        );
      })}
    </>
  );
}
