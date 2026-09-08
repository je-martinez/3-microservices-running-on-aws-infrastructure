// Bundles each Lambda entrypoint into a self-contained dist/<name>.js. Type
// checking is not lost: `pnpm run build` runs `tsc --noEmit` first.
// CONTRACT: Bundle, do NOT emit with plain `tsc`. archive_file zips the contents
// of dist/ at the zip root, which carries no package.json and no node_modules,
// so unresolved `#` subpath imports kill the function on its first invocation
// with ERR_PACKAGE_IMPORT_NOT_DEFINED, before any handler code runs.
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Clean, so a stale file from a previous layout cannot linger in the zip.
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: [
    "src/authorizer.ts",
    "src/connect.ts",
    "src/disconnect.ts",
    "src/default.ts",
  ],
  outdir: "dist",
  bundle: true,
  platform: "node",
  // Matches infra/modules/lambda/variables.tf's runtime default (nodejs20.x).
  target: "node20",
  // CONTRACT: CJS, even though the source is ESM. The zip root has no
  // package.json to mark the file as ESM, and an ESM bundle emitted as .js loads
  // under local Node 24 but dies on nodejs20.x with ERR_REQUIRE_CYCLE_MODULE —
  // so testing locally reports a false pass.
  format: "cjs",
  // Off deliberately — see events-pipeline/scripts/build.mjs for the size
  // rationale (the map is often larger than the bundle itself).
  sourcemap: false,
  // The package.json `imports` map resolves `#` specifiers to ./src/*.ts under
  // the "development" condition and to ./dist/*.js under "default". We are
  // BUILDING dist/, so the sources are the correct input — without this,
  // esbuild takes the "default" branch, looks for the .js files it has not
  // produced yet, and fails with "Could not resolve #shared/jwt".
  conditions: ["development"],
});

console.log("built dist/{authorizer,connect,disconnect,default}.js");
