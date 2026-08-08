// Remote URLs for every image the email templates render.
//
// ─── WHY REMOTE <img> AND NOT BASE64 — this REVERSES an earlier decision ──────
//
// These templates used to embed each icon as a base64 PNG `data:` URI, produced
// by a `scripts/build-icons.mjs` step into a committed `emails/icons.generated.ts`.
// That choice rested on a claim that is years out of date, and the numbers run
// the other way:
//
//   - A REMOTE <img> has 100% support across email clients
//     (caniemail.com/features/html-img). Every client renders one.
//   - A base64 `data:` URI has 80.95% support
//     (caniemail.com/features/image-base64). Roughly one recipient in five sees
//     NOTHING, and there is no mitigation for that gap — it is a hard rendering
//     limit of those clients.
//
// The objection base64 was adopted for was "Gmail blocks remote images by
// default". Gmail has DISPLAYED remote images by default since 2013: it proxies
// them through its own image cache (googleusercontent.com) and shows them
// without asking. It withholds them only when it judges the SENDER suspicious.
// That makes blocking a sender-reputation problem — the one that SPF, DKIM and
// DMARC exist to solve — rather than a property of remote images. It is fixable;
// base64's 19% is not.
//
// So the trade is: an addressable ~19% rendering gap, or a deliverability
// concern that proper authentication resolves and that we must solve anyway for
// the mail to reach the inbox at all. Remote wins.
//
// Two things we GAIN by moving off base64, beyond the support number:
//   - The messages get smaller. base64 inflates every byte by ~33% and repeats
//     the whole payload inside each message; Gmail CLIPS a message over ~102 KB,
//     truncating the tail of the email and hiding the unsubscribe footer.
//   - An asset can be re-uploaded (`make assets-sync`) without rebuilding,
//     re-committing or redeploying the function.
//
// WHAT DOES NOT CHANGE: the coloured circles behind the header icons, the button
// labels and the "3M"+"RAI" text lockup all STAY. A recipient may still have
// images off by choice, and every template must read as deliberate with zero
// images loaded. Every <Img> keeps a meaningful `alt`, and no icon is ever the
// only thing conveying required information. See
// docs/shared/conventions/email-templates.md.
//
// ─── WHY THIS FILE READS process.env DIRECTLY ────────────────────────────────
//
// It does NOT import `#shared/config/env`, and that is deliberate. That module
// parses the FULL service schema at import time (ADR-0014), which requires
// DOCDB_HOST/DOCDB_USERNAME/DOCDB_PASSWORD/SES_FROM_ADDRESS. Importing it here
// would drag the database and mailer configuration into the render path, and
// would break the two contexts that legitimately have none of it:
//   - `tests/email/catalog.test.ts`, which renders every template and stubs no
//     env at all;
//   - `pnpm run email` (the react-email preview server), which imports the
//     templates outside the service entirely.
//
// The runtime guarantee lives where it belongs instead: ASSETS_BASE_URL is a
// REQUIRED key of that Zod schema, so a deployed Lambda missing it dies at boot
// with a named error rather than mailing broken images. This module only has to
// keep working in the two contexts above, so it falls back to the local Floci
// bucket URL — the same value `make env-file` writes.
//
// ─── DIMENSIONS: file size vs DISPLAY size ───────────────────────────────────
//
// The `width`/`height` exported here are DISPLAY sizes, and they must be emitted
// as HTML ATTRIBUTES on the <Img>, never only as CSS classes: Outlook renders
// through Word's HTML engine, which sizes images from the attributes and ignores
// CSS dimensions. An <Img> without them renders at its intrinsic size and bursts
// whatever it sits in.
//
// Two DIFFERENT relationships between file size and display size live here, and
// confusing them is what produced the "icons are tiny" defect:
//
//   - A GLYPH-ONLY image is uploaded at 2x its display size so it stays sharp on
//     retina/HiDPI screens (the 40x40 CTA glyphs shown at 20px).
//   - A COMPONENT image — one with its coloured disc baked in — is shown at its
//     FULL size, because scaling it down shrinks the glyph inside it just as
//     much. The four header icons and the three timeline dots are these.
//
// The header icons were being treated as the first kind while actually being the
// second, so the visible glyph came out at ~22% of its disc. See the block above
// `userCheck` for the measurements.

