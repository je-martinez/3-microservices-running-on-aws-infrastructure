// Bundles each Lambda entrypoint into a self-contained dist/<name>.js.
//
// WHY A BUNDLER AND NOT PLAIN `tsc`:
// Terraform's archive_file zips the CONTENTS of dist/ at the ZIP ROOT
// (infra/modules/lambda/main.tf), so whatever is not inside dist/ does not
// ship. Plain `tsc` would emit files that still contain `import ... from
// "#shared/jwt"`, and Node resolves `#` subpath imports through the NEAREST
// package.json — which dist/ does not have. The deployed function would
// therefore die on its first invocation with ERR_PACKAGE_IMPORT_NOT_DEFINED,
// before any handler code ran. `node_modules` would be missing too, so
// `aws-jwt-verify` and the AWS SDK clients would be unresolvable as well.
//
// Bundling fixes both at once: esbuild resolves the `#` specifiers at build
// time (it reads the real package.json `imports` map) and inlines the
// dependencies, so each zip is one file with no resolution left to do at
// runtime.
//
// Type checking is NOT lost: `pnpm run build` runs `tsc --noEmit` first (see
// package.json). esbuild only strips types, it never checks them.
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Clean, so a stale file from a previous layout cannot linger in the zip.
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

// esbuild, not tsc: tsc leaves the `#` subpath imports unresolved and dist/
// has no package.json to resolve them against, so the first invocation dies
// with ERR_PACKAGE_IMPORT_NOT_DEFINED. format: "cjs" is equally load-bearing:
// an ESM bundle emitted as .js loads under Node 24 but fails under the
// nodejs20.x runtime with ERR_REQUIRE_CYCLE_MODULE.
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
  // CommonJS, deliberately, even though the source is ESM ("type": "module").
  // The zip root contains <name>.js and NO package.json, so the runtime has
  // nothing telling it the file is ESM and falls back to CommonJS by
  // extension. Verified empirically (events-pipeline): an ESM bundle emitted
  // as .js loads under Node 24 (which sniffs module syntax) but FAILS under
  // the nodejs20.x runtime this function targets, with
  // ERR_REQUIRE_CYCLE_MODULE.
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
