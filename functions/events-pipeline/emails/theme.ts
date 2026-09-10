// Brand tokens for every transactional email — the source of truth in code,
// mirroring the `variables` object of `assets/email/emails.pen`.
// CONTRACT: The mirroring is MANUAL. Nothing generates this file from the `.pen`
// and nothing reads the `.pen` at build or run time, so a token changed in one
// place and not the other drifts silently. Keys are camelCase here where the
// `.pen` uses kebab-case, so templates can use dot access.
// See [[email-templates]]
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
