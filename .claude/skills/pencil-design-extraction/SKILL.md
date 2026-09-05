---
name: pencil-design-extraction
description: Use when translating a Pencil .pen design into code — reading frames, extracting design tokens, exporting HTML snapshots, resolving referenced images, or writing an Angular component from a design frame. Use it before touching apps/web/src or assets/web-app/web-app.pen, because .pen files are encrypted and only reachable over the Pencil MCP server, and the bridge that looks correct is the one that silently fails every call.
metadata:
  area: shared
  source: docs/superpowers/specs/2026-08-17-web-app-foundation-design.md
  verified: 2026-08-18
---

# Pencil design extraction — from `.pen` frame to Angular component

Six steps, always in this order, for turning a frame in `assets/web-app/web-app.pen`
into working code under `apps/web/src`. This skill is the **procedure**; the current
state of the design system it produced (the token table, the component → path
mapping, the route table) lives in `apps/web/DESIGN.md` — read that first for *what
exists*, this skill for *how to extract more of it*. `apps/web/CLAUDE.md` covers the
app's stack and the Tailwind/`NG_APP_*` golden rules; this file does not repeat them.

## When to use

- Adding or changing a component in `apps/web/src/app/**` that has a source frame in
  the `.pen`.
- Extracting or re-extracting design tokens into `apps/web/src/styles.css`.
- Investigating a colour, spacing, or state that looks wrong against the design.
- Anything that would otherwise mean opening `assets/web-app/web-app.pen` directly —
  don't. It's encrypted; `Read`/`Grep` on it return nothing usable.

## Step 1 — Locate the source, and announce which reader you used

Two readers exist, and they are not interchangeable:

1. **Pencil MCP** (preferred) — live, and the only reader that knows design
   variables. Start every session with:
   ```
   get_app_state({ include_schema: true, include_canvas_design: true, include_scripts_and_shaders: false })
   ```
   All three flags are required — this is how you learn the current `.pen` schema
   before calling anything else. Then `Get(...)` to walk nodes and `GetVariables()`
   for tokens.
2. **HTML export fallback** — `apps/web/design/exports/<screen>.html`, committed
   snapshots from a prior `Export()` run (see Step 3). Use only when the MCP bridge
   is unavailable. It gives you real layout structure but **no design variables** —
   every colour comes out as a raw hex arbitrary value (`bg-[` + `#1F2733` + `]`,
   written broken here so it can never be mistaken for a live class in this file).

**State out loud which one you used.** A silent fallback to the HTML export reads as
"tokens extracted from the design system" when they were actually inferred from
flattened, hard-coded CSS — exactly the mistake the tokens golden rule in
`apps/web/CLAUDE.md` exists to prevent. If you fell back, say so and flag that
colours need re-verification against `GetVariables()` once the MCP is reachable
again.

## Step 2 — Distil to `DESIGN.md`

`apps/web/DESIGN.md` is the durable record: the token table, the shared-with-email
notes, the component → target-path table, the route table, the overlay-vs-page
distinction, the asset-resolution table. Extraction that isn't reflected there
didn't happen as far as the next person (or the next session) is concerned. Update
the relevant table rather than appending narrative — the file is meant to stay a
reference, not a changelog.

## Step 3 — Export the snapshot

```
Export([nodeId], "html-tailwind", "<ABSOLUTE PATH>/apps/web/design/exports/<screen>.html", { includeLayerNames: true })
```

- **`outputPath` must be absolute.** It resolves relative to the `.pen`'s own
  directory (`assets/web-app/`), not the repo root — a relative path silently wrote
  19 files into `assets/web-app/` before anyone noticed it wasn't landing in
  `design/exports/`.
- `html-tailwind` emits real flexbox and zero `position:absolute`, and it preserves
  `data-pencil-name` layer names — so the export's structure is directly readable as
  the target component's layout. It is not readable for colour (Step 1) or state
  (below).
