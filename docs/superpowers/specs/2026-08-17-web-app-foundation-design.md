---
title: Web App Foundation & Pencil Design Extraction — Design
type: spec
area: shared
status: active
created: 2026-08-17
updated: 2026-08-17
tags: [type/spec, area/shared, status/active]
related:
  - "[[web-app-foundation-milestone]]"
  - "[[email-templates]]"
  - "[[package-manager]]"
  - "[[env-files]]"
  - "[[testing]]"
  - "[[scripting-language]]"
  - "[[doc-propagation]]"
  - "[[product-catalogue-image-categories-design]]"
  - "[[users-service-design]]"
propagates-to:
  - "[[index]]"
  - "[[testing]]"
---

# Web App Foundation & Pencil Design Extraction — Design

## Summary

The repo has a designed web app — `assets/web-app/web-app.pen`, 766 KB — and no web app. The
design has already been mined twice by other domains: the Orders catalogue was reshaped to
match its product cards ([[product-catalogue-image-categories-design]]) and the Users password
policy was checked against its forced-reset frames ([[users-service-design]]). Both times a
human opened Pencil, read the frames and transcribed the answer into a note. Nothing captured
the design itself.

This spec defines two things that depend on each other:

1. **`apps/web/`** — an Angular + NgRx + Tailwind application, scaffolded and navigable.
2. **`pencil-design-extraction`** — a skill that turns Pencil frames into Angular components,
   plus the `web-impl` agent that runs it and the convention note that records the rules.

**Scope boundary — phase 1 builds screens, not behaviour.** Every screen in the design is laid
out and reachable by routing. No screen calls the gateway, no NgRx effect issues an HTTP
request, and auth is structured but not wired. Phase 2 connects them, and is not specified
here.

**Size, measured rather than assumed.** The `.pen` holds 59 root frames: 20 reusable components
and 39 screen frames covering auth, catalogue, cart, checkout, orders, profile and
notifications — each at both 1440px and 390px. Phase 1 is therefore a substantial layout effort,
not a scaffold with three demo pages.

## Motivation

Three gaps, each of which has already cost something:

1. **The design is write-only.** A `.pen` file is an opaque binary that only Pencil reads.
   Every question about the design ("what colour is a primary button?", "what does the empty
   cart look like?") requires a human with the app open. Two specs already paid this cost.
2. **Design knowledge leaks into unrelated notes.** The palette and layout facts that exist
   today live scattered in an Orders spec and a Users decision, because there was nowhere
   better to put them. There is no equivalent of `assets/email/DESIGN.md` for the web.
3. **Nothing consumes the asset pipeline.** `sync_assets.py` already optimises, uploads and
   catalogues images with dimensions and BlurHash, and `assets/web-app/` already holds two
   GLSL shaders. The only consumer is the email templates.

## Decisions

### D1 — The `.pen` is the source of truth; three artefacts derive from it

```
assets/web-app/web-app.pen          ← source of truth (Pencil)
        │
        ├─[export: HTML Postwin]──→ apps/web/design/exports/<screen>.html
        │                             versioned snapshot, human reference
        │                             NEVER imported by production code
        │
        ├─[distilled]─────────────→ apps/web/DESIGN.md
        │                             tokens, components, screen→route map
        │                             consumed by humans AND by web-impl
        │
        └─[referenced assets]─────→ assets/web-app/*.png → make assets-sync
                                      → assets.manifest.json → bucket URL
```

`apps/web/src/` reads **none of them at runtime**. Components are hand-written against Tailwind
tokens (which come from `DESIGN.md`) and consume manifest URLs.

### D2 — The exported HTML is a reference, never a source

The export is read for **structure, measurements, typography and referenced images**. The Angular
component is then written by hand.

The original reasoning — "the export is flattened absolute CSS" — turned out to be **wrong for
the `html-tailwind` format**, which emits real flexbox and preserves layer names (see the table
in D4b). The decision survives its own rationale for different reasons:

- **It has no tokens.** Every colour is an arbitrary `bg-[#1F2733]`. Pasting the export
  hard-codes hex values throughout, which is exactly what D6 forbids.
- **It is fixed-width.** Each snapshot is one frame at one size (`w-[1440px]`), while components
  must be responsive across the 390/1440 pair (D8).
- **It carries scaffolding.** A `cdn.tailwindcss.com` script tag, Google Fonts links, and stock
  placeholder URLs (D5b) that must not reach production.
- **It has no component boundaries.** `data-pencil-name` marks a layer, not a reuse boundary;
  the 20 reusable components are known from the `.pen`, not from any single export.

What *does* change: copying a **structure** from the export (the flex nesting, gaps, ordering) is
now legitimate rather than a trap. It is styles and scaffolding that never travel.

### D3 — Exports are committed as snapshots

`apps/web/design/exports/<screen>.html`, one file per screen, committed verbatim.

Rationale: it answers "what did this screen look like in the design?" without opening Pencil,
and a diff in that folder makes a design change visible in a PR. Two rules keep it honest:

- **Committed exactly as exported.** Hand-editing an export turns it into a third source of
  truth that lies. Re-export instead.
- **A `README.md` in that folder states that nothing there is imported.** Without it, the next
  reader reasonably assumes the HTML is live code.

This reverses an earlier position in this design's own discussion (the export was first scoped
as a throwaway temp file). It is recorded as a decision because the tradeoff is real: the
snapshots cost repo weight and can go stale against the `.pen`. They earn it by making the
design reviewable by people who do not have Pencil.

