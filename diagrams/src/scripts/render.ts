import { mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { catalog } from "../catalog";

const pkgRoot = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const GIF_BUDGET = 2 * 1024 * 1024;

const wanted = process.argv.slice(2).flatMap((a) => a.split(",")).filter(Boolean);
const unknownIds = wanted.filter((id) => !catalog.some((e) => e.id === id));
if (unknownIds.length) {
  console.error(`unknown diagram id(s): ${unknownIds.join(", ")}`);
  process.exit(1);
}
const entries = wanted.length ? catalog.filter((e) => wanted.includes(e.id)) : catalog;

const serveUrl = await bundle({ entryPoint: join(pkgRoot, "src/index.ts") });
const kb = (p: string) => `${Math.round(statSync(p).size / 1024)} KB`;

for (const e of entries) {
  const composition = await selectComposition({ serveUrl, id: e.id, inputProps: { data: e.data } });
  const base = join(repoRoot, e.output);
  mkdirSync(dirname(base), { recursive: true });
  if (e.animated !== false) {
    // WHY: 24 fps composition, every 2nd frame gives a ~12 fps GIF; scale 1 keeps it at 1200px wide.
    await renderMedia({ serveUrl, composition, codec: "gif", everyNthFrame: 2, outputLocation: `${base}.gif`, inputProps: { data: e.data } });
    const size = statSync(`${base}.gif`).size;
    console.log(`${e.id}.gif ${kb(`${base}.gif`)}${size > GIF_BUDGET ? "  WARNING: over the 2 MB budget" : ""}`);
  }
  await renderStill({ serveUrl, composition, frame: composition.durationInFrames - 1, output: `${base}.png`, inputProps: { data: e.data } });
  console.log(`${e.id}.png ${kb(`${base}.png`)}`);
}
