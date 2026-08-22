// Renders every entry of the events-pipeline email catalog to an HTML string,
// for the screenshot spec (tests/email-templates.spec.ts) to paint and capture.
//
// ## Why this does NOT drive the react-email preview server
//
// The obvious source for "screenshot every template" is the `email-preview`
// compose service (`docker compose --profile preview up email-preview`, host
// 3003 -> container 3000). It cannot do the job, for a reason that is structural
// rather than incidental:
//
//   The preview UI lists the FILES under `functions/events-pipeline/emails/`.
//   There are four of them (user-created, order-created,
//   tracking-status-changed, auth-otp). The catalog registers EIGHT entries,
//   because `tracking-status-changed.tsx` is ONE component that
//   src/email/catalog.ts registers FIVE times with different sampleProps (one
//   per status: PLACED, PROCESSING, SHIPPED, OUT_FOR_DELIVERY, DELIVERED).
//
// So the preview server can show four screenshots, not eight, and the five
// tracking variants — the ones that differ most, since each renders a different
// timeline slice and DELIVERED is the only sample without a shipping address —
// collapse into one image. Worse, the templates export no `PreviewProps`, so
// the preview renders them with UNDEFINED props: what it paints is not the mail
// a recipient receives, it is the empty-props degenerate case.
//
// Rendering straight from the catalog covers all eight entries with the real
// sample data the handlers and the snapshot tests use, and needs no running
// service at all.
//
// ## Why a subprocess instead of importing the catalog directly
//
// `#email/catalog` cannot be imported from this package. Three separate reasons,
// each sufficient on its own:
//
//   1. `e2e` does not depend on `@3mrai/events-pipeline`, react, or
//      @react-email/* — and adding those deps to a Playwright suite to render
//      JSX would be a heavy, duplicated toolchain.
//   2. The catalog's imports are `#`-prefixed subpath imports resolved through
//      the events-pipeline package.json `imports` map, which only points at the
//      TypeScript sources under the `development` condition.
//   3. The templates are `.tsx`. Playwright's TS transform does not handle JSX.
//
// The events-pipeline package already has everything needed (tsx, react,
// @react-email/render) and already runs its own suite that way. Shelling out to
// it borrows that toolchain instead of rebuilding it here.

// `spawn`, not `promisify(execFile)`. execFile's `input` option does not exist —
// that is execFileSync/spawnSync only — so an `input`-carrying options object is
// silently ignored and `tsx -` then blocks forever on an stdin that is never
// written or closed, surfacing as a hook timeout. Writing to the child's stdin
// explicitly is the async equivalent, and it also lets stderr be captured and
// reported, which execFile's error message drops.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pipelineDir = path.join(repoRoot, "functions", "events-pipeline");
const pipelineEnvPath = path.join(repoRoot, ".env.local.events-pipeline");

export interface RenderedTemplate {
  //: The CATALOG key (e.g. "tracking-status-changed-placed"), which is also the
  // screenshot filename. Deliberately the catalog key and not the source
  // filename — the whole point of this path is that five keys share one file.
  key: string;
  html: string;
}

// The script handed to `tsx` on stdin. Kept as a string rather than a committed
// file because it is an implementation detail of this helper and has no meaning
// outside it — and because a real file inside functions/events-pipeline would
// violate this task's "add only a spec" boundary.
//
// It prints ONE JSON object on stdout. Anything the render path logs to stderr
// (pino writes to stdout, but nothing in the render path logs) stays out of the
// parsed payload.
const RENDER_SCRIPT = `
import { catalog } from "#email/catalog";
import { renderTemplate } from "#email/renderer";

const rendered = [];
for (const [key, entry] of Object.entries(catalog)) {
  rendered.push({ key, html: await renderTemplate(key, entry.sampleProps) });
}
process.stdout.write(JSON.stringify(rendered));
`;

//: Why the dependency might be missing, phrased so a developer can act on it.
export class EmailCatalogUnavailableError extends Error {}