### D4 — MCP is the primary reader; the HTML export is the fallback

The skill reads the design through the Pencil MCP server, because the `.pen` carries what a
flattened export loses: frame names (which become component names), hierarchy (which becomes
component boundaries) and **design variables** (which become tokens verbatim rather than
inferred from loose hex values).

That last point is not theoretical. `GetVariables()` returns 26 named tokens — `brand-navy`,
`text-primary`, `radius-md`, `field-height` — whose values match
`assets/email/DESIGN.md` exactly (`brand-navy` = `#2D3748`, `brand-orange` = `#F7941D`,
`text-primary` = `#1A1A2E`). **Email and web share one design system.** An HTML export would
have yielded the same colours as anonymous hex strings, and the shared system would have been
invisible.

**The bridge configuration matters and cost six failed attempts to find.** Pencil's *Cursor*
integration (`~/.pencil/mcp/cursor/… --app cursor --agent claudeCodeCLI`) fails every call with
`Failed to access file. A file needs to be open in the editor` even with the file demonstrably
open — the Pen renderer reports `connectedAgents: []` throughout, so the app never registers the
agent. Reconnecting does not help; it only leaks orphaned server processes.

The configuration that works is the binary **bundled inside the app**, run with `--app desktop`.

That binary lives at an absolute path whose filename encodes the platform
(`mcp-server-darwin-arm64`, `-linux-x64`, `win32-x64.exe`), so naming it directly in a committed
`.mcp.json` would make the repo work on exactly one machine. `.mcp.json` therefore invokes
`scripts/pencil_mcp.py`, which searches the known install locations for the current platform and
`exec`s what it finds:

```json
"pencil": {
  "command": "sh",
  "args": ["-c", "set -a && [ -f .env ] && . ./.env; set +a; exec python3 scripts/pencil_mcp.py"]
}
```

The `.env`-sourcing wrapper mirrors the neighbouring `apidog` entry. `PENCIL_MCP_BIN` in `.env`
overrides the search for installs the resolver does not know about; with no Pen installed it
exits non-zero with the paths it tried, on **stderr** — stdout is the MCP stdio channel and any
write there would be parsed as protocol.

The resolver never falls back to the per-editor bridges under `~/.pencil/mcp/<editor>/`. A
server that starts cleanly and then fails every call is worse than one that refuses to start.

