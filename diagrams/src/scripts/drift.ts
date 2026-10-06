import picomatch from "picomatch";
import type { CatalogEntry } from "../catalog";

export type DriftResult = { id: string; status: "stale" | "updated"; matches: string[] };

/** Rendering code every diagram depends on: a change here may alter any render. */
export const SHARED_RENDER_GLOBS = [
  "diagrams/src/primitives/**",
  "diagrams/src/theme/**",
  "diagrams/src/schema.ts",
  "diagrams/src/timing.ts",
];

/** Tests never change what a diagram depicts, so they never make one stale. */
export const TEST_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/*_test.go", "**/test/**", "**/tests/**", "**/__tests__/**"];

const isTest = picomatch(TEST_GLOBS);

export function affectedDiagrams(
  changed: string[],
  entries: Pick<CatalogEntry, "id" | "output" | "watches" | "source">[],
): DriftResult[] {
  const relevant = changed.filter((f) => !isTest(f));
  const results: DriftResult[] = [];
  for (const e of entries) {
    // CONTRACT: an entry's own data module and the shared rendering code are implicit watches.
    const isWatched = picomatch([...e.watches, e.source, ...SHARED_RENDER_GLOBS]);
    const matches = relevant.filter((f) => isWatched(f));
    if (matches.length === 0) continue;
    const rendered = changed.some((f) => f === `${e.output}.gif` || f === `${e.output}.png`);
    results.push({ id: e.id, status: rendered ? "updated" : "stale", matches });
  }
  return results;
}