// Trailing slash is REJECTED, not trimmed — see the matching note on
// ASSETS_BASE_URL in src/shared/config/env.ts. Keys are joined with a literal
// "/", so "…/assets/" would produce a double slash, which S3 resolves as a
// different (nonexistent) key and answers 404 — silently, since nothing in the
// send path ever fetches these URLs.
const FALLBACK_BASE_URL = "http://localhost:4566/post-3mrai-local-post-assets";

const baseUrl = (process.env.ASSETS_BASE_URL ?? FALLBACK_BASE_URL).replace(/\/+$/, "");

// The object keys, exactly as `make assets-sync` uploads them from `assets/`.
// They are string literals rather than a read of `assets/assets.manifest.json`:
// that manifest is a BUILD/DEV-TIME artifact, it is gitignored, and esbuild does
// not bundle it — reading it at runtime would throw ENOENT inside the Lambda.
// The runtime needs only the base URL plus these known keys.
function assetUrl(key: string): string {
  return `${baseUrl}/${key}`;
}

/**
 * One image: its URL plus the DISPLAY dimensions to spread onto an `<Img>` as
 * HTML attributes. Spreading the whole object (`{...emailAssets.logo}`) is what
 * keeps a template from getting the src right and the sizing wrong.
 */
export interface EmailAsset {
  src: string;
  width: string;
  height: string;
}

function asset(key: string, size: number): EmailAsset {
  // `width`/`height` are STRINGS because they are HTML attributes, and that is
  // the type `<Img>` takes for them.
  return { src: assetUrl(key), width: String(size), height: String(size) };
}