Consequence for the skill: **it must announce which reader it used.** A silent fallback produces
tokens inferred from flattened CSS while the reader believes they came from design variables.

### D4b — `Export()` produces the HTML snapshots, not a manual UI export

The MCP `execute` API exposes
`Export(nodeIds, "html-tailwind" | "html-css", outputPath, options)`. The snapshots of D3 are
produced by this call with `format: "html-tailwind"` and `includeLayerNames: true`.

This supersedes the manual "export from the UI with HTML Postwin" step the design started from:
it is scriptable, repeatable, and names the output deterministically.

**Verified against the real export** (`Login — Email & Password`, 34 KB):

| Property | Observed | Consequence |
| --- | --- | --- |
| Layout | **Flexbox** (`flex flex-row gap-[10px]`); zero `position:absolute` | The export's structure is directly readable as the target layout — D2's "flattened absolute CSS" fear does not apply to this format |
| Layer names | `data-pencil-name="Brand Panel"`, `"Button Label"` | A snapshot maps back to its frame without opening Pencil |
| Icons | **Inline SVG**, annotated `data-icon-set="lucide"` + `data-icon-name="mail"` | Same Lucide set as the email templates; the name is enough to pick the icon in Angular |
| Colours | **Arbitrary values** — `bg-[#1F2733]`, never `bg-brand-navy-deep` | The export does **not** know the design variables. Tokens must come from `GetVariables()` (D6); copying the export's classes would hard-code every hex |
| Fonts | `fonts.googleapis.com` Inter | Self-hosted in the app; the CDN link is a snapshot artefact |
| Tailwind | `cdn.tailwindcss.com` script tag | Snapshot scaffolding only — another reason nothing here is imported (D3) |

The colour row is the load-bearing one: it is direct evidence for D6. The snapshot and the token
set answer different questions, and the skill needs both.

### D5b — Three kinds of asset reference, three resolutions

The export references images in three distinct ways, and the skill's asset step must recognise
all three. Only the first was anticipated:

1. **Local repo asset** — `bg-[url('../img/standalone-logo.png')]`, relative to the `.pen`.
   Resolve against `assets/`, then to the manifest URL. Note the pattern is a CSS
   `background-image`, not an `<img src>`, so scanning only `<img>` tags would miss it.
2. **Inline SVG icon** — `data-icon-set="lucide"`, `data-icon-name="mail"`. **Not an asset at
   all.** No file to sync; the Angular component renders the named Lucide icon. This is the web's
   advantage over email, where inline SVG is unusable (see [[email-templates]]) and the same
   icons had to become PNGs in the bucket.
3. **Remote stock placeholder** — an `images.unsplash.com` URL in the Brand Panel.
   **Neither a repo asset nor final artwork**, but a design-time placeholder. The skill must not
   copy it into `assets/`, and must not ship a template pointing at Unsplash. It flags the frame
   as needing real artwork and renders a token-coloured placeholder until one exists.

Category 3 has no owner yet: the brand photography is a content decision, not an engineering
one. Flagging it keeps it visible instead of silently shipping a third-party hotlink.

### D5 — Missing assets are copied and synced automatically

When an export references an image absent from `assets/assets.manifest.json`, the skill copies
it into `assets/web-app/` and runs `make assets-sync` without asking. This is the one place the
skill writes outside `apps/web/`.

`make assets-sync` requires `make post-infra` to have run — it reads the bucket name and base
URL from Terraform outputs. When the stack is down the sync fails; the skill **still copies the
files** and reports the pending command. Copying is safe and idempotent; blocking on
infrastructure that phase-1 layout work does not otherwise need is not.

Assets follow the existing pipeline unchanged: `sync_assets.py` optimises, uploads, and records
URL, dimensions and BlurHash. The skill adds no new upload logic.

### D6 — Design tokens land in Tailwind's theme, never as arbitrary values

