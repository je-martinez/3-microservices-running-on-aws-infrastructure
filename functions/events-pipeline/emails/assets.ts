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
// The uploaded PNGs are deliberately 2x their display size (a 64x64 file shown
// at 28px, a 40x40 shown at 16px) so they stay sharp on retina/HiDPI screens.
// The `width`/`height` exported here are the DISPLAY sizes, and they must be
// emitted as HTML ATTRIBUTES on the <Img>, never only as CSS classes: Outlook
// renders through Word's HTML engine, which sizes images from the attributes and
// ignores CSS dimensions. An <Img> without them renders at its full 64px and
// bursts the 64px circle it sits in.

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

  // Header icon circles — 64x64 files shown at 28px (2x retina). Each sits
  // inside the coloured disc its template already had, which is what carries the
  // design when the image does not load.
  userCheck: asset("email/user-check.png", 28),
  packageCheck: asset("email/package-check.png", 28),
  mapPin: asset("email/map-pin.png", 28),
  logIn: asset("email/log-in.png", 28),

  // Small inline icons — 40x40 files shown at 16px (2.5x). The two CTA glyphs
  // sit on a filled button whose LABEL carries it on its own.
  packageSearch: asset("email/package-search.png", 16),
  externalLink: asset("email/external-link.png", 16),
  // The security-notice glyph is shown at 13px to fit its 20px badge.
  triangleAlert: asset("email/triangle-alert.png", 13),

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
