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
  // Orphan `*Input` components are pruned inside buildApp's swagger
  // `transformObject` (see routes.ts `pruneOrphanComponents`), so the YAML is
  // already clean here — no post-processing needed.
  const yamlSpec = app.swagger({ yaml: true });
  await app.close();

  // services/users/http/ -> services/users/  (../../../.. from http dir to service root)
  const here = dirname(fileURLToPath(import.meta.url));
  const out = resolve(here, "../../../../openapi.yaml");
  writeFileSync(out, yamlSpec);
  console.log(`Wrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