The `.pen` defines **26 named variables**, read verbatim via `GetVariables()` and emitted into
`theme.extend`. A design colour is used as `bg-brand-navy`; `bg-[#2D3748]` is forbidden.

The arbitrary-value form is the detectable symptom of a skipped distillation step, which makes
this rule reviewable in a PR rather than a matter of taste.

The token set, as it exists today:

| Group | Tokens |
| --- | --- |
| Brand | `brand-navy` `#2D3748`, `brand-navy-deep` `#1F2733`, `brand-orange` `#F7941D`, `brand-orange-light` `#FFF4E5`, `brand-orange-text` `#C2710E` |
| Surfaces | `bg-body` `#F4F4F5`, `bg-white` `#FFFFFF`, `bg-subtle` `#FAFAFA` |
| Text | `text-primary` `#1A1A2E`, `text-secondary` `#6B7280`, `text-muted` `#9CA3AF`, `text-on-dark` `#E8EAEE` |
| Borders | `border-color` `#E5E7EB`, `border-strong` `#D1D5DB` |
| Semantic | `success-green` `#10B981`, `success-bg` `#ECFDF5`, `success-text` `#047857`, `danger-red` `#DC2626`, `info-blue` `#2563EB`, `info-bg` `#EFF6FF`, `warn-text` `#B45309`, `warn-bg` `#FFF7ED` |
| Type & metrics | `font-heading` Inter, `font-body` Inter, `radius-md` 10, `field-height` 56 |

**Web and email share one design system.** `brand-navy`, `brand-orange`, `text-primary`,
`success-green` and the Inter pairing are identical to `assets/email/DESIGN.md`. Changing a
brand colour is therefore a two-surface change, and the vault note must say so — this is the
kind of fact that is expensive to rediscover during a rebrand.

### D7 — Phase 1 data comes from fixtures typed against `openapi.yaml`

Screens render sample data whose **types** derive from the three services' `openapi.yaml`
files. Phase 2 then swaps the source, not the types or the templates.

Hardcoding the design's literal strings into templates was rejected: it makes phase 2 a
template rewrite rather than a data-source change.

### D8 — Desktop and mobile are one responsive component, not two

Every screen is built once with Tailwind breakpoints, using the 390px frame as the small layout
and the 1440px frame as the large one. Two components per screen would double the count to ~36
and guarantee divergence.

Where the two frames differ structurally rather than dimensionally — `Cart Drawer` (side drawer)
vs `Cart Sheet` (bottom sheet), `App Header` vs `Mobile App Header` with its `Menu Sheet` — the
shared component picks its presentation from a breakpoint, keeping one state model.

### D9 — Phase 1 verification is navigation E2E plus typecheck and lint

The repo's three-layer rule ([[testing]]) is written for HTTP endpoints; phase 1 ships none.
The layer that applies is a Playwright spec walking every route and asserting each screen
mounts without console errors, in the existing `e2e/` project. Component unit tests arrive in
phase 2 with the logic they would test.

## Architecture

### `apps/web/` layout

```
apps/web/
├── CLAUDE.md                  nested project memory (stack, conventions)
├── DESIGN.md                  distilled design system — D1
├── design/
│   ├── README.md              "nothing here is imported" — D3
│   └── exports/<screen>.html  committed snapshots — D3
├── src/
│   ├── app/
│   │   ├── core/              singletons: auth shell, HTTP client, guards
│   │   ├── shared/            reusable UI translated from design components
│   │   ├── features/<name>/   one folder per screen; standalone components
│   │   └── fixtures/          typed sample data — D7
│   └── styles.css             Tailwind entry
├── tailwind.config.ts         theme.extend fed from DESIGN.md — D6
└── package.json               @3mrai/web
```

Angular standalone components with signals throughout; NgRx for cross-screen state, with RxJS
confined to async streams. Phase 1 exercises little of the store — it is mounted so phase 2 does
not restructure the app to introduce it.

