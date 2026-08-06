import { Html, Head, Font, Body, Container, Section, Row, Column, Text, Hr } from "@react-email/components";
import type { ReactNode } from "react";
import { Brand } from "./brand.tsx";

// Shared chrome for every transactional email. Lives in `emails/` (the
// react-email CLI's default dir) rather than under `src/` so `email dev` picks
// it up for preview without a second copy of the templates.
//
// Still inline styles at delivery time, not a stylesheet: email clients strip
// <style> blocks inconsistently. The `className`s below are NOT an exception to
// that rule — `<Brand>` wraps this tree in react-email's `<Tailwind>`, which
// compiles every class into an inline `style` attribute DURING render, so the
// delivered HTML carries no `class` attribute and no <style> block. See
// `components/brand.tsx` for the full reasoning and the token config.
//
// Ported from the two `reusable: true` frames of `assets/email/emails.pen`,
// "Email Header" and "Email Footer". The `.pen` expresses their layout with
// flexbox (`justifyContent: space_between`) because Pencil is a design tool;
// email clients do NOT reliably support flex or grid, so the INTENT (logo left,
// tag right) is translated into react-email's `Row`/`Column`, which render as
// tables.

// The `.pen` frames are 600px wide — the standard transactional email width.
const EMAIL_WIDTH = "600px";

// Footer divider colour. A one-off in the `.pen` (`#3D4A5C`, a navy tint) rather
// than a named variable, so it is not in `theme.ts` — and, for the same reason,
// not in the Tailwind config either: it is used ONCE, in this file, so a named
// token would add indirection without removing any duplication. It stays an
// arbitrary value at its single call site (`border-[#3D4A5C]`), which keeps the
// hex visible next to the only rule that uses it.
const FOOTER_DIVIDER = "#3D4A5C";

// The logo mark (`assets/img/standalone-logo.png`) is deliberately NOT rendered.
// It is a 1.38 MB 1024x1024 master shown at 42px, emails cannot reference
// repo-relative paths, and many clients block remote images by default. So the
// brand is carried by the "3M" + "RAI" text lockup, which is legible with no
// images at all. If an <Img> is ever added it needs a PUBLICLY HOSTED URL (plus
// a resized asset), and it must stay an ENHANCEMENT — never the only thing
// carrying the brand, or the header goes blank for every reader who blocks
// images.
function LogoLockup({ fontSize }: { fontSize: number }) {
  // Two <Text> nodes would each become a block-level <p>, stacking "3M" over
  // "RAI". A single line with <span>s keeps the lockup on one line in every
  // client.
  //
  // `fontSize` STAYS inline: it is a runtime prop (18px in the header, 14px in
  // the footer), and Tailwind can only compile classes it can see as static
  // strings at build time. `text-[${fontSize}px]` would produce a class the
  // compiler never generates a rule for, and the size would silently vanish
  // from the output. Mixing `className` and `style` on one element is expected.
  return (
    <Text
      className="m-0 font-heading font-extrabold leading-[1.2]"
      style={{ fontSize: `${fontSize}px` }}
    >
      <span className="text-bg-white">3M</span>
      <span className="text-brand-orange">RAI</span>
    </Text>
  );
}

export function EmailHeader() {
  return (
    <Section className="bg-brand-navy px-[32px] py-[20px]">
      <Row>
        <Column align="left">
          <LogoLockup fontSize={18} />
        </Column>
        <Column align="right">
          <Text className="m-0 font-body text-[11px] font-normal tracking-[3px] text-text-muted">
            COMPANY
          </Text>
        </Column>
      </Row>
    </Section>
  );
}

