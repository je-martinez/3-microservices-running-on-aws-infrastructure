import { Composition } from "remotion";
import { catalog, type CatalogEntry } from "./catalog";
import { ArchitectureMap } from "./primitives/ArchitectureMap";
import { DependencyGraph } from "./primitives/DependencyGraph";
import { FlowSequence } from "./primitives/FlowSequence";
import { PropsSchema } from "./schema";
import { ARCH_STEP, durationFor, FPS, HEIGHT, STEP, WIDTH } from "./timing";

const size = { fps: FPS, width: WIDTH, height: HEIGHT };

function view(e: CatalogEntry) {
  switch (e.primitive) {
    case "architecture":
      return <Composition key={e.id} id={e.id} component={ArchitectureMap} schema={PropsSchema.architecture} defaultProps={{ data: e.data }}
        durationInFrames={durationFor(e.data.edges.length, ARCH_STEP)} {...size} />;
    case "flow":
      return <Composition key={e.id} id={e.id} component={FlowSequence} schema={PropsSchema.flow} defaultProps={{ data: e.data }}
        durationInFrames={durationFor(e.data.steps.length, STEP)} {...size} />;
    case "dependency":
      return <Composition key={e.id} id={e.id} component={DependencyGraph} schema={PropsSchema.dependency} defaultProps={{ data: e.data }}
        durationInFrames={durationFor(0, STEP)} {...size} />;
    default:
      throw new Error(`unregistered primitive ${(e as { primitive: string }).primitive}`);
  }
}

export function Root() {
  return <>{catalog.map(view)}</>;
}
