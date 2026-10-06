import { z } from "zod";
import type { CatalogEntry } from "../catalog";
import { PropsSchema } from "../schema";

/** The entry's data parsed by its primitive's schema; throws naming the entry and every zod issue. */
export function parseEntry<E extends CatalogEntry>(e: E): E["data"] {
  const r = PropsSchema[e.primitive].safeParse({ data: e.data });
  if (!r.success) throw new Error(`diagram "${e.id}" has invalid ${e.primitive} data:\n${z.prettifyError(r.error)}`);
  return r.data.data as E["data"];
}
