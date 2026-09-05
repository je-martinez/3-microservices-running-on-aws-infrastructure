---
title: Pencil Design Extraction
type: convention
area: shared
status: active
created: 2026-08-18
updated: 2026-09-04
tags:
  - type/convention
  - area/shared
  - status/active
related:
  - "[[2026-08-17-web-app-foundation-design]]"
  - "[[2026-08-18-web-app-foundation]]"
  - "[[email-templates]]"
  - "[[doc-propagation]]"
  - "[[angular-component-authoring]]"
---

# Pencil Design Extraction

How a Pencil `.pen` design becomes code, and why the vault records this as a convention
rather than leaving it to `.claude/skills/pencil-design-extraction/SKILL.md` alone. That
skill holds the **executable procedure** an agent follows step by step; `apps/web/CLAUDE.md`
holds the **app's** stack and Tailwind/`NG_APP_*` rules. This note holds the **decision and
the reasoning** — what was decided and why — so it survives independently of any one
assistant's tooling, is reviewable in a PR, and is readable by every human and agent on the
project. It does not restate either file's steps; read them for the mechanics.

## The `.pen` is the source of truth; three artefacts derive from it

`assets/web-app/web-app.pen` is authoritative. Three things are generated from it, and
`apps/web/src/` reads none of them at runtime:

1. **`apps/web/DESIGN.md`** — the distilled token table, component → path mapping, and route
   table. The durable record of *what has been extracted so far*.
2. **`apps/web/design/exports/*.html`** — committed HTML snapshots, reference-only. Never
   imported by the app, never hand-edited — a drifted export is fixed by re-exporting from the
   `.pen`, not by patching the HTML.
