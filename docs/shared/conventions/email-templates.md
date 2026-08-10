---
title: Email Templates
type: convention
area: events-pipeline
status: active
created: 2026-08-06
updated: 2026-08-09
tags: [type/convention, area/events-pipeline, status/active]
related:
  - "[[events-pipeline-design]]"
  - "[[tightened-schemas-need-producer-first-deploys]]"
  - "[[testing]]"
  - "[[env-files]]"
  - "[[ADR-0014-env-validation-zod]]"
  - "[[ADR-0020-self-owned-password-reset]]"
---

# Email Templates

How to build a transactional email template in events-pipeline (`functions/events-pipeline/emails/`)
without re-discovering — or silently violating — the client-support constraints the existing
five templates were built around. Read this before adding a sixth `.tsx` file. The five built
today are `user-created`, `order-created`, `tracking-status-changed` (fans out to five catalog
entries), `auth-otp`, and `forgot-password` — see [[events-pipeline-design#Email]].
`forgot-password` was the last frame in `emails.pen` with no `.tsx` component; it shipped
2026-08-09 for `PASSWORD_RESET_REQUESTED` (see [[ADR-0020-self-owned-password-reset]]).

## Client-support constraints — why the code looks like it does

These are not style preferences. Each one is a client-compatibility fact with a measured
number behind it, and the templates are built the way they are specifically to survive it.

- **Icon fonts are unusable.** They need an `@font-face` rule inside a `<style>` block in
  `<head>`. Gmail, Outlook on Windows, and most webmail clients strip `<style>` blocks
  outright, so the glyph never resolves.
- **Inline SVG is unusable.** 40.48% client support
  ([caniemail.com/features/html-svg](https://www.caniemail.com/features/html-svg/)), and it
  renders in **no version of Outlook on Windows** — that client goes through Word's HTML
  engine, which has no SVG support at all.
- **Remote `<img>` is the one that works — 100% client support**
  ([caniemail.com/features/image-jpg](https://www.caniemail.com/features/image-jpg/)). Every
  image the templates render (icons, the logo, the timeline dots) is a remote `<img>` served
  from the assets bucket (see [[#The asset pipeline]]), not an embedded `data:` URI.
- **The old objection to remote images was based on a stale claim, and the correction is worth
  keeping on record.** The templates used to embed every icon as a base64 PNG `data:` URI on
  the premise that "Gmail blocks remote images by default". **That has not been true since
  2013**: Gmail displays remote images by default, proxying them through its own image cache
  (`googleusercontent.com`) rather than hitting the sending server directly. It withholds an
  image only when it judges the *sender* suspicious — a reputation problem, not a property of
  remote images, and one addressable with SPF, DKIM, DMARC, and a consistent sending domain.
  Transactional mail also has the easiest reputation to earn: it goes to someone who just
  handed over their address and is actively expecting it.
- **Base64 `data:` URIs, kept here as the rejected alternative, not the current approach.**
  80.95% support ([caniemail.com/features/image-base64](https://www.caniemail.com/features/image-base64/)).
  That ~19% gap is a **hard rendering limit** — no sender-side mitigation exists for it, unlike
  the reputation-based blocking that remote `<img>` risks. That asymmetry is why remote wins:
  a mitigable risk beats an unfixable one. It also cost message size (base64 inflates every
  byte by ~33% and repeats the whole payload inside the message) and required a build step
  (`build-icons.mjs` rasterising `lucide-static` SVGs into a committed
  `emails/icons.generated.ts`) that has since been deleted along with the `build:icons` npm
  script — see [[#The asset pipeline]] for what replaced it. Do not "optimise" back to base64
  without re-reading this section; the number that justified it was wrong, not the number
  itself.
- **Images are an enhancement, always — this did not change when the image mechanism did.**
  Whether a recipient's client blocks a remote image for reputation reasons, or a recipient has
  images off by personal setting, the same rule applies: every `<Img>` needs a meaningful
  `alt`, the coloured circle behind each header icon stays, and the header's "3M"+"RAI" text
  lockup stays beside the logo mark — text is the only element with genuinely 100% reach. An
  image must never be the only thing conveying required information (see the OTP security
  notice below).
- **Gmail clips messages over ~102 KB.** Serving images remotely instead of embedding them
  removes the biggest contributor to that ceiling — base64 was what actually consumed the
  budget — so this constraint is less pressing now than it was, though it still bounds how much
  text and markup a template can carry.

## Authoring rules

- **Use react-email components — `Section`, `Row`, `Column`, `Text`, `Img`, `Heading`,
  `Hr` — never hand-written `<table>/<tbody>/<tr>/<td>`.** `Row`/`Column` compile to exactly
  that table markup; writing it by hand produces an inconsistent mixture of the two for no
  gain. Inline `style` is fine where a value cannot be a static Tailwind class (a runtime prop,
  a one-off colour used at a single call site).
- **Never flexbox or grid.** Email clients do not reliably support either. The `.pen` design
  source expresses layout as flex (`justifyContent`, `gap`) because Pencil is a design tool,
  not an email renderer — translate the *intent* (e.g. "logo left, tag right") into
  `Row`/`Column`, never copy the flex properties directly.
- **Tailwind goes through the `Brand` wrapper** (`emails/components/brand.tsx`), which supplies
  `pixelBasedPreset`. Tailwind v4's default scale is `rem`-based, and several clients — Outlook's
  Word engine in particular — handle `rem` badly, rescaling the whole email. `Brand` wraps
  `EmailLayout`, which every template imports, so no template ever configures Tailwind itself;
  it only writes classes. Classes compile to inline `style` attributes during render, so the
  delivered HTML stays fully inlined — no `<style>` block, no `class` attribute reaches the
  client (the one unavoidable exception is the single `@font-face` block `<Font>` emits, which
  degrades gracefully — see the comment in `components/layout.tsx`).
- **`Section` puts its props on the `<table>`, not the `<td>`.** Cell-level styling (padding,
  border-radius, background) must go on a `Column`, which *is* the `<td>`. Putting it on the
  enclosing `Section` silently does nothing to the cell.
- **`Row` defaults to `width="100%"`.** A shrink-to-fit element (an icon circle, a small badge)
  needs an explicit `width="auto"` on its wrapping `Row`, or it stretches to the full row width.
- **`border-radius` on a `<td>` is unreliable.** A `<td>` is `display: table-cell`, and its box
  is resolved by the table after the radius is computed, so round corners on a `Column` render
  inconsistently across clients. Round shapes (icon circles, status badges) go on an
  `inline-block` `<span>`/`Text` with `border-radius: 50%` and `box-sizing: border-box` instead.
- **Where a shape must be round in every client, use an image instead of CSS — the timeline
  dots are the concrete case.** They used to be CSS-drawn `inline-block` spans with
  `border-radius: 50%`, the most fragile construct in the whole template set: `border-radius`
  has 82.92% support ([caniemail.com/features/css-border-radius](https://www.caniemail.com/features/css-border-radius/))
  and Outlook on Windows has **none** of it, so every dot rendered as a square there. They are
  now PNGs (`greenDot`/`orangeDot`/`blankDot` in `emails/assets.ts`), which removes both the
  `border-radius` dependency and the `inline-block` dependency from that part of the layout in
  one move — a PNG of a circle is a circle in every client. Colour still distinguishes the
  three states on its own, so a reader with images off loses the dots but keeps the timeline:
  each step keeps its text label, its date, and the active step keeps its bold weight.
- **`<Img>` needs `width`/`height` as HTML attributes, not just Tailwind classes.** Outlook
  sizes images from the HTML attributes and ignores CSS dimensions — an image with only a
  `w-[28px]` class can render full-size and burst its container. This applies to every `<Img>`
  in these templates without exception, now that all of them (icons, logo, and dots) are remote
  images rather than a mix of base64 icons and CSS shapes.
- **`Hr`'s own default border style is emitted *after* the compiled Tailwind classes.** Its
  border colour must be set via inline `style`, or the component default
  (`border-top: 1px solid #eaeaea`) wins the cascade and the rule silently renders grey — no
  error, the email just looks slightly wrong. See the "STOP POINT" comments in
  `emails/components/layout.tsx` and `emails/auth-otp.tsx` for the concrete case.

## Adding a new template — the checklist

1. **Design the frame** in `assets/email/emails.pen`, and document it in `assets/email/DESIGN.md`
   (layout structure, tokens used, icons, component patterns).
2. **Add the image(s)** to `assets/` (e.g. `assets/img/email/`), run `make assets-sync` to
   optimise and upload them, then reference them through `emails/assets.ts` — add an
   `emailAssets` entry with the object key, the display size, and the colour/state it belongs
   to. See [[#The asset pipeline]] for the full mechanics. There is no build step to run inside
   `functions/events-pipeline/` for this — the old `build-icons.mjs` script,
   `emails/icons.generated.ts`, and the `build:icons` npm script are gone; images live in the
   assets bucket, not in committed TypeScript.
3. **Write the component** under `emails/`, wrapped in `EmailLayout` (`emails/components/layout.tsx`),
   which supplies the header, the white content card, and the footer.
4. **Register it in `src/email/catalog.ts`** via `defineTemplate<P>()`, with realistic
   `sampleProps` — those are what the local preview server (`email dev`) shows and what the
   snapshot test in `tests/email/catalog.test.ts` renders. One event type can fan out to several
   catalog entries sharing one component (see `tracking-status-changed-*`); that is the
   preferred shape over a new component per variant.
5. **Widen the handler's Zod payload schema** if the template consumes new fields the current
   payload doesn't carry, and mind the deploy-order rule in
   [[tightened-schemas-need-producer-first-deploys]] — producers must ship the new field before
   the consumer's schema makes it required, or in-flight events from not-yet-redeployed
   producers get rejected as a `PermanentError` and lost, not retried.
6. **Screenshot it.** The repo-root `e2e/tests/email-templates.spec.ts` renders and captures
   each catalog entry — actually look at the result rather than trusting the snapshot diff alone;
   a snapshot can agree with itself while still being visually wrong (see
   [[tightened-schemas-need-producer-first-deploys]] for a case where source-based tests agreed
   with each other while the deployed artifact was stale).

## The asset pipeline

Every image the templates render — icons, the logo mark, the timeline dots — is a file under
`assets/` served from an S3 assets bucket, not an embedded `data:` URI.

- **`make assets-sync` is the day-to-day entry point.** It optimises everything under `assets/`
  (resizing to the deliberately small display-plus-retina size each image needs) and uploads it
  to the assets bucket, writing `assets/assets.manifest.json` as it goes. It touches no
  infrastructure — no plan, no apply, no teardown — so it is safe to re-run against an
  already-running stack, and idempotent: every object and the manifest are fully overwritten on
  each run, so re-running is the repair mechanism, not something to avoid.
- **The manifest is a build/dev artifact, not something the runtime reads.** It is gitignored
  and environment-specific. The Lambda does not import it or read it at render time — reading a
  gitignored file at runtime would throw `ENOENT` inside a deployed function, and esbuild does
  not bundle it either way. `emails/assets.ts` instead hardcodes the known object keys as string
  literals and builds each URL from `ASSETS_BASE_URL` plus the key.
- **`ASSETS_BASE_URL` is the one runtime dependency, and it is Zod-required.** The chain is
  Terraform (assets bucket module) → `generate_env_files.py` (writes the env file — see
  [[env-files]]) → the service's Zod config schema ([[ADR-0014-env-validation-zod]]) →
  `emails/assets.ts`. Because the schema requires the key, a Lambda deployed without it dies at
  boot with a named error instead of rendering emails with broken image links. `emails/assets.ts`
  itself reads `process.env.ASSETS_BASE_URL` directly rather than importing the shared config
  module, since that module parses the full service schema (including DocumentDB and SES vars)
  at import time — importing it would drag unrelated config into contexts that legitimately
  don't have it, such as the catalog snapshot test and the local `email dev` preview server. It
  falls back to the local Floci bucket URL in those two contexts only.
- **Still no WebP, unchanged by this move.** Deliberately not generated: Outlook on Windows (the
  Word rendering engine) and Apple Mail do not support it, and Gmail converts it to JPG on the
  way through. It would be a third variant to generate, upload, and track in the manifest, for
  clients that already render the PNG just as well.

## One rule that is easy to break by "tidying"

The OTP template (`emails/auth-otp.tsx`) renders its code **twice** on purpose: once as
contiguous plain text ("Use this code to sign in... 042817."), once as six individually boxed
digits. This is not redundant copy. The gateway E2E scrapes the code from the delivered message
body with a six-digit regex, and it cannot reassemble digits that are split across six separate
table cells with markup in between. The plain-text sentence is the only machine-readable copy of
the code. Deleting it — or moving the code out of it — breaks the E2E suite silently: the email
still looks correct to a human, but the test can no longer extract the code and sign in.
`tests/email/catalog.test.ts` guards this by snapshotting the rendered entry, so a change to
that sentence shows up as a diff to review, not a silent E2E failure days later.

**`forgot-password.tsx` follows the same rule, for the same reason.** It also renders its code
twice — a contiguous plain-text sentence plus six boxed digits — so the gateway E2E can scrape a
reset code the same way it scrapes an OTP one. See [[ADR-0020-self-owned-password-reset]] for the
flow this code authorizes and why leaking it matters more than an OTP leak (a reset code hands
over the account, not one session).

## Known gap — rounded corners in Outlook Windows

Deferred, not a bug: `border-radius` has 82.92% client support and **no support in any version
of Outlook Windows (2003–2019)**
([caniemail.com/features/css-border-radius](https://www.caniemail.com/features/css-border-radius/)).
Outlook simply ignores the property — nothing breaks, a rounded shape just renders with square
corners. There were 14 usages across the four templates as of the last audit (2026-08-08, before
`forgot-password` shipped); what matters for visibility is whether the radius is *circular*
(radius = half the side, so a square corner is obvious) or a *soft corner* on a larger
rectangular panel (a few px flattening is easy to miss). `forgot-password.tsx` was not
re-audited against this count — it very likely repeats the same header-icon-circle and
boxed-digit patterns as `auth-otp.tsx`, since it reuses the same layout primitives, but that is
an inference, not a re-measurement; treat the "14" and the lists below as **four-template**
figures until someone re-runs the audit against all five.

**Visibly affected in the original four-template audit — a circle becomes a square:**
- The 64×64 header icon circle in each of the four templates (`user-created.tsx`,
  `order-created.tsx`, `tracking-status-changed.tsx`, `auth-otp.tsx` — one per template, each
  with its own accent tint).
- The 20×20 amber-bordered badge in `auth-otp.tsx`'s "Wasn't you?" security notice.

**Barely noticeable in the original four-template audit — an 8px corner flattens on a larger panel:**
- The white content card in `emails/components/layout.tsx` (affects all templates via
  `EmailLayout`, including `forgot-password.tsx`).
- The CTA button in `emails/components/button.tsx` — moot for `forgot-password.tsx`, which has no
  CTA button (see [[events-pipeline-design#Email]] design-source note: its tokenised link/CTA was
  dropped in favor of the boxed-digit code, matching what the backend can actually deliver).
- The "YOUR ACCOUNT" panel in `user-created.tsx`.
- The line-items panel and the "SHIPPING TO" panel in `order-created.tsx`.
- The timeline panel in `tracking-status-changed.tsx`.
- The six OTP digit boxes and the "Wasn't you?" notice panel in `auth-otp.tsx`.

Line numbers drift; the above names each component instead so the note survives edits.

**If this is ever worth closing, there are two options:**

1. **PNG with the circle baked in** — export the coloured disc together with its icon as a single
   image, the same technique already used for the timeline dots (see the note on `greenDot`/
   `orangeDot`/`blankDot` in [[#Authoring rules]] and [[#The asset pipeline]] — they were CSS
   circles rendering as squares in Outlook until they became PNGs). Closes 4 of the 5 visibly
   affected cases with no conditional markup and no new fragility, and is consistent with what
   the codebase already does elsewhere.
2. **VML `RoundRect`** — Outlook-only conditional markup (`<!--[if mso]>`). Covers everything,
   including the 8px soft corners, but doubles the markup around every rounded element and is
   notoriously brittle.

Recorded recommendation, if this is ever picked up: option 1, and only for the header icon
circles (plus the OTP badge). The nine soft corners on panels/buttons/digit boxes are not worth
touching — a square 8px corner in one declining client is invisible to a reader.

Also worth recording as context: react-email already emits two `<!--[if mso]>` conditional blocks
and `mso-padding-alt`/`mso-text-raise`/`mso-font-width` properties around the CTA button (see
`emails/components/button.tsx`), so the library covers Outlook fidelity where it matters most —
the primary call to action — without any hand-written VML.

**What would make this worth doing:** evidence that a meaningful share of recipients read these
emails in Outlook Windows (e.g. open-client analytics once the events-pipeline ships them). The
templates are legible and on-brand in Outlook Windows today; closing this gap is fidelity polish
in one declining client, not a fix for broken mail.

## Design source

- Design frames: `assets/email/emails.pen` (Pencil). The design was revised to a code-based flow
  while `forgot-password.tsx` was being built: the frame's original CTA button and tokenised link
  were replaced with the same six boxed digits `auth-otp` already renders, to match what the
  backend can actually deliver — Cognito's/the self-owned flow's code is a six-digit value, not a
  link, and there is no frontend URL to land on. The `lock`/`timer` glyphs the earlier frame used
  went with the blocks they belonged to and are deliberately left unregistered in `assets.ts`.
- Design system doc: `assets/email/DESIGN.md` — layout structure, colour/typography tokens,
  iconography inventory, and component patterns (icon circle, CTA button, key-value row,
  security notice, tracking timeline, OTP digit display). It documents all five templates,
  `forgot-password` included, which now has both a designed frame and a built `.tsx` component
  (`emails/forgot-password.tsx`, shipped 2026-08-09).

## Related

- [[events-pipeline-design]] — the service spec; `## Email` documents the catalog registry and
  all five currently-built templates.
- [[tightened-schemas-need-producer-first-deploys]] — the deploy-order lesson triggered by
  widening producer payloads to feed richer templates; step 5 above exists because of it.
- [[testing]] — the three-layer testing convention this service's email screenshot E2E
  implements a variant of.
- [[env-files]] — how `ASSETS_BASE_URL` reaches the Lambda's env file (`make env-file`,
  Terraform outputs → `generate_env_files.py`); see [[#The asset pipeline]].
- [[ADR-0014-env-validation-zod]] — why a missing `ASSETS_BASE_URL` fails Lambda boot instead of
  rendering broken image links.
- [[ADR-0020-self-owned-password-reset]] — the flow `forgot-password.tsx` serves, and why its
  code must never reach the events collection.