### Workspace integration

`apps/web` joins `pnpm-workspace.yaml`, and root `package.json` gains `web:dev` / `web:build` /
`web:test` following the existing `users:*` naming. pnpm only, never npm ([[package-manager]]);
Node pinned by `.nvmrc` (24.18.0) — `nvm use` first.

## The skill — `pencil-design-extraction`

`.claude/skills/pencil-design-extraction/`, a real directory alongside the 25 already installed.
Six steps, in order:

1. **Locate the source.** Read the `.pen` over MCP (`get_app_state`, `GetVariables()`, `Get()`);
   fall back to `apps/web/design/exports/*.html` if the bridge is unavailable; **state which one
   was used** — D4.
2. **Distil to `DESIGN.md`.** Colours, typography, scale, spacing, recurring components, and the
   screen→route map. Format modelled on `assets/email/DESIGN.md`, which is proven at the right
   level of detail. Update in place when it already exists.
3. **Export the snapshot.** `Export([frameId], "html-tailwind", "apps/web/design/exports/<screen>.html",
   {includeLayerNames: true})` — D3, D4b.
4. **Resolve assets.** Classify every image reference into the three kinds of D5b — local repo
   asset, inline Lucide icon (no file), remote stock placeholder (flag, never copy). For the
   first kind: diff against `assets.manifest.json`, copy missing files to `assets/web-app/`, run
   `make assets-sync`, and report the pending command if the stack is down — D5.
5. **Emit tokens to Tailwind.** The 26 design variables into `theme.extend` — D6.
6. **Write the Angular component.** Standalone, signals, semantic Tailwind, responsive across the
   390/1440 pair — D8. The export is a visual reference, never pasted — D2.

### `web-impl` agent

`.claude/agents/web-impl.md`, following the `<svc>-impl` pattern exactly: writes **source code
only**, never runs git, never touches Linear, leaves work in the working tree for the main
session to commit. Tools `Read, Write, Edit, Bash, Glob, Grep, Skill`. Reads `apps/web/CLAUDE.md`
and uses the extraction skill.

Registration in the root `CLAUDE.md` — both the "Subagents" list and the "Implementation agents
& flow" domain-layer list — is part of the work, not a follow-up.

### Convention note

`docs/shared/conventions/pencil-design-extraction.md`, written by `obsidian-vault` (sole writer
of `docs/`), in English, with frontmatter and `## Related`. Per the repo's golden rule the vault
note comes first; any assistant-memory pointer is secondary.

## Screens

Read from the `.pen` via MCP: **59 root frames** — 20 reusable components and 39 screen frames.
Nearly every screen exists twice, at **1440px desktop** and **390px mobile**, which makes
responsiveness a design requirement rather than an implementation afterthought (see D8).

### Reusable components (20)

Primitives: `Logo Lockup`, `Field`, `Button Primary`, `Button Ghost`, `OTP Digit`,
`Status Badge`, `Tracking Status Icon`.
Composites: `Brand Panel`, `Mobile Brand Header`, `App Header`, `Mobile App Header`,
`Product Card`, `Cart Line`, `Cart Drawer`, `Account Menu`, `Order Card`, `Mobile Order Card`,
`Notification Item`, `Notifications Panel`, `Toast Notification`.

These map to `apps/web/src/app/shared/`. Two frames — `Status Badge — States` and
`Tracking Status — Icons` — are variant sheets, not components: they document every state a
badge or icon can take and are a spec for the component's inputs, not a screen to build.

### Screens by area