export const emailAssets = Object.freeze({
  // Header lockup mark — 42x42 file, shown at 42px (1:1, it is already small).
  // An ENHANCEMENT beside the "3M"+"RAI" text lockup, never a replacement for
  // it: the text is the only element of the header with genuinely 100% reach,
  // since a reader with images off still sees it.
  logo: asset("email/logo.png", 42),

  // ─── HEADER ICONS: THE DISC IS IN THE PNG, SO THE PNG IS SHOWN AT FULL SIZE ──
  //
  // Each of these four 64x64 files is a COMPLETE COMPONENT: a coloured disc
  // with the glyph already centred inside it. Verified against the pixels, not
  // assumed — `user-check.png` has fully transparent corners, an edge pixel of
  // rgb(255,244,229) (the exact `brand-orange-light` tint the template's CSS
  // circle used), and a glyph bounding box of 26x24 inside the 64px disc, i.e.
  // 41% of it. `map-pin`/`log-in` carry the info-blue rgb(239,246,255) and
  // `package-check` the success rgb(236,253,245), each with a glyph at 34-41%.
  //
  // THE BUG THIS FIXES — TWO NESTED DISCS. These used to be displayed at 28px
  // (then 36px) INSIDE a separate 64px CSS circle drawn by the template. Since
  // the PNG's own disc is the same tint as the CSS circle, it was invisible
  // against it, and the only thing a reader could actually see was the glyph:
  // 36px x ~38% = a 14px mark floating in a 64px disc — 22% of it, measured on
  // a rendered screenshot. That is why the icons read as specks. Scaling the
  // image up was treating the symptom: at any size below 64px the PNG's disc
  // stays hidden and its glyph stays proportionally undersized.
  //
  // The fix is to render each PNG at the FULL 64px diameter of the circle it
  // replaces and DELETE the template's CSS circle (its `bg-*`, its
  // `rounded-[32px]`, and its w/h). The image is now the whole component, and
  // the glyph lands at the 34-41% the artwork was drawn at.
  //
  // This is exactly the technique the timeline dots already use (see
  // `greenDot` below) and the one [[email-templates]] § "Known gap — rounded
  // corners in Outlook Windows" records as the recommended option 1 — with the
  // bonus that Outlook Windows, which supports no `border-radius` at all and
  // rendered every one of these discs as a SQUARE, now gets a real circle.
  //
  // COST, ACCEPTED DELIBERATELY: the disc is no longer drawn by CSS, so a
  // reader whose client blocks the image loses the whole marker rather than
  // keeping a tinted circle. The layout does NOT collapse — `<Img>` keeps its
  // `width`/`height` HTML attributes, so every client that honours them (all of
  // the ones that matter for alt-box sizing) reserves the 64x64 box and the
  // heading stays where it is. The `alt` text carries the meaning, and no icon
  // here was ever the only thing conveying required information: each template
  // states its subject in the heading directly below.
  //
  // At 64px these run at 1x, not 2x, so they are no longer retina-sharp. That
  // is the trade for showing the artwork as drawn; re-exporting the four files
  // at 128x128 would restore it without any code change here.
  userCheck: asset("email/user-check.png", 64),
  packageCheck: asset("email/package-check.png", 64),
  mapPin: asset("email/map-pin.png", 64),
  logIn: asset("email/log-in.png", 64),

  // CTA glyphs — 40x40 files shown at 20px.
  //
  // Same baked-in disc, but here it is a FEATURE rather than a defect: the
  // disc is rasterised in rgb(59,130,246), the exact `infoBlue` of the button
  // these sit on, so it blends into the button face and only the pale glyph
  // reads. There is no CSS circle behind them to remove. The glyph occupies
  // 35-38% of the 40px file, so at a 20px display size it draws at ~7px beside
  // a 15px label — which is the optical weight a small leading glyph wants
  // (a 15px label's cap height is itself only ~11px). The button's LABEL still
  // carries the CTA on its own with images blocked.
  packageSearch: asset("email/package-search.png", 20),
  externalLink: asset("email/external-link.png", 20),

  // Security-notice glyph — 40x40 file shown at 20px, FILLING its badge rather
  // than floating inside it (it was 13px in a 20px badge, i.e. a ~6px triangle).
  //
  // The CSS badge behind it (white fill, 1px amber ring) is removed like the
  // header circles, but note what that costs HERE and does not cost there: this
  // PNG's disc is rgb(255,248,225), the notice panel's OWN fill, so the marker
  // has no visible edge and reads as a bare triangle rather than a badge. The
  // four header icons keep reading as circles because their discs contrast with
  // the white card behind them.
  //
  // Neither half of the badge was recoverable, and both were checked rather than
  // assumed: the white fill is covered because the PNG is opaque across its disc
  // (1516 of its 1600 pixels are alpha 255 — only the corners are transparent),
  // and the amber ring was tried and reverted after looking at the render, where
  // it painted as four detached straight segments because the image fills the
  // cell exactly and leaves the rounded corners no gap to curve through.
  triangleAlert: asset("email/triangle-alert.png", 20),

  // Timeline state dots — shown at 22px, which is the exact diameter the
  // CSS-drawn dots used, so the indicator column's alignment is unchanged.
  //
  // These REPLACE `inline-block` spans with `border-radius: 50%`. That was the
  // most fragile construct in the whole template set: `border-radius` has 82.92%
  // support (caniemail.com/features/css-border-radius) and Outlook on Windows
  // has NONE of it, so every dot rendered as a SQUARE there. A PNG of a circle
  // is a circle in every client, and it removes the template's dependence on
  // both `border-radius` and `inline-block` in one move.
  //
  // Colour still distinguishes the three states on its own, so a reader with
  // images off loses the dots but not the timeline: each step keeps its text
  // label and its date, and the active step keeps its bold weight.
  greenDot: asset("email/green-dot.png", 22),
  orangeDot: asset("email/orange-dot.png", 22),
  blankDot: asset("email/blank-dot.png", 22),
} as const);

export type EmailAssets = typeof emailAssets;
