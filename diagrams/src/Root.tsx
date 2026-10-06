import { Composition } from "remotion";
import { catalog, type CatalogEntry } from "./catalog";
import { ArchitectureMap } from "./primitives/ArchitectureMap";
import { durationFor, FPS, HEIGHT, WIDTH } from "./timing";

function view(e: CatalogEntry) {
  switch (e.primitive) {
    case "architecture":
      return { component: ArchitectureMap, units: e.data.edges.length };
    default:
      throw new Error(`primitive ${e.primitive} is not registered yet`);
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
