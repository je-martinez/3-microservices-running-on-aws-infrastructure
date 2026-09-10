import { Html, Head, Font, Body, Container, Section, Row, Column, Text, Hr, Img } from "@react-email/components";
import type { ReactNode } from "react";
import { Brand } from "./brand.tsx";
import { emailAssets } from "../assets.ts";

// Shared chrome for every transactional email. Lives in `emails/` so the
// react-email CLI picks it up for preview without a second copy.
// CONTRACT: Delivery is inline styles, never a stylesheet — clients strip
// <style> inconsistently. The `className`s are not an exception: `<Brand>` wraps
// this tree in `<Tailwind>`, which compiles them to inline styles during render.
// Layout is `Row`/`Column` (tables), never flex or grid, whatever the `.pen`
// design expresses — email clients do not reliably support either.
// See [[email-templates]]

// The `.pen` frames are 600px wide — the standard transactional email width.
const EMAIL_WIDTH = "600px";

// Footer divider colour. A one-off in the `.pen`, used once, so a named token in
// `theme.ts` would add indirection without removing duplication.
const FOOTER_DIVIDER = "#3D4A5C";

// CONTRACT: The "3M" + "RAI" TEXT LOCKUP stays beside the mark. A reader with
// images off still sees the brand, because text is the only element with 100%
// reach; the mark is an enhancement on a header already complete without it and
// must never become the only thing carrying the brand.
// See [[email-templates]]
function LogoLockup({ fontSize }: { fontSize: number }) {
  // CONTRACT: One <Text> with <span>s — two <Text> nodes each render a
  // block-level <p> and stack "3M" over "RAI". `fontSize` stays INLINE: it is a
  // runtime prop, and Tailwind only compiles classes visible as static strings,
  // so an interpolated `text-[...]` generates no rule and the size vanishes.
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
        {/* CONTRACT: Two CELLS, not an <Img> and <Text> in one — <Text> renders
            a block <p> that pushes the lockup below the mark. The mark's cell is
            its exact display width so the wordmark takes the rest. `width`/
            `height` are HTML ATTRIBUTES: Outlook sizes images from those and
            ignores CSS, so a class-only mark renders at natural size.
            See [[email-templates]] */}
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

      {/* CONTRACT: The border colour stays an inline `style`. `Hr` ships its
          own default border shorthand, and react-email emits component defaults
          AFTER Tailwind's compiled classes, so a `border-[...]` class loses and
          the rule renders grey — the email still looks fine, so nothing fails
          loudly. Margins are safe as classes.
          See [[email-templates]] */}
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
          {/* CONTRACT: Pass no webFont URL. Gmail, Outlook on Windows and most
              webmail STRIP the <style> block this emits, so for most recipients
              `fallbackFontFamily` is what renders and the webfont is an
              enhancement only. This is the one unavoidable <style> block in the
              output, and it carries a `* { font-family: … }` wildcard — harmless
              only because every element carries its own inline font-family. Do
              NOT let a template drop its font class and rely on inheritance.
              See [[email-templates]] */}
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

            {/* CONTRACT: "Body Wrapper" is PADDING ONLY — no background, which
                would paint the page colour on itself. Safe because the colour
                does not live on `<body>` alone (most webmail replaces that tag
                with a `<div>`): react-email's `<Body>` also emits a full-width
                wrapper table carrying it.
                See [[email-templates]] */}
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