- **A static export rasterizes exactly one state.** The `Status Badge` export shows
  only its `DELIVERED` variant; the five-state palette (`PLACED → PROCESSING →
  SHIPPED → OUT_FOR_DELIVERY → DELIVERED`) had to be read from the variant sheet
  (`Status Badge — States`) in the live `.pen`, not inferred from one export. If a
  frame has visible variants in the canvas, check the variant sheet before assuming
  the export is the whole story.
- The export carries `cdn.tailwindcss.com` and Google Fonts `<link>` scaffolding.
  **Never copy these into the app** — it compiles Tailwind at build time and
  self-hosts Inter via `@fontsource/inter`.
- Exports are reference-only, committed for humans to diff against, never imported
  by the app.

## Step 4 — Resolve assets: three kinds, three resolutions

An export references images in three distinct ways. Scanning only `<img>` tags
misses the first, which is a CSS background.

1. **Local repo asset** — a CSS background url, written here broken so it reads as
   prose and not a real class: `bg-[url('...standalone-logo.png')]`, relative to
   the `.pen`'s own directory. **Where it is served from depends on the consumer.**

   For the **web app**, serve it from the app's own origin: copy the file into
   `apps/web/public/` — only that folder is emitted by `angular.json` — and
   reference it as `/img/…`. A manifest URL is not what the browser asks for, and
   an asset outside `public/` 404s no matter what the bucket holds. The logo did
   exactly that on every screen until `82f3d85`. The one exception is the boot
   loader, which inlines its mark as a data URI: a second request resolves after
   the white first paint it exists to cover.

   For the **email templates**, the bucket is correct — their clients cannot read
   our origin. Look the path up in `assets/assets.manifest.json` (keys are
   repo-relative, e.g. `email/blank-dot.png`) and use the entry's `url`; if it is
   missing, copy the file into `assets/web-app/` and run `make assets-sync` — no
   need to ask first.

   `make assets-sync` needs `make post-infra` to have already run (it reads the
   bucket name and base URL from Terraform outputs). If the stack is down, the sync
   itself will fail — **still copy the file into `assets/web-app/`**, and report the
   pending `make assets-sync` command rather than blocking on it. Copying is safe
   and idempotent; blocking layout work on infrastructure it doesn't need is not.

2. **Inline Lucide icon** — `data-icon-set="lucide"`, `data-icon-name="mail"` on the
   node. **Not an asset** — nothing to sync, nothing to copy. Render the named icon
   directly with `@lucide/angular` in the component. This is the web's advantage
   over the email templates, where inline SVG is unusable and the same icons had to
   become PNGs shipped from the bucket ([[email-templates]]).

3. **Remote stock placeholder** — an `images.unsplash.com` URL. **Never copy it into
   `assets/`, and never ship a template that points at it** — that hotlinks a third
   party from production. Render a token-coloured placeholder in its place and flag
   the frame as needing real artwork. Brand photography is a content decision with
   no owner yet; flagging keeps the gap visible instead of silently shipping a
   dependency on someone else's CDN.

## Step 5 — Emit tokens

Tokens come from `GetVariables()` — never from an export's flattened hex values
(Step 1). Every variable maps to a Tailwind v4 `@theme` entry in
`apps/web/src/styles.css`, following the naming rule already in place there:

| `.pen` variable | `@theme` custom property | Tailwind utility |
|---|---|---|
| `brand-navy` | `--color-brand-navy` | `bg-brand-navy` |
| `bg-body` *(renamed on emission)* | `--color-surface-body` | `bg-surface-body` |
| `text-primary` *(renamed)* | `--color-ink-primary` | `text-ink-primary` |
| `radius-md` | `--radius-md` | `rounded-md` |
| `field-height` | `--height-field` | `h-field` |

The full current table (28 variables, 11 renamed) lives in `apps/web/DESIGN.md` —
this is the shape, not a duplicate of the data.

**Namespace prefixes are mandatory and fail silently.** `--color-brand-navy` yields
the utility `bg-brand-navy`; a bare `--brand-navy` (no `--color-` prefix) yields no
utility at all, and no error either. A green `pnpm build` proves nothing here — if a
utility seems not to apply, check the compiled CSS, not the build exit code. Renames
exist specifically to dodge utility-name collisions: emitting `bg-body` verbatim as
`--color-body` would collide with the existing Tailwind `bg-*` namespace stuttering
into `bg-bg-body`; renaming the `.pen` variable's *class* half (`body` →
`surface-body`) on the way out avoids it.

