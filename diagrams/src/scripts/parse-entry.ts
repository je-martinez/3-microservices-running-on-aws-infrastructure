import { z } from "zod";
import type { CatalogEntry } from "../catalog";
import { AwsDiagramData } from "../aws/schema";

/** The entry's data parsed by the aws schema; throws naming the entry and every zod issue. */
export function parseEntry(e: CatalogEntry): AwsDiagramData {
  const r = AwsDiagramData.safeParse(e.data);
  if (!r.success) throw new Error(`diagram "${e.id}" has invalid ${e.primitive} data:\n${z.prettifyError(r.error)}`);
  return r.data;
}
