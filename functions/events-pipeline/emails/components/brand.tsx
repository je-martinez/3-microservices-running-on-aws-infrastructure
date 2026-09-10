import { Tailwind, pixelBasedPreset, type TailwindConfig } from "@react-email/components";
import type { ReactNode } from "react";
import { theme } from "../theme.ts";

// CONTRACT: The one Tailwind config in the service. `EmailLayout` composes it
// above the whole tree, so NO template imports `<Tailwind>` or configures its
// own — templates only write classes. This is not a runtime stylesheet: it
// COMPILES each class to an inline `style` during render, emitting no <style>
// block and no `class` attribute, which is the only delivery Gmail and Outlook
// survive. `theme.ts` stays the source of truth for the VALUES; this config
// consumes them rather than restating any hex.
// See [[email-templates]]

// CONTRACT: `pixelBasedPreset` is REQUIRED. Tailwind v4's default scale is in
// `rem`, and Outlook's Word engine resolves rem against the wrong root and
// silently rescales the whole email. Omitting it degrades rendering with no test
// failing.
// See [[email-templates]]
const config: TailwindConfig = {
  presets: [pixelBasedPreset],
  theme: {
    extend: {
      // Nested so the generated class names read as sentences at the call site
      // (`bg-brand-navy`, `text-brand-orange`), while flat entries stay flat
      // (`bg-info-bg`, `text-text-muted`). Values come from `theme.ts` — never
      // retyped here.
      colors: {
        brand: {
          navy: theme.brandNavy,
          orange: theme.brandOrange,
          "orange-light": theme.brandOrangeLight,
        },
        bg: {
          body: theme.bgBody,
          white: theme.bgWhite,
        },
        text: {
          primary: theme.textPrimary,
          secondary: theme.textSecondary,
          muted: theme.textMuted,
        },
        // `border-border` would read badly, so the line colour keeps a name that
        // works in every utility that takes it (`border-line`, `bg-line`).
        line: theme.borderColor,
        success: theme.successGreen,
        "success-bg": theme.successBg,
        info: theme.infoBlue,
        "info-bg": theme.infoBg,
      },
      // Tailwind wants the stack as an array; `theme.ts` stores it as the CSS
      // string that the style objects used. Splitting keeps one representation
      // authoritative instead of maintaining a second, array-shaped copy.
      fontFamily: {
        heading: theme.fontHeading.split(",").map((family) => family.trim().replace(/^'|'$/g, "")),
        body: theme.fontBody.split(",").map((family) => family.trim().replace(/^'|'$/g, "")),
      },
    },
  },
};

export function Brand({ children }: { children: ReactNode }) {
  return <Tailwind config={config}>{children}</Tailwind>;
}