// Reads `.env.local.events-pipeline` for the CHILD process only.
//
// The render is not a pure JSX-to-string call: `#email/renderer` imports
// `#shared/observability/tracing` and `#shared/metrics/cloudwatch-metrics`,
// which pull in `#shared/config/env` — a Zod schema parsed at MODULE LOAD
// (ADR-0014). So the child dies during import, before rendering anything, unless
// DOCDB_*, SES_FROM_ADDRESS and ASSETS_BASE_URL are present. `playwright.config.ts`
// loads only .env.local.{infra,users,debug}, so inheriting `process.env` is not
// enough.
//
// PARSED into the child's env rather than `dotenv.config`'d into this process,
// for the same reason `.env.local.tracking` is cherry-picked there: this file
// shares names with the ones already loaded — the AWS_* quartet
// (AWS_ENDPOINT_URL, AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY) and
// METRICS_ENABLED. Loading it globally would leak the pipeline's values into
// every other spec's environment depending on array order; scoping it to the
// child leaves the suite untouched.
//
// It is merged UNDER `process.env`, so an explicitly exported shell variable
// still wins — the generated file is the default, not an override.
function readPipelineEnv(): Record<string, string> {
  if (!fs.existsSync(pipelineEnvPath)) {
    // Same class as a missing `tsx`, and skipped for the same reason: the file
    // is GENERATED by `make env-file` from Terraform outputs, so its absence
    // means the local stack was never provisioned — a missing prerequisite, not
    // a broken template. Failing here would paint a red suite on a fresh
    // checkout for something no template change can fix.
    throw new EmailCatalogUnavailableError(
      `${pipelineEnvPath} does not exist, so the events-pipeline environment the email ` +
        "renderer validates at import time (DOCDB_*, SES_FROM_ADDRESS, ASSETS_BASE_URL) " +
        "cannot be supplied. Run `make env-file` from the repo root.",
    );
  }
  return dotenv.parse(fs.readFileSync(pipelineEnvPath, "utf8"));
}

// Renders the whole catalog, or throws EmailCatalogUnavailableError when the
// events-pipeline package is not installed.
//
// This is the spec's SKIP condition. It is a genuinely different situation from
// the rest of the suite: every other spec needs the running stack, which
// global-setup already asserts, whereas this one needs only `pnpm install` to
// have been run in the workspace. A developer who has a checkout but no
// installed workspace should see a clear skip, not a red suite.
export async function renderCatalog(): Promise<RenderedTemplate[]> {
  // `tsx` is a devDependency of functions/events-pipeline. Its absence means the
  // workspace was never installed (or was installed with --prod), which is the
  // one condition this helper skips on.
  const tsxBin = path.join(pipelineDir, "node_modules", ".bin", "tsx");
  if (!fs.existsSync(tsxBin)) {
    throw new EmailCatalogUnavailableError(
      `tsx is not installed at ${tsxBin}, so the email catalog cannot be rendered. ` +
        "Run `nvm use && pnpm install` from the repo root.",
    );
  }

  // `--conditions=development` is REQUIRED, not a nicety. The package.json
  // `imports` map resolves `#email/*` to `./dist/email/*.js` by default and to
  // the TypeScript sources only under the `development` condition. Without it
  // this renders whatever stale bundle happens to sit in dist/ — or, far more
  // often, fails outright because dist/ was never built.
  //
  // Passed via NODE_OPTIONS rather than as a `tsx` flag: tsx forwards its own
  // argv to esbuild, and node-level conditions have to reach the node process.
  //
  // The script arrives on stdin (`tsx -` reads stdin) so no temporary file is
  // written into the events-pipeline package.
  const pipelineEnv = readPipelineEnv();

  const child = spawn(tsxBin, ["-"], {
    cwd: pipelineDir,
    env: {
      ...pipelineEnv,
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=development`.trim(),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
  child.stderr.on("data", (c: Buffer) => stderrChunks.push(c));

  child.stdin.end(RENDER_SCRIPT);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  const stdout = Buffer.concat(stdoutChunks).toString("utf8");
  const stderr = Buffer.concat(stderrChunks).toString("utf8");

  if (exitCode !== 0) {
    // NOT an EmailCatalogUnavailableError: tsx exists and the render still
    // failed, which means the templates or the catalog are broken. That is a
    // real defect and must fail the spec rather than skip it.
    throw new Error(
      `Rendering the email catalog failed inside ${pipelineDir} (tsx exited ${exitCode}). ` +
        "This is a template or catalog defect, not a missing dependency — the renderer ran " +
        `and threw.\n${stderr.trim() || "(no stderr)"}`,
    );
  }

  const parsed = JSON.parse(stdout) as RenderedTemplate[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(
      "The catalog renderer produced no templates. src/email/catalog.ts exports an empty " +
        "object, which would also mean the pipeline can send no email at all.",
    );
  }
  return parsed;
}