export function EmailFooter() {
  return (
    <Section className="bg-brand-navy px-[32px] py-[24px]">
      <Row>
        <Column align="center">
          <LogoLockup fontSize={14} />
        </Column>
      </Row>

      {/* STOP POINT — the border stays an inline `style`, deliberately.
          `Hr` ships its own default `style` ("border:none;border-top:1px solid
          #eaeaea"), and react-email emits component defaults AFTER the styles
          Tailwind compiled from `className`. A `border-[#3D4A5C]` class is
          therefore OVERRIDDEN by that shorthand and the rule renders grey — the
          email still looks fine, so nothing fails loudly. Passing the colour via
          `style` puts it last in the cascade, where it wins. Margins are safe as
          classes (`Hr`'s default sets none), so only the colour moves. */}
      <Hr
        className="my-[16px]"
        style={{ borderColor: FOOTER_DIVIDER, borderTopWidth: "1px" }}
      />

      <Text className="m-0 font-body text-[11px] text-text-muted text-center">
        3MRAI Company · San Juan, PR · support@3mrai.com
      </Text>
      <Text className="mt-[8px] mb-0 mx-0 font-body text-[10px] text-text-muted text-center">
        You received this email because you have an account with 3MRAI. Unsubscribe
      </Text>
    </Section>
  );
}

// Prop contract unchanged (`{ children }`) so the four templates keep compiling
// while they are redesigned. Children render INSIDE the white content card, so a
// template supplies only its own body.
export function EmailLayout({ children }: { children: ReactNode }) {
  return (
    // `<Brand>` sits ABOVE the whole tree, so every template inherits the
    // Tailwind config without importing or configuring Tailwind itself. A
    // template only writes classes.
    <Brand>
      <Html>
        <Head>
          {/*
            WHAT <Font> CAN AND CANNOT DO — read before trusting it.

            It emits an @font-face rule (inside a <style> block in <head>) plus a
            fallback declaration. @font-face in email is supported by roughly
            Apple Mail, iOS Mail and Outlook for Mac; Gmail (web and mobile),
            Outlook on Windows and most webmail clients STRIP the <style> block
            outright. So for the majority of recipients the webfont never loads
            and `fallbackFontFamily` is what actually renders.

            That is why no webFont URL is passed: loading Inter from a remote
            host would buy a minority of clients a nicer face while adding an
            external request, and the design already assumes the fallback stack
            (see theme.ts). This declares the family and its fallbacks so the
            clients that DO honour @font-face resolve "Inter" consistently — an
            ENHANCEMENT layered on top of type that is already legible without
            it. It must never become the only thing making the type work.

            CONSEQUENCE TO KNOW: this is the ONE <style> block in the output, and
            it is unavoidable — an @font-face rule has no inline equivalent. It
            also carries a `* { font-family: … }` rule that `<Font>` emits by
            design. That wildcard is harmless HERE only because every element
            already carries its own inline `font-family` (Tailwind compiled
            `font-body`/`font-heading` onto each one), and an inline style beats
            any selector from a <style> block. If a future template ever drops
            its font class and relies on inheritance, this rule — not the theme —
            would decide its typeface in the clients that keep <style>.
          */}
          <Font
            fontFamily="Inter"
            fallbackFontFamily={["Helvetica", "Arial", "sans-serif"]}
            fontWeight={400}
            fontStyle="normal"
          />
        </Head>
        <Body className="m-0 p-0 font-body bg-bg-body text-text-primary">
          {/* `width`/`maxWidth` stay inline: `Container` is a fixed 600px frame
              and the two must not drift, so they read from one constant. */}
          <Container
            className="mx-auto p-0"
            style={{ width: EMAIL_WIDTH, maxWidth: EMAIL_WIDTH }}
          >
            <EmailHeader />

            {/* "Body Wrapper" in the `.pen`: 32px of page gutter around the card. */}
            <Section className="bg-bg-body p-[32px]">
              {/* "Content Card" — identical in all five `.pen` frames. */}
              <Section className="bg-bg-white rounded-[8px] px-[36px] py-[40px]">
                {children}
              </Section>
            </Section>

            <EmailFooter />
          </Container>
        </Body>
      </Html>
    </Brand>
  );
}
