import { Tailwind, pixelBasedPreset, type TailwindConfig } from "@react-email/components";
import type { ReactNode } from "react";
import { theme } from "../theme.ts";

// The Tailwind provider for every transactional email. `EmailLayout` composes it
// above the whole tree, so NO template imports `<Tailwind>` or configures it —
// there is exactly one config in the service and templates only write classes.
//
// WHY TAILWIND AT ALL, GIVEN EMAIL'S CONSTRAINTS:
// `<Tailwind>` is not a runtime stylesheet. It COMPILES each class to an inline
// `style` attribute while rendering, so the HTML that reaches the mail client is
// still fully inlined — byte-for-byte the same delivery mechanism the
// hand-written style objects used, and the only one that survives Gmail/Outlook.
// No <style> block is emitted and no `class` attribute is left behind (verified
// against the rendered output; see the snapshot). NOTHING about email
// compatibility changes here.
//
// What changes is AUTHORSHIP: the brand's hex values and font stacks used to be
// repeated across five files as `theme.foo` interpolations inside style objects.
// Now they are declared once, below, and every template refers to them by name
// (`bg-brand-navy`, `text-text-muted`). A token changes in one place.
//
// `theme.ts` REMAINS the source of truth for the VALUES — this config consumes
// it rather than restating it, so no hex string is duplicated and the manual
// `.pen` <-> code mirroring documented in `theme.ts` stays single-sourced.

// `pixelBasedPreset` is REQUIRED, not optional. Tailwind v4's default scale is
// expressed in `rem` (`text-sm` -> 0.875rem, `p-4` -> 1rem), and several mail
// clients handle rem badly — Outlook's Word engine in particular resolves it
// against the wrong root, which silently rescales the whole email. The preset
// re-expresses the spacing and font-size scales in `px`. Omitting it is the
// single most likely way to degrade rendering without any test failing.
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
