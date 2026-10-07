import { z } from "zod";
import { AwsDiagramData } from "./aws/schema";

// CONTRACT: AwsService lives in aws/schema.ts; importing it from there keeps the two schemas acyclic.
export { AwsService } from "./aws/schema";

/** Composition props: what Remotion Studio edits and render.ts validates. */
export const PropsSchema = {
  aws: z.object({ data: AwsDiagramData }),
} as const;
