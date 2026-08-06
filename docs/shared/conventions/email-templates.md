---
title: Email Templates
type: convention
area: events-pipeline
status: active
created: 2026-08-06
updated: 2026-08-06
tags: [type/convention, area/events-pipeline, status/active]
related:
  - "[[events-pipeline-design]]"
  - "[[tightened-schemas-need-producer-first-deploys]]"
  - "[[testing]]"
---

# Email Templates

How to build a transactional email template in events-pipeline (`functions/events-pipeline/emails/`)
without re-discovering — or silently violating — the client-support constraints the existing
four templates were built around. Read this before adding a fifth `.tsx` file, a "sixth
template" in the sense of the next one after all of `user-created`, `order-created`,
`tracking-status-changed`, and `auth-otp` (the last of these fans out to five catalog entries;
see [[events-pipeline-design#Email]]). `forgot-password` is designed in
[[#Design source]] but not yet built — it is the most likely candidate.

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
- **Remote `<img>` is blocked by default** in many clients for unknown senders, and it also
  leaks an open-tracking signal via the external request.
- **Base64 `data:` URIs are the one that works.** 80.95% support
  ([caniemail.com/features/image-base64](https://www.caniemail.com/features/image-base64/)),
  working in both Gmail (since 2020) and Outlook on Windows. **PNG, not GIF** — Outlook Windows
  does not render a base64 GIF, only base64 PNG.
- **Because ~20% of recipients still see no image, every image must be an enhancement.** The
  coloured icon circle, the button label, the text lockup must each carry the design on their
  own with zero assets loaded. Every `<Img>` needs a meaningful `alt`. Never make an icon the
  only thing conveying required information (see the OTP security notice below).
- **Gmail clips messages over ~102 KB.** The current templates run roughly 8–25 KB rendered, so
  there is headroom — but base64 icons are what actually consumes it, which is why
  `build-icons.mjs` rasterises each icon at a deliberately small size (see
  [[#Adding an icon]]) rather than embedding full-resolution art.

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
- **`<Img>` needs `width`/`height` as HTML attributes, not just Tailwind classes.** Outlook
  sizes images from the HTML attributes and ignores CSS dimensions — an image with only a
  `w-[28px]` class can render full-size and burst its container.
- **`Hr`'s own default border style is emitted *after* the compiled Tailwind classes.** Its
  border colour must be set via inline `style`, or the component default
  (`border-top: 1px solid #eaeaea`) wins the cascade and the rule silently renders grey — no
  error, the email just looks slightly wrong. See the "STOP POINT" comments in
  `emails/components/layout.tsx` and `emails/auth-otp.tsx` for the concrete case.

## Adding a new template — the checklist

1. **Design the frame** in `assets/email/emails.pen`, and document it in `assets/email/DESIGN.md`
   (layout structure, tokens used, icons, component patterns).
2. **Add the icon(s)** to `functions/events-pipeline/scripts/build-icons.mjs` — colours read
   from `emails/theme.ts` tokens where tokenized, or as a documented one-off literal otherwise.
   The script rasterises `lucide-static` SVGs to base64 PNG at 2× display size (for retina) into
   the committed `emails/icons.generated.ts`. It is committed deliberately: `emails/*.tsx`
   import it directly, so `tsc --noEmit`, `vitest`, and `email dev` all need it to exist without
   a build step having run first. Run `pnpm run build:icons` (or the full `pnpm run build`) after
   editing the `ICONS` list.
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

## Design source

- Design frames: `assets/email/emails.pen` (Pencil).
- Design system doc: `assets/email/DESIGN.md` — layout structure, colour/typography tokens,
  iconography inventory, and component patterns (icon circle, CTA button, key-value row,
  security notice, tracking timeline, OTP digit display). It currently documents five templates
  including `forgot-password`, which has a designed frame and token entries but no `.tsx`
  component yet.

## Related

- [[events-pipeline-design]] — the service spec; `## Email` documents the catalog registry and
  the four currently-built templates.
- [[tightened-schemas-need-producer-first-deploys]] — the deploy-order lesson triggered by
  widening producer payloads to feed richer templates; step 5 above exists because of it.
- [[testing]] — the three-layer testing convention this service's email screenshot E2E
  implements a variant of.
