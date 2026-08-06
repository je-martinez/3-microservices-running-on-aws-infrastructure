import { Html, Head, Body, Container, Section, Row, Column, Text, Hr } from "@react-email/components";
import type { ReactNode } from "react";
import { theme } from "../theme.ts";

// Shared chrome for every transactional email. Lives in `emails/` (the
// react-email CLI's default dir) rather than under `src/` so `email dev` picks
// it up for preview without a second copy of the templates.
//
// Inline styles, not a stylesheet: email clients strip <style> blocks
// inconsistently, so react-email's style props are the portable option. That
// also rules out CSS classes and CSS custom properties — hence `theme.ts`,
// which is plain JS values interpolated into style objects at render time.
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
// than a named variable, so it is not in `theme.ts`.
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
  return (
    <Text
      style={{
        margin: "0",
        fontFamily: theme.fontHeading,
        fontSize: `${fontSize}px`,
        fontWeight: 800,
        lineHeight: "1.2",
      }}
    >
      <span style={{ color: theme.bgWhite }}>3M</span>
      <span style={{ color: theme.brandOrange }}>RAI</span>
    </Text>
  );
}

export function EmailHeader() {
  return (
    <Section style={{ backgroundColor: theme.brandNavy, padding: "20px 32px" }}>
      <Row>
        <Column align="left">
          <LogoLockup fontSize={18} />
        </Column>
        <Column align="right">
          <Text
            style={{
              margin: "0",
              fontFamily: theme.fontBody,
              fontSize: "11px",
              fontWeight: 400,
              letterSpacing: "3px",
              color: theme.textMuted,
            }}
          >
            COMPANY
          </Text>
        </Column>
      </Row>
    </Section>
  );
}

export function EmailFooter() {
  return (
    <Section style={{ backgroundColor: theme.brandNavy, padding: "24px 32px" }}>
      <Row>
        <Column align="center">
          <LogoLockup fontSize={14} />
        </Column>
      </Row>

      <Hr
        style={{
          borderColor: FOOTER_DIVIDER,
          borderTopWidth: "1px",
          margin: "16px 0",
        }}
      />

      <Text
        style={{
          margin: "0",
          fontFamily: theme.fontBody,
          fontSize: "11px",
          color: theme.textMuted,
          textAlign: "center",
        }}
      >
        3MRAI Company · San Juan, PR · support@3mrai.com
      </Text>
      <Text
        style={{
          margin: "8px 0 0",
          fontFamily: theme.fontBody,
          fontSize: "10px",
          color: theme.textMuted,
          textAlign: "center",
        }}
      >
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
    <Html>
      <Head />
      <Body
        style={{
          margin: "0",
          padding: "0",
          fontFamily: theme.fontBody,
          backgroundColor: theme.bgBody,
          color: theme.textPrimary,
        }}
      >
        <Container style={{ width: EMAIL_WIDTH, maxWidth: EMAIL_WIDTH, margin: "0 auto", padding: "0" }}>
          <EmailHeader />

          {/* "Body Wrapper" in the `.pen`: 32px of page gutter around the card. */}
          <Section style={{ backgroundColor: theme.bgBody, padding: "32px" }}>
            {/* "Content Card" — identical in all five `.pen` frames. */}
            <Section
              style={{
                backgroundColor: theme.bgWhite,
                borderRadius: "8px",
                padding: "40px 36px",
              }}
            >
              {children}
            </Section>
          </Section>

          <EmailFooter />
        </Container>
      </Body>
    </Html>
  );
}
