// Brand tokens for every transactional email — the single source of truth IN
// CODE. The values mirror the `variables` object of `assets/email/emails.pen`,
// the Pencil document that is the visual design space for these templates.
//
// The mirroring is MANUAL and deliberate: nothing generates this file from the
// `.pen`, and nothing reads the `.pen` at build or run time. The two are kept in
// sync BY HAND — change a token in the design and you must change it here (and
// vice versa) in the same commit, or the rendered email and the mockup drift
// apart silently.
//
// Keys are camelCase here (`brandNavy`) where the `.pen` uses kebab-case
// (`brand-navy`), so templates can use dot access instead of bracket lookups.
export const theme = Object.freeze({
  // Brand
  brandNavy: "#2D3748",
  brandOrange: "#F7941D",
  brandOrangeLight: "#FFF4E5",

  // Surfaces
  bgBody: "#F4F4F5",
  bgWhite: "#FFFFFF",

  // Type
  textPrimary: "#1A1A2E",
  textSecondary: "#6B7280",
  textMuted: "#9CA3AF",

  // Lines
  borderColor: "#E5E7EB",

  // Semantic — success
  successGreen: "#10B981",
  successBg: "#ECFDF5",

  // Semantic — info
  infoBlue: "#3B82F6",
  infoBg: "#EFF6FF",

  // Typography. The `.pen` names the family "Inter"; email clients cannot be
  // relied on to have it, so these carry a web-safe fallback stack. Web fonts
  // are not loaded — @font-face lives in a <style> block, which is exactly what
  // clients strip.
  fontHeading: "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  fontBody: "Inter, 'Helvetica Neue', Helvetica, Arial, sans-serif",
} as const);

export type Theme = typeof theme;
