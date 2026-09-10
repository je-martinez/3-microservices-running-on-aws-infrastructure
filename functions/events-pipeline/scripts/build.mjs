// Bundles the Lambda into a single self-contained dist/handler.js. Type checking
// is not lost: `pnpm run build` runs `tsc --noEmit` first.
// CONTRACT: Bundle, do NOT emit with plain `tsc`. archive_file zips the contents
// of dist/ at the zip root, which carries no package.json and no node_modules,
// so unresolved `#` subpath imports kill the function on its first invocation
// with ERR_PACKAGE_IMPORT_NOT_DEFINED, before any handler code runs.
import { build } from "esbuild";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

// Clean, so a stale file from the previous `tsc`-based layout (which emitted a
// tree of per-module .js files) cannot linger in the zip.
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });

await build({
  absWorkingDir: root,
  entryPoints: ["src/handler.ts"],
  outfile: "dist/handler.js",
  bundle: true,
  platform: "node",
  // Matches infra/modules/lambda/variables.tf's runtime default (nodejs20.x).
  target: "node20",
  // CONTRACT: CJS, even though the source is ESM. The zip root has no
  // package.json to mark the file as ESM, and an ESM bundle emitted as .js loads
  // under local Node 24 (which sniffs module syntax) but dies on nodejs20.x with
  // ERR_REQUIRE_CYCLE_MODULE — so testing locally reports a false pass.
  format: "cjs",
  // Off deliberately: Terraform zips ALL of dist/, and the map outweighs the
  // bundle itself for a file the runtime reads only with --enable-source-maps.
  sourcemap: false,
  // CONTRACT: The AUTOMATIC JSX runtime, set explicitly in all three toolchains
  // (tsc, vitest, esbuild). esbuild defaults to CLASSIC, which needs React in
  // scope — the templates do not import it, so a classic bundle BUILDS FINE and
  // throws "React is not defined" on the first render in the deployed Lambda.
  // Do NOT add react/jsx-runtime, react-dom/server or @react-email/* to
  // `external`: nothing installs them next to the zip.
  jsx: "automatic",
  // CONTRACT: The `imports` map points `#` specifiers at ./src/*.ts only under
  // "development". Without this esbuild takes the "default" branch, looks for
  // dist/*.js it has not produced yet, and fails to resolve #domain/envelope.
  conditions: ["development"],
  // `mongodb`'s optional native/peer deps, required lazily and absent here.
  // esbuild resolves eagerly and would fail the build; the driver's own
  // try/catch handles their absence at runtime.
  external: [
    "kerberos",
    "@mongodb-js/zstd",
    "@aws-sdk/credential-providers",
    "mongodb-client-encryption",
    "snappy",
    "socks",
    "aws4",
    "gcp-metadata",
  ],
});

console.log("built dist/handler.js");