**If a colour, radius, or size in a frame has no matching variable, stop and report
it — do not substitute the nearest existing token, and do not hand-write the hex.**
Four real design-system gaps were found exactly this way in one milestone:
`text-muted-on-dark`, `text-subtle-on-dark`, `text-on-orange-light`, and
`scrim-overlay`. The one time an implementer substituted instead of reporting, the
miss reached review undetected. The fix is always upstream: add the variable to the
`.pen` (Step 6's `SetVariables`), then re-run this skill to propagate it into
`styles.css` and `DESIGN.md` — never hand-edit `styles.css` directly.

**Worked example — comparing two approximations is how a gap surfaces.** The cart
drawer's scrim and the mobile menu's scrim looked like unrelated decisions:
`bg-black/40` in one place, `bg-black/65` in the other, both plausible-looking
opacities for a dimming overlay. Reading the actual `.pen` value showed both frames
use the identical `#12161FA6` — and `A6` in 8-digit hex is 65% alpha, not 40%. The
shared scrim component had been wrong since it was written, and the two-`/40`-vs-
`/65` split was the tell: a single design value with two different code
approximations is a design-token gap wearing a disguise, not two legitimate
choices. That is what became the `scrim-overlay` token above.

## Step 6 — Write the component

**The export is a reference for structure and spacing *relationships*, never a
source of literal values or file layout to copy.** It is one static page with
fixed pixels everywhere and no `.html`/`.ts` split, because it isn't an Angular
app — every value and every file-shape decision below has to be translated on
the way in, not transcribed. See [[angular-component-authoring]] for the full
rationale; this step only states the two rules that follow from it.

- Structure comes from the export's layout (Step 3): flex, gaps, padding
  *relationships*, and `data-pencil-name` are legitimately copyable.
- Colour, radius, and size come from tokens (Step 5) — replace every arbitrary hex
  class the export emitted with the matching token utility.
- **Template goes in a sibling `.html` file via `templateUrl`, not inline
  `template:` backticks.** Exception: a genuinely one-line template (e.g. a
  `<router-outlet />` host). The export is one flat HTML file with no `.ts`
  boundary at all — that has no bearing on how the component's own template and
  class are split.
- **No `px` in the component's Tailwind classes — use `rem`.** Convert by
  dividing by 16 (`13px` → `0.8125rem`), preferring an existing design token
  or Tailwind scale step over a raw converted value. Exception: borders and
  hairlines stay in `px` (`border-[1px]` is correct as-is; do not convert it).
  The export emits `px` for literally everything because it's a static
  rasterization — copy the value, converted, never the unit.
- Standalone Angular component, `input()`/`output()` signals (never `@Input()` /
  `@Output()` decorators) — see `apps/web/CLAUDE.md` §3 for the folder convention
  and `apps/web/DESIGN.md`'s component table for the target path.
- **Comments follow [[code-comments]]:** one of five tags (`CONTRACT:`,
  `WORKAROUND(<scope>):`, `WHY:`, `WARNING:`, `TODO(JE-<id>):`), ≤6 lines
  untagged, >12 a hard error, present tense only. Do **not** carry the export's
  `data-pencil-name` provenance or the frame's history into a comment — the
  frame id belongs in the commit message or a vault note, not in the source. A
  translation decision worth recording (a token that had no design equivalent,
  a deliberate structural departure) is a `WHY:` of one or two lines.
- If the frame is a variant sheet (e.g. `Status Badge — States`,
  `Tracking Status — Icons`) rather than a component itself, it documents the
  states of another component — build the state-driven component, not a second one
  for the sheet.
- Verify with the same grep the app's own golden rule runs in review:
  ```bash
  grep -rnE '(bg|text|border)-\[#' apps/web/src/
  ```
  written broken above for the same reason as Step 1's example — expected: no
  matches once the new component is in place. Also check for stray `px` sizing
  (excluding borders) and confirm a `.html` file exists for the component.

## Verified quirks (read before debugging)

1. **The per-editor bridge starts cleanly and fails every call.**
   `~/.pencil/mcp/cursor/…` (or any `~/.pencil/mcp/<editor>/` bridge run with
   `--agent claudeCodeCLI`) answers every request with *"Failed to access file. A
   file needs to be open in the editor"* even with the file demonstrably open — the
   Pen renderer reports `connectedAgents: []`, so the app never registers the
   agent. Reconnecting does not help and leaks orphaned server processes. This cost
   six failed reconnects to diagnose before the cause was found. **Only the binary
   bundled inside the desktop app, run with `--app desktop`, works.** `.mcp.json`
   resolves it portably via `scripts/pencil_mcp.py`, which searches known install
   paths for the platform-specific binary (`mcp-server-darwin-arm64` etc.) and
   `exec`s it — `PENCIL_MCP_BIN` in `.env` overrides the search for installs it
   doesn't know about.

2. **`execute` runs a script body, not a function body.** A top-level `return` is a
   SyntaxError. Use `Print(...)` to get a value out. The tool's input parameter is
   named `input`, not `code`.

3. **`Get(node, visitor, { depth: 1 })` does not limit the visitor** — it still
   descends the full tree regardless of the depth option. To keep only root frames,
   test `if (!ctx.parentCtx)` inside the visitor instead of relying on `depth`.

4. **The variables API is `SetVariables` (plural), taking one object** — there is no
   `SetVariable` singular form. Read with `GetVariables()`.

5. **`Export()` resolves a relative `outputPath` against the `.pen`'s own
   directory, not the repo root.** Covered in Step 3 above; restated here because
   it's the quirk most likely to silently misplace files without an error.

6. **MCP edits are in-memory until a human saves.** `SetVariables` / `Update` change
   the *open editor's* document immediately, but the `.pen` file on disk is
   unchanged until someone saves in the desktop app. Do not report a design-file
   change as done on the strength of a successful MCP call alone — verify with:
   ```bash
   git hash-object assets/web-app/web-app.pen
   git rev-parse HEAD:assets/web-app/web-app.pen
   ```
   Equal hashes mean the on-disk file (and therefore what a future `git diff` or a
   teammate's editor sees) has not actually changed yet.

7. **Tailwind scans Markdown and HTML, including this skill file's own examples.**
   Every arbitrary-value class shown above in this file is deliberately broken with
   `...` or an interior space/quote so it can't be picked up as a real utility by
   Tailwind's content scanner — this file lives outside `apps/web/`, so it can't
   break that build directly, but `DESIGN.md` and `CLAUDE.md` inside `apps/web/`
   have hit this for real and are excluded via `@source not` in `styles.css`. Any
   new prose file added under `apps/web/` that documents a Tailwind class pattern
   needs the same exclusion, or a future edit will resurface the failure.

## Related

- [[angular-component-authoring]] — the two component-authoring rules Step 6
  applies (`.html` templates via `templateUrl`, `rem` not `px`), with the
  conversion arithmetic, both exceptions, and the measured current-state gap.
- [[code-comments]] — the comment rules Step 6 applies to the component it
  writes: the five tags, the length gate, and present-tense-only.
- `apps/web/DESIGN.md` — current state of the design system this procedure
  produces: full token table, component → path mapping, route table, asset table.
- `apps/web/CLAUDE.md` — app stack, the tokens golden rule and its Tailwind v4
  traps (§2a), the `NG_APP_*` public-config rule (§2b).
- `docs/superpowers/specs/2026-08-17-web-app-foundation-design.md` — the design
  spec this skill's six steps were defined against.
- `scripts/pencil_mcp.py` — the portable resolver for the desktop MCP binary
  (quirk 1).
- [[email-templates]] — the email design system (`assets/email/emails.pen`,
  `assets/email/DESIGN.md`), sharing several tokens with this one; also where the
  Lucide-icon-vs-PNG asset tradeoff (Step 4.2) is the other way around.
