import { Html, Head, Font, Body, Container, Section, Row, Column, Text, Hr, Img } from "@react-email/components";
import type { ReactNode } from "react";
import { Brand } from "./brand.tsx";
import { emailAssets } from "../assets.ts";

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

// The logo mark IS now rendered — the two objections that kept it out are both
// resolved. It is no longer the 1.38 MB 1024x1024 master: `make assets-sync`
// uploads a 42x42, ~1.3 KB `email/logo.png`. And it no longer needs a
// repo-relative path: the asset has a real public URL, built from
// ASSETS_BASE_URL in `emails/assets.ts`.
//
// The "many clients block remote images by default" objection does not survive
// contact with the numbers: a remote <img> has 100% client support, and Gmail has
// shown remote images BY DEFAULT since 2013 (it proxies them). The full argument,
// and why this reverses the base64 decision, is in `emails/assets.ts`.
//
// The "3M" + "RAI" TEXT LOCKUP STAYS BESIDE IT, and that is not decoration. A
// reader who turns images off — or whose client fails to fetch — still sees the
// brand, because text is the only element here with genuinely 100% reach. The
// mark is an ENHANCEMENT layered on a header that is already complete without
// it; it must never become the only thing carrying the brand.
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
        {/* Mark + wordmark, left. They are two CELLS of one row rather than an
            <Img> and a <Text> in the same cell: <Text> renders a block-level
            <p>, which would push the lockup onto its own line under the mark.
            Two table cells keep them side by side in every client.

            The mark's cell is `width="42"` — its exact display width — so the
            wordmark's cell takes the remaining space and the two stay adjacent
            instead of the mark's cell stretching. `valign="middle"` on both
            keeps the 42px mark and the 18px type on a shared centre line.

            `width`/`height` come from the asset entry as HTML ATTRIBUTES.
            Outlook sizes images from the attributes and ignores CSS, so a mark
            with only a class would render at its natural size and blow the
            header's height open. */}
        <Column width="42" valign="middle">
          <Img
            {...emailAssets.logo}
            alt="3MRAI"
            // `block` kills the few px of descender gap an inline replaced
            // element leaves under itself, which would otherwise offset the
            // mark from the wordmark's baseline.
            className="block"
          />
        </Column>
        <Column align="left" valign="middle" className="pl-[10px]">
          <LogoLockup fontSize={18} />
        </Column>
        <Column align="right" valign="middle">
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

// Prop contract is deliberately just `{ children }`, so every template keeps
// compiling across redesigns. Children render INSIDE the white content card, so a
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

            {/* "Body Wrapper" in the `.pen`: 32px of page gutter around the card.
                PADDING ONLY — deliberately no background.

                The `.pen` fills this frame with `bg-body` because a Pencil frame
                has no inherited backdrop, but in HTML it painted `#F4F4F5` on
                top of `#F4F4F5` — invisible, and a second place the page colour
                could be changed from.

                Removing it is safe for a reason worth stating, because the
                obvious objection is right: `<body>` styling has only 65.86%
                support, and Gmail, Outlook.com, Yahoo and AOL all replace the
                tag with a `<div>`, so a page background that lived ONLY on
                `<body>` would vanish for most webmail readers. It does not live
                only there — react-email's `<Body>` also emits a full-width
                wrapper `<table>`/`<td>` carrying the same colour, which is
                exactly the "put it on a wrapper table" practice those clients
                need. Verified in the rendered HTML: three elements carried this
                colour, and the two that survive are the ones that matter. */}
            <Section className="p-[32px]">
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
