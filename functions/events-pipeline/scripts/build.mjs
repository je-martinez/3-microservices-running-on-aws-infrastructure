// Bundles the Lambda into a single self-contained dist/handler.js.
//
// WHY A BUNDLER AND NOT PLAIN `tsc`:
// Terraform's archive_file zips the CONTENTS of dist/ at the ZIP ROOT
// (infra/modules/lambda/main.tf), so whatever is not inside dist/ does not
// ship. Plain `tsc` emitted files that still contained `import ... from
// "#domain/envelope"`, and Node resolves `#` subpath imports through the
// NEAREST package.json — which dist/ does not have. The deployed function
// therefore died on its first invocation with ERR_PACKAGE_IMPORT_NOT_DEFINED,
// before any handler code ran. `node_modules` was missing too, so `mongodb` and
// `zod` were unresolvable as well.
//
// Bundling fixes both at once: esbuild resolves the `#` specifiers at build
// time (it reads the real package.json `imports` map) and inlines the
// dependencies, so the zip is one file with no resolution left to do at
// runtime. The alternative — emitting a generated dist/package.json with
// rewritten `imports` plus a production install into dist/node_modules — would
// ship mongodb's whole tree and create a SECOND copy of the imports map that
// has to be kept in sync by hand with the real one.
//
// Type checking is NOT lost: `pnpm run build` runs `tsc --noEmit` first (see
// package.json). esbuild only strips types, it never checks them.
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
  // CommonJS, deliberately, even though the source is ESM ("type": "module").
  // The zip root contains handler.js and NO package.json, so the runtime has
  // nothing telling it the file is ESM and falls back to CommonJS by extension.
  // Verified empirically: an ESM bundle emitted as .js loads under Node 24
  // (which sniffs module syntax) but FAILS under the nodejs20.x runtime this
  // function targets, with ERR_REQUIRE_CYCLE_MODULE. Testing only on the local
  // Node would have reported a false pass. The alternative — emitting
  // handler.mjs — works too, but then the zip's entrypoint name depends on the
  // extension; CJS is unambiguous for a bare .js.
  format: "cjs",
  sourcemap: true,
  // The AUTOMATIC JSX runtime, for the `emails/*.tsx` templates that
  // src/email/catalog.ts imports. esbuild defaults to the CLASSIC runtime
  // (React.createElement), which needs React in scope in every template — they
  // don't import it, so a classic-runtime bundle BUILDS FINE and then throws
  // "React is not defined" on the first render inside the deployed Lambda.
  // esbuild does not read tsconfig's `jsx` when the option is set here, and
  // relying on it implicitly would leave three toolchains (tsc, vitest,
  // esbuild) each free to disagree; all three set it explicitly instead.
  //
  // Consequence for the bundle: react/jsx-runtime, react-dom/server and
  // @react-email/* are pulled in and INLINED (they are plain JS deps, not
  // native), which is what makes the single-file zip self-contained. They must
  // NOT be added to `external` below — nothing installs them next to the zip.
  jsx: "automatic",
  // The package.json `imports` map resolves `#` specifiers to ./src/*.ts under
  // the "development" condition and to ./dist/*.js under "default". We are
  // BUILDING dist/, so the sources are the correct input — without this,
  // esbuild takes the "default" branch, looks for the .js files it has not
  // produced yet, and fails with "Could not resolve #domain/envelope".
  conditions: ["development"],
  // `mongodb` pulls optional native/peer deps it only requires lazily
  // (kerberos, mongodb-client-encryption, aws4, snappy, ...). They are absent
  // and unused, but esbuild resolves imports eagerly and would fail the build.
  // Marking them external keeps them out of the bundle; the driver's own
  // try/catch handles their absence at runtime, exactly as it does today.
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
