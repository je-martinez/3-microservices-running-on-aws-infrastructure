import picomatch from "picomatch";
import type { CatalogEntry } from "../catalog";

export type DriftResult = { id: string; status: "stale" | "updated"; matches: string[] };

export function affectedDiagrams(
  changed: string[],
  entries: Pick<CatalogEntry, "id" | "output" | "watches">[],
): DriftResult[] {
  const results: DriftResult[] = [];
  for (const e of entries) {
    const isWatched = picomatch(e.watches);
    const matches = changed.filter((f) => isWatched(f));
    if (matches.length === 0) continue;
    const rendered = changed.some((f) => f === `${e.output}.gif` || f === `${e.output}.png`);
    results.push({ id: e.id, status: rendered ? "updated" : "stale", matches });
  }
  return results;
}
