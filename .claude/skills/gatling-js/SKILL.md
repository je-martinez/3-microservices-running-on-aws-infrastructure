---
name: gatling-js
description: Use when writing, running, or debugging load tests with Gatling JS (the JavaScript/TypeScript SDK) — simulations, scenarios, injection profiles, feeders, checks, assertions, virtual users, ramp-up, throughput, or the `npx gatling` CLI. Use it whenever the user mentions load testing, performance testing, stress or soak tests, generating traffic against an API, or benchmarking endpoints, even if they never say "Gatling" — and use it before writing any `.gatling.ts` file, because the DSL is easy to guess wrong and the Community Edition boundary is easy to cross by accident.
metadata:
  area: shared
  source: https://docs.gatling.io/tutorials/test-as-code/javascript/
  verified: 2026-08-13
  edition: Community (open source) — Enterprise commands flagged, never used
---

# Gatling JS — load testing in TypeScript

Gatling's JavaScript/TypeScript SDK: simulations are TS files, bundled by the
CLI and executed by the Gatling engine.

> [!warning] Simulations do not run in plain Node — verify third-party packages early
> The SDK's modules call `Java.type(...)` and only resolve inside Gatling's own
> runtime (`require("@gatling.io/core")` from a normal Node REPL fails with
> `ReferenceError: Java is not defined`). Your simulation code is bundled into
> `target/bundle.js` and run there, **not** on the Node binary that invoked the
> CLI.
>
> So a third-party package like [Chance.js](https://chancejs.com/) is plausible
> but not guaranteed: pure-JS libraries generally bundle fine, while anything
> touching Node built-ins (`fs`, `net`, native addons) may not. **Prove it with
> a one-request simulation before building a suite on top of it.** If it does not
> bundle, the fallback is Gatling's own feeders (`csv(...)`, `jsonFile(...)`)
> reading from `src/resources`, or generating the data in a pre-run Node script.

**Sources of truth** (verified 2026-08-13 — prefer them over memory, including
this file's, if they disagree):

| Topic | URL |
|---|---|
| Tutorial index | https://docs.gatling.io/tutorials/test-as-code/javascript/ |
| Installation | https://docs.gatling.io/tutorials/test-as-code/javascript/installation-guide/ |
| First simulation | https://docs.gatling.io/tutorials/test-as-code/javascript/running-your-first-simulation/ |
| Full SDK capabilities | https://docs.gatling.io/tutorials/test-as-code/javascript/full-sdk-capabilities/ |
| CLI reference | https://docs.gatling.io/integrations/build-tools/js-cli/ |
| Demo project | https://github.com/gatling/gatling-js-demo |
| Announcement | https://gatling.io/blog/javascript-load-testing |

## No JVM to install — this trips people up

Gatling's engine is JVM-based, so it is natural to assume you need a JDK. **You
do not.** `npx gatling run` downloads the Gatling runtime bundle itself, and
`@gatling.io/cli`'s own npm dependencies are pure Node (esbuild, archiver,
commander). The requirement is Node + npm, nothing else.

The docs state **Node.js LTS >24 with npm 11+**; the demo project's README says
Node 20+/npm 10+. Treat the docs' figure as the supported floor and check
`node -v && npm -v` before blaming a failure on your code.

This repo pins **24.18.0** in `.nvmrc`, which clears that bar — but the pin only
applies once `nvm use` has run. Note that `npm install` succeeds on older
versions too, so a stale shell fails later and more confusingly than it would if
install had rejected it.

## Community Edition — what is and is not available

This repo uses the **free/open-source Community Edition**. Everything needed to
write simulations, run them locally, and read the HTML report is included.

| Works in Community | Enterprise Edition only |
|---|---|
| `npx gatling run` — run locally | `npx gatling enterprise-deploy` |
| `npx gatling build` — bundle only | `npx gatling enterprise-start` |
| `npx gatling recorder` — record a browser session | distributed / multi-injector runs |
| the full DSL, assertions, HTML reports | the hosted dashboards and trend history |

If a task seems to need `enterprise-*`, it needs a paid account — say so rather
than scripting around it.

## Project layout

Each simulation file ends in **`.gatling.ts`** — that suffix is how the CLI finds
them.

```
load-tests/
├── package.json
├── tsconfig.json
├── resources/
│   ├── gatling.conf
│   └── logback-test.xml
└── src/
    └── <name>.gatling.ts
```

`package.json` needs three packages, all on the same version:

```json
{
  "dependencies": {
    "@gatling.io/core": "3.15.104",
    "@gatling.io/http": "3.15.104"
  },
  "devDependencies": { "@gatling.io/cli": "3.15.104" }
}
```

Useful scripts, mirroring the official demo:

```json
"check": "tsc --noEmit",
"build": "tsc --noEmit && gatling build --typescript",
"run":   "tsc --noEmit && gatling run --typescript --simulation <name>"
```

`tsc --noEmit` before every run is worth keeping: the SDK is heavily typed, and a
type error caught in a second beats one surfacing after a 60-second ramp.

## The shape of a simulation

Everything lives inside one `simulation((setUp) => { … })` callback: an HTTP
protocol, one or more scenarios, and an injection profile passed to `setUp`.

```ts
import { simulation, scenario, constantUsersPerSec, getParameter } from "@gatling.io/core";
import { http, status } from "@gatling.io/http";

export default simulation((setUp) => {
  // Parameters come from the CLI as `npx gatling run key=value`, so load
  // profiles are tunable without editing the file — the same simulation serves
  // a 10-second smoke run and a 30-minute soak.
  const usersPerSec = parseInt(getParameter("usersPerSec", "2"));
  const duration = parseInt(getParameter("duration", "60"));

  const httpProtocol = http
    .baseUrl("https://api.example.com")
    .acceptHeader("application/json");

  const scn = scenario("Browse")
    .exec(http("GET session").get("/session").check(status().is(200)))
    .pause(1)
    .exec(http("GET catalog").get("/catalog").check(status().in(200, 304)));

  setUp(scn.injectOpen(constantUsersPerSec(usersPerSec).during(duration)))
    .protocols(httpProtocol);
});
```

**Name every request** (`http("GET session")`). That string is the row label in
the report and in `details(...)` assertions — unnamed or duplicated names make a
report you cannot read.

## Injection profiles — open vs closed

An **open** model injects users at a rate regardless of how many are still in
flight; that is what you want for a public API, where real arrivals do not wait
for the server. A **closed** model holds a fixed population, which models a
queue or a fixed worker pool.

```ts
scn.injectOpen(
  nothingFor(5),                          // let the system settle first
  rampUsers(50).during(30),               // warm caches and connections
  constantUsersPerSec(10).during(60)      // the measurement window
)
```

Ramping first is not decoration: a cold JIT, an empty connection pool and an
unwarmed cache make the first seconds unrepresentative, and averaging them into
the result is how a healthy service looks slow.

Several scenarios can be injected together in one `setUp(...)` call, each with
its own profile — that is how you model a realistic mix (many browsers, few
writers) rather than one uniform behaviour.

## Data per virtual user

A scenario that **registers** users needs unlimited fresh values — a recycled
email collides with the row already created — while one that reads existing
records needs ids that actually exist. Two mechanisms, and the choice matters:

**Gatling's own feeders** are the safe default; they are part of the SDK and
always bundle. Put the file under `src/resources` so it ships with the bundle:

```ts
import { csv, jsonFile } from "@gatling.io/core";
const products = jsonFile("products.json").random();
const scn = scenario("Browse").feed(products).exec(/* ... */);
```

**A generator function** gives unlimited values, from a bundled library like
Chance.js or from plain JS. Confirm the library bundles first (see the warning
at the top) — plain `Math.random()` needs no dependency at all and is enough for
a unique email.

```ts
import Chance from "chance";
const chance = new Chance();

const scn = scenario("Register").exec(
  // A session function runs per virtual user, so each gets its own data.
  (session) => session.set("email", chance.email()).set("name", chance.name()),
  http("POST register")
    .post("/v1/users/register")
    .body(StringBody((session) => JSON.stringify({
      email: session.get<string>("email"),
      fullName: session.get<string>("name"),
    })))
    .check(status().is(201))
);
```

Feeding from a fixed list is still right when the data must already exist —
product ids, for instance:

```ts
const productFeeder = () => products[Math.floor(Math.random() * products.length)];
```

## Correlation — carrying values between requests

Real journeys depend on what the previous response returned: a token, an id, a
CSRF field. `check(...).saveAs("key")` puts it in the session; a function reads
it back.

```ts
.exec(
  http("POST login")
    .post("/v1/users/login")
    .check(status().is(200), jsonPath("$.accessToken").saveAs("token"))
)
.exec(
  http("GET me")
    .get("/v1/users/me")
    .header("Authorization", (session) => `Bearer ${session.get<string>("token")}`)
    .check(status().is(200))
)
```

Without correlation every virtual user hits the same id, which caches perfectly
and measures nothing. `css(...)`, `jsonPath(...)`, `regex(...)` and
`headerRegex(...)` all support `saveAs`.

## Composing journeys

`exec(...)` blocks are values, so they compose — extract each step once and
assemble scenarios from them rather than repeating request definitions.

```ts
const search = exec(http("Search").get("/search").check(status().is(200)));
const view   = exec(http("View item").get((s) => `/items/${s.get<string>("sku")}`));

const browse = scenario("Browse").repeat(3).on(search, view);
```

Control flow available: `repeat(n).on(...)`, `doIf(cond).then(...)`,
`randomSwitch().on(percent(70).then(a), percent(30).then(b))`, `pause(...)`.
`randomSwitch` is what makes a traffic mix look real — most users read, a few
write.

> [!tip] Check an API against the type definitions, not from memory
> The tutorial pages cover a fraction of the DSL — `randomSwitch`, `doIf`,
> `StringBody`, `headerRegex` and `injectClosed` all exist but appear in none of
> them, so "absent from the tutorial" says nothing about whether something is
> real. The `.d.ts` files are the authority and are greppable:
>
> ```bash
> grep -rho "\bsomeSymbol\b" node_modules/@gatling.io/*/ --include="*.d.ts" | head
> ```
>
> Note you cannot check by importing the package in Node — see the runtime
> warning at the top.

## Assertions — make the run pass or fail on its own

Without assertions a run always "succeeds" and someone has to eyeball the
report. With them, the CLI exits non-zero and the test is usable in CI.

```ts
setUp(...)
  .assertions(
    global().successfulRequests().percent().gt(99),
    details("Browse", "Search").responseTime().percentile3().lt(1500)
  )
```

Prefer percentiles to means. A mean hides the tail, and the tail is what users
actually complain about.

## Running

```bash
npx gatling run --typescript --simulation <name>     # <name> without .gatling.ts
npx gatling run --typescript --simulation <name> usersPerSec=20 duration=300
npx gatling run --help
```

The HTML report path is printed at the end of the run. Open it — the console
summary omits the percentile breakdown and per-request detail that explain a
result.

## Reading a result honestly

- **A ramp that never reaches its target rate** means the system under test is
  the bottleneck, not the injector — check the response-time graph before
  raising load further.
- **Errors clustered at the start** are usually cold-start, not a defect;
  errors that grow with load are the real signal.
- **Load-generator saturation invalidates the run.** If the machine running
  Gatling is itself at 100% CPU, every latency number includes injector queuing.
  Community Edition runs on one machine, so this is a real ceiling — say so
  rather than reporting the numbers as if they measured the server.

## Local-stack pitfalls (3MRAI)

- **Point at the gateway, not the service port.** Load that skips
  `API_GATEWAY_URL` also skips the JWT authorizer and nginx, so it measures a
  path no user takes.
- **Do not send E2E-only headers.** `x-e2e-source` tags rows for the E2E
  teardown to delete, and `x-test-mode` makes trackings self-advance. Both make
  the traffic unrealistic — and without `x-test-mode`, driving a tracking to
  DELIVERED means calling the carrier webhook, which is what a real carrier does.
- **Each virtual user needs its own token.** One shared JWT means one
  `cognito_sub`, which collapses every user-scoped read onto one row and hides
  the per-user query cost.
- **Load-test data is not cleaned up.** Without the E2E tag nothing deletes it;
  plan on `make clean` + rebuild to reset.

## Related

- `docs/superpowers/specs/2026-08-12-custom-business-metrics-cloudwatch-design.md`
  — the metrics this traffic is meant to make readable.
- `observability/dashboards/README.md` — the dashboards to check after a run.
- `e2e/support/` — existing Chance.js factories, Cognito auth, and the carrier
  key; read before rebuilding any of them.
