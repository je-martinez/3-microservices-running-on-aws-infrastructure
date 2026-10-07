import { Composition, type CalculateMetadataFunction } from "remotion";
import { z } from "zod";
import { AwsDiagram, type AwsDiagramProps } from "./aws/AwsDiagram";
import { layoutDiagram } from "./aws/layout";
import { AwsDiagramData } from "./aws/schema";
import { canvasSize } from "./aws/canvas";
import { AWS_FPS, awsDuration } from "./aws/timing";
import { catalog, type CatalogEntry } from "./catalog";
import { ArchitectureMap } from "./primitives/ArchitectureMap";
import { DependencyGraph } from "./primitives/DependencyGraph";
import { FlowSequence } from "./primitives/FlowSequence";
import { PropsSchema } from "./schema";
import { ARCH_STEP, durationFor, FPS, HEIGHT, STEP, WIDTH } from "./timing";

const size = { fps: FPS, width: WIDTH, height: HEIGHT };

// WHY: ELK runs once per composition here, so canvas size and duration follow the diagram and frames only read positions.
const awsMetadata: CalculateMetadataFunction<AwsDiagramProps> = async ({ props, compositionId }) => {
  const parsed = AwsDiagramData.safeParse(props.data);
  if (!parsed.success) throw new Error(`diagram "${compositionId}" has invalid aws data:\n${z.prettifyError(parsed.error)}`);
  const data = parsed.data;
  const layout = await layoutDiagram(data);
  const canvas = canvasSize(data, layout);
  return { props: { data, layout }, width: canvas.width, height: canvas.height, durationInFrames: awsDuration(data.steps.length), fps: AWS_FPS };
};

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
    case "aws":
      return <Composition key={e.id} id={e.id} component={AwsDiagram} schema={PropsSchema.aws} defaultProps={{ data: e.data as AwsDiagramData }}
        calculateMetadata={awsMetadata} {...size} durationInFrames={1} fps={AWS_FPS} />;
    default:
      throw new Error(`unregistered primitive ${(e as { primitive: string }).primitive}`);
  }
}

export function Root() {
  return <>{catalog.map(view)}</>;
}
