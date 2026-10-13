import picomatch from "picomatch";
import type { CatalogEntry } from "../catalog";

export type DriftResult = { id: string; status: "stale" | "updated"; matches: string[] };

/** Rendering code every diagram depends on: a change here may alter any render. */
export const SHARED_RENDER_GLOBS = [
  "diagrams/src/aws/**",
  "diagrams/src/theme/**",
  "diagrams/public/aws-icons/**",
  "diagrams/src/schema.ts",
  "diagrams/src/Root.tsx",
  "diagrams/src/scripts/render.ts",
  "diagrams/package.json",
];

/** Tests never change what a diagram depicts, so they never make one stale. */
export const TEST_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/*_test.go", "**/test/**", "**/tests/**", "**/__tests__/**"];

const isTest = picomatch(TEST_GLOBS);

export function affectedDiagrams(
  changed: string[],
  entries: (Pick<CatalogEntry, "id" | "output" | "watches" | "source"> & { data?: { steps?: unknown[] } })[],
): DriftResult[] {
  const relevant = changed.filter((f) => !isTest(f));
  const results: DriftResult[] = [];
  for (const e of entries) {
    // CONTRACT: an entry's own data module and the shared rendering code are implicit watches.
    const isWatched = picomatch([...e.watches, e.source, ...SHARED_RENDER_GLOBS]);
    const matches = relevant.filter((f) => isWatched(f));
    if (matches.length === 0) continue;
    // CONTRACT: only an expected output counts as a re-render; a step-less entry renders a PNG and no GIF.
    const expected = e.data && !(e.data.steps ?? []).length ? [`${e.output}.png`] : [`${e.output}.gif`, `${e.output}.png`];
    const rendered = changed.some((f) => expected.includes(f));
    results.push({ id: e.id, status: rendered ? "updated" : "stale", matches });
  }
  return results;
}
