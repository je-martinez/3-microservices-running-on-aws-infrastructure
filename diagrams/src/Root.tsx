import { Composition, type CalculateMetadataFunction } from "remotion";
import { z } from "zod";
import { AwsDiagram, type AwsDiagramProps } from "./aws/AwsDiagram";
import { layoutDiagram } from "./aws/layout";
import { AwsDiagramData } from "./aws/schema";
import { canvasSize } from "./aws/canvas";
import { AWS_FPS, awsDuration } from "./aws/timing";
import { catalog } from "./catalog";
import { PropsSchema } from "./schema";

// WHY: ELK runs once per composition here, so canvas size and duration follow the diagram and frames only read positions.
const awsMetadata: CalculateMetadataFunction<AwsDiagramProps> = async ({ props, compositionId }) => {
  const parsed = AwsDiagramData.safeParse(props.data);
  if (!parsed.success) throw new Error(`diagram "${compositionId}" has invalid aws data:\n${z.prettifyError(parsed.error)}`);
  const data = parsed.data;
  const layout = await layoutDiagram(data);
  const canvas = canvasSize(data, layout);
  return { props: { data, layout }, width: canvas.width, height: canvas.height, durationInFrames: awsDuration(data.steps.length), fps: AWS_FPS };
};

// WHY width/height/duration are placeholders: calculateMetadata replaces all three once ELK has laid the diagram out.
export function Root() {
  return (
    <>
      {catalog.map((e) => (
        <Composition key={e.id} id={e.id} component={AwsDiagram} schema={PropsSchema.aws} defaultProps={{ data: e.data as AwsDiagramData }}
          calculateMetadata={awsMetadata} width={1200} height={675} durationInFrames={1} fps={AWS_FPS} />
      ))}
    </>
  );
}