| Area | Desktop frame | Mobile frame |
| --- | --- | --- |
| Auth | `Login — Email & Password` | `Mobile — Login Email & Password` |
| Auth | `Login — Passwordless` | `Mobile — Login Passwordless` |
| Auth | `Verify Code — OTP` | `Mobile — Verify Code` |
| Auth | `Register — Email & Password` | `Mobile — Register Email & Password` |
| Auth | `Register — Passwordless` | `Mobile — Register Passwordless` |
| Auth | `Set New Password — Forced` | `Mobile — Set New Password` |
| Catalogue | `Home — Products` | `Mobile — Home Products` |
| Cart | `Home — Cart Open (saved address)` | `Mobile — Cart (saved address)` |
| Cart | `Home — Cart Open (no address)` | `Mobile — Cart (no address)` |
| Checkout | `Checkout — Payment` | `Mobile — Checkout Payment` |
| Checkout | `Home — Cart Payment (Stripe)` | `Mobile — Cart Payment (Stripe)` |
| Account | `Profile` | `Mobile — Profile` |
| Account | `Home — Account Menu` | `Mobile — Account Menu` |
| Orders | `Orders — List` | `Mobile — Orders List` |
| Orders | `Orders — Detail` | `Mobile — Orders Detail` |
| Notifications | `Home — Notifications (Unread)` | `Mobile — Notifications (Unread)` |
| Notifications | `Home — Notifications (Read)` | `Mobile — Notifications (Read)` |
| Notifications | `Home — Notification Toast` | `Mobile — Notification Toast` |

Three observations the route map has to absorb:

1. **Cart and notifications are overlays, not pages.** Their frames are named `Home — Cart
   Open`, `Home — Account Menu`, `Home — Notifications` and carry a `Scrim` + drawer/panel over
   a full `Page`. They are UI state on top of a route, not routes of their own.
2. **Paired frames are one screen in two states.** `Cart Open (saved address)` vs
   `(no address)`, `Notifications (Unread)` vs `(Read)` — one component, different inputs.
3. **The design covers payment (Stripe).** Well beyond phase 1, and beyond anything the backend
   exposes today. Phase 1 lays out the screens; wiring is out of scope here.

### Deferred: the route map

Screen→route assignment is written into `DESIGN.md` by the skill's step 2 on its first run, once
frame contents (not just names) are read. The inventory above is the input to that step; naming
the routes here from frame titles alone would be a guess committed to a spec.

## Testing

Per D9:

- **Navigation E2E** in `e2e/`: every route reachable, every screen mounts clean.
- **Typecheck and lint** on `apps/web` in CI.
- **No component unit tests in phase 1.**

The existing `e2e/screenshots/` folder makes visual capture available later without new
infrastructure.

## Risks

| Risk | Mitigation |
| --- | --- |
| The wrong Pencil MCP binary is configured, silently degrading every run to the fallback | `.mcp.json` pins the bundled `--app desktop` binary; the skill announces its reader (D4) |
| 39 screens is a large phase 1 that could stall half-built | Components before screens; screens grouped by area (auth → catalogue → cart → orders → notifications), each group independently mergeable |
| Committed exports drift from the `.pen` | Re-export is part of any design-change task; exports are never hand-edited (D3) |
| An Unsplash placeholder ships as production artwork, hotlinking a third party | The skill flags category-3 references and renders a token-coloured placeholder instead (D5b); real brand photography is an open content decision |
| Phase-1 fixtures ossify into the app | Types come from `openapi.yaml` (D7), so phase 2 changes the source, not the shape |
| `DESIGN.md` drifts from the `.pen` | It is regenerated by step 2 on every extraction run, not maintained by hand |

## Related

- [[web-app-foundation-milestone]] — the milestone-level map: task sequence, phases, dependency graph
- [[email-templates]] — the precedent: a `.pen` distilled into a design system consumed by code
- [[product-catalogue-image-categories-design]] — first spec mined from `web-app.pen`
- [[users-service-design]] — password checklist read from the forced-reset frames
- [[package-manager]] — pnpm only
- [[env-files]] — generated env files, never hand-edited
- [[testing]] — the three-layer rule and why phase 1 applies one of them
- [[doc-propagation]] — how this spec's decisions reach the organised vault
