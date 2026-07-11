// Generates services/users/openapi.yaml from the live routes. Run via
// `pnpm generate:openapi`. Builds the app with a minimal test container so it
// needs no database or real env: buildApp() skips singleton/service registration
// for any container that is not the shared diContainer, and we only call
// app.ready() + app.swagger() (no request injection), so no command mocks are
// required. E2E_TESTING_ENABLED is true so the file documents the full contract.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createContainer, asValue } from "awilix";

// `routes.ts` transitively imports `#shared/di/awilix-container`, which imports
// `#shared/config/env` for its `Env` type AND its `env` value (used to register
// the `env` singleton) — that value import runs `parseEnv()` eagerly at module
// load, before `main()` ever runs, regardless of which container `buildApp()`
// is called with. Seed harmless placeholders so that eager parse succeeds; none
// of these are read at runtime here since we never call `registerSingletons()`
// (buildApp() only does that for the shared `diContainer`, not our throwaway one).
process.env.DATABASE_WRITER_URL ??= "postgresql://localhost/generate-openapi";
process.env.DATABASE_READER_URL ??= "postgresql://localhost/generate-openapi";
process.env.COGNITO_USER_POOL_ID ??= "generate-openapi";
process.env.COGNITO_CLIENT_ID ??= "generate-openapi";
process.env.AWS_ENDPOINT_URL ??= "http://localhost:4566";
process.env.AWS_REGION ??= "us-east-1";
process.env.WEBHOOK_SECRET ??= "generate-openapi";

const { buildApp } = await import("./routes.ts");

async function main() {
  const container = createContainer({ injectionMode: "PROXY" });
  container.register({ env: asValue({ E2E_TESTING_ENABLED: true } as any) });

  const app = buildApp(container as any);
  await app.ready();
  // Object form (not { yaml: true }) so we can prune before serializing.
  const spec = app.swagger() as {
    components?: { schemas?: Record<string, unknown> };
  };
  const yamlSpec = app.swagger({ yaml: true });
  await app.close();

  // fastify-type-provider-zod emits BOTH an output variant (`User`) and an
  // input variant (`UserInput`) for every schema in `z.globalRegistry`, by
  // design — the suffix is not configurable. Our registered schemas
  // (User/AuthTokens/Error) are only ever used in responses, so their `*Input`
  // twins are orphans: nothing `$ref`s them. They bloat the spec that gets
  // imported into Apidog with confusingly-named duplicate models, so drop any
  // `*Input` component that has zero `$ref` anywhere else in the document.
  const schemas = spec.components?.schemas ?? {};
  const orphanInputs = Object.keys(schemas).filter((name) => {
    if (!name.endsWith("Input")) return false;
    const ref = `#/components/schemas/${name}`;
    // The provider stamps each component's own definition with `$id:
    // "#/components/schemas/Name"`, so the string appears once for the
    // definition itself. It is a real orphan only if there is NO OTHER
    // occurrence (i.e. no `$ref:` pointing at it) — so require count <= 1.
    const occurrences = yamlSpec.split(ref).length - 1;
    return occurrences <= 1;
  });

  // Rebuild the YAML from the pruned object. @fastify/swagger's yaml output is
  // produced by its bundled serializer; to avoid pulling a new YAML dependency,
  // strip each orphan block textually from the already-serialized YAML (the
  // blocks are 4-space-indented under `components.schemas`).
  let pruned = yamlSpec;
  for (const name of orphanInputs) {
    // Matches the `    Name:` header line through to (but not including) the
    // next 4-space-indented sibling key or a dedent.
    const block = new RegExp(`\\n {4}${name}:\\n(?: {5,}.*\\n| *\\n)*`, "g");
    pruned = pruned.replace(block, "\n");
  }

  // services/users/http/ -> services/users/  (../../../.. from http dir to service root)
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, "../../../../openapi.yaml");
  writeFileSync(out, pruned);
  console.log(`Wrote ${out}${orphanInputs.length ? ` (pruned ${orphanInputs.length} orphan *Input schemas)` : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
