// CONTRACT: Serve email template images via remote URLs and set width/height as HTML
// attributes on <Img>. Do NOT embed base64 data URIs (breaks in ~19% of clients and
// risks Gmail clipping). Do NOT rely on CSS dimensions for Outlook Windows.
// See [[email-templates]]

// WHY: Read process.env directly so catalog tests and preview servers run without full DB env.
// CONTRACT: Do NOT allow trailing slashes in ASSETS_BASE_URL; double slashes resolve to
// non-existent keys in S3 and return 404.
// See [[email-templates]]
const FALLBACK_BASE_URL = "http://localhost:4566/post-3mrai-local-post-assets";

const baseUrl = (process.env.ASSETS_BASE_URL ?? FALLBACK_BASE_URL).replace(/\/+$/, "");

// WHY: Literal string keys avoid runtime ENOENT since assets.manifest.json is not bundled.
function assetUrl(key: string): string {
  return `${baseUrl}/${key}`;
}

/**
 * One image URL plus display dimensions to spread onto an `<Img>` as HTML attributes.
 */
export interface EmailAsset {
  src: string;
  width: string;
  height: string;
}

function asset(key: string, size: number): EmailAsset {
  // HTML attribute dimensions must be strings for <Img>.
  return { src: assetUrl(key), width: String(size), height: String(size) };
}

export const emailAssets = Object.freeze({
  // WHY: Text lockup accompanies the logo so header remains readable with images blocked.
  logo: asset("email/logo.png", 42),

  // CONTRACT: Display header icon PNGs at the full 64px diameter without CSS circle wrappers.
  // The disc is baked into the artwork; nesting inside a CSS circle shrinks the visible glyph
  // to ~22% of the disc and renders as a square in Outlook Windows.
  // See [[email-templates]]
  userCheck: asset("email/user-check.png", 64),
  packageCheck: asset("email/package-check.png", 64),
  mapPin: asset("email/map-pin.png", 64),
  logIn: asset("email/log-in.png", 64),

  // CONTRACT: Display at 64px without CSS circle wrappers. Disc is baked into the artwork.
  // See [[email-templates]]
  keyRound: asset("email/key-round.png", 64),

  // CONTRACT: Display CTA glyphs at 40px (not 20px). The glyph occupies ~32% of the canvas;
  // displaying at 20px shrinks the glyph to ~6.5px and reads as a speck.
  // See [[email-templates]]
  packageSearch: asset("email/package-search.png", 40),
  externalLink: asset("email/external-link.png", 40),

  // CONTRACT: Display at 20px without CSS badge wrapper. The PNG disc matches the panel fill.
  // See [[email-templates]]
  triangleAlert: asset("email/triangle-alert.png", 20),

  // WHY: timer.png omitted deliberately; the design uses a plain muted text line for expiry.

  // CONTRACT: Use PNG circles for timeline dots instead of CSS border-radius spans.
  // Outlook on Windows does not support CSS border-radius and renders spans as squares.
  // See [[email-templates]]
  greenDot: asset("email/green-dot.png", 22),
  orangeDot: asset("email/orange-dot.png", 22),
  blankDot: asset("email/blank-dot.png", 22),
} as const);

export type EmailAssets = typeof emailAssets;