3. **Referenced images** — resolution now splits by consumer (see "Images: web serves its own,
   email uses the bucket" below), not a single manifest-and-sync path for every surface.

## Tokens come from `GetVariables()`, never from an export's classes

An HTML export doesn't know the design's variables, so it emits arbitrary hex values (classes
of the shape `bg-[#1F2733]`) for every colour. Copying those into a component hard-codes each
one, defeating the point of having a design system at all. Tokens are read live from the `.pen`
via the Pencil MCP `GetVariables()` call and emitted into the Tailwind v4 `@theme` block in
`apps/web/src/styles.css`.

The namespace prefix on each `@theme` custom property is mandatory, and dropping it fails
**silently** — a bare `--brand-navy` (no `--color-` prefix) generates no utility and no build
error. A green `pnpm build` proves nothing about whether a given token actually compiled; the
only way to know is to check the compiled CSS.

## Never substitute the nearest token — stop and report the gap

This is the rule that earned its place in the convention, not just the skill. When a frame
shows a colour, radius, or size with no matching `.pen` variable, the correct move is to stop
and report it — never reach for the nearest existing token, and never hand-write the hex as a
one-off. The fix is always upstream: add the variable to the `.pen` itself via `SetVariables`,
then re-run extraction so `styles.css` and `DESIGN.md` move together. The three artefacts
(`.pen`, `styles.css`, `DESIGN.md`) drift apart the moment one of them is edited by hand instead
of through re-extraction.

**Four real gaps were found this way in the first milestone:** `text-muted-on-dark`,
`text-subtle-on-dark`, `text-on-orange-light`, and `scrim-overlay`. The one time an implementer
substituted a nearest-match token instead of reporting the gap, the miss reached review
undetected — the closest evidence available that "report, don't substitute" is worth enforcing
rather than treating as a style preference.

**Worked example — the scrim.** The cart drawer's scrim and the mobile account menu's scrim
looked like two unrelated implementation choices: `bg-black/40` in one place, `bg-black/65` in
the other, both plausible opacities for a dimming overlay. Reading the actual `.pen` value
showed both frames use the identical `#12161FA6` — and `A6` in 8-digit hex is 65% alpha, not
40%. The shared `Scrim` component had been wrong since it was written. What surfaced the bug
was comparing two *approximations* of what turned out to be one design value: a single value
represented two different ways in code is a design-token gap wearing a disguise, not two
legitimate decisions. That comparison is what became the `scrim-overlay` token, and it is the
reason the "stop and report" discipline exists — a substitution would have picked one of the
two wrong opacities and moved on.

## Images: web serves its own, email uses the bucket

Item 3 above used to read as one manifest-and-sync path for every referenced image, regardless
of consumer. That was wrong for the web app, and following it produced a real bug: the header
logo 404'd on every screen for weeks because it sat in `assets/img/` at the repo root and the
manifest URL was never what the browser actually requested. Fixed in `82f3d85`. The rule now
splits by who renders the image, not by where the export found it:

- **The web app serves its own images from its own origin, never the bucket.** An asset
  referenced in a frame (e.g. `apps/web/src/app/shared/ui/logo-lockup.html`'s
  `/img/standalone-logo.png`) is copied into `apps/web/public/img/` — only `apps/web/public/` is
  emitted by `angular.json`, so a file left anywhere else 404s regardless of what the manifest or
  bucket holds. The manifest/`assets-sync` path does not apply to this surface at all.
- **Email keeps the manifest-and-bucket path, unchanged.** Email clients cannot read our origin,
  so their images legitimately resolve through `assets/assets.manifest.json` and sync to the
  assets bucket via `make assets-sync` — see [[email-templates]], which is correct as written and
  is not affected by this split.
- **One exception inside the web app itself:** the boot loader inlines the mark as a base64 data
  URI directly in `index.html`, because a second HTTP request for that image resolves after the
  white first paint it exists to cover — neither the app-origin path nor the bucket path is fast
  enough for that one case.

This is a split by consumer, not a replacement of the bucket path — a future asset step still
needs to ask "who renders this?" before choosing app-origin vs. manifest/bucket.

## Web and email share one design system

`brand-navy`, `brand-orange`, `text-primary`, `success-green`, and the Inter font pairing are
identical between `apps/web/DESIGN.md` (sourced from `web-app.pen`) and
`assets/email/DESIGN.md` (sourced from `emails.pen`, see [[email-templates]]). These are two
renderings of one brand, not two independent design systems. The fact this is most expensive to
rediscover during a rebrand: changing a brand colour is a **two-surface change** — both `.pen`
files need the update, and extraction needs to be re-run against each, or the surfaces
visibly drift apart with no build-time signal that they have.

## The MCP bridge, and why the per-editor one must never be used

`.pen` files are encrypted; only the Pencil MCP tools can read them — `Read`/`Grep` return
nothing usable. Pencil installs a bridge per editor under `~/.pencil/mcp/<editor>/`. The Cursor
one **starts cleanly and then fails every call**, answering "A file needs to be open in the
editor" even with the file demonstrably open — the Pen renderer reports `connectedAgents: []`,
so the app never actually registers the agent. This cost six failed reconnects to diagnose
before the cause was understood, and reconnecting does not help; it only leaks orphaned server
processes.

**Only the binary bundled inside the desktop app, run with `--app desktop`, works.** A server
that starts cleanly and then fails every call is worse than one that refuses to start outright —
the false positive is what cost the six reconnects. `.mcp.json` resolves the desktop binary
portably via `scripts/pencil_mcp.py`, which searches known install paths for the
platform-specific binary and `exec`s it, so the repo is not tied to one machine's install
layout.

## MCP edits are in-memory until a human saves

`SetVariables`/`Update` change the *open editor's* document immediately, but the `.pen` file on
disk is unchanged until a human saves it in the desktop app. A successful MCP call is not
evidence that the design file changed on disk — verify with:

```bash
git hash-object assets/web-app/web-app.pen
git rev-parse HEAD:assets/web-app/web-app.pen
```

Equal hashes mean nothing has landed yet. **This is live right now, not a hypothetical**: four
tokens (the ones listed above) exist in the open editor and not on disk. A re-extraction
performed today, before those are saved, would silently drop all four — "silently" because the
MCP calls that read them would simply return the pre-save variable set with no error.

## Tailwind scans Markdown and HTML

Any prose file under `apps/web/` that documents a Tailwind class pattern gets compiled for
real by Tailwind's content scanner — including a sentence written specifically to warn about
this. `apps/web/CLAUDE.md` broke the build with the very example it used to explain the danger.
`DESIGN.md`, `design/exports/`, and `CLAUDE.md` are all excluded via `@source not` in
`styles.css`; any new prose file added under `apps/web/` that shows an arbitrary-value class
example needs the same exclusion, or the failure resurfaces the next time someone writes one.

## Related

- `.claude/skills/pencil-design-extraction/SKILL.md` — the six-step executable procedure this
  convention explains the reasoning behind.
- `apps/web/CLAUDE.md` — the app's stack, the tokens golden rule, and the `NG_APP_*` rule.
- `apps/web/DESIGN.md` — the current state of the design system this procedure produces.
- [[2026-08-17-web-app-foundation-design]] — the design spec this convention was extracted from.
- [[2026-08-18-web-app-foundation]] — the implementation plan.
- [[email-templates]] — the sibling design system (`emails.pen`), sharing tokens with this one,
  and the closest precedent for distilling a `.pen` into a design system consumed by code.
- [[doc-propagation]] — why this convention lives here rather than only in the skill file.
- [[angular-component-authoring]] — extends this note's "translate, not transcribe" principle
  from colour tokens to sizing units (`px` → `rem`) and template file structure
  (`templateUrl` vs. inline), the two other ways the HTML export gets copied too literally.
