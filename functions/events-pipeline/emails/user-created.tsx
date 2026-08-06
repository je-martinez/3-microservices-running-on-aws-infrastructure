import { Heading, Section, Row, Column, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { Button } from "./components/button.tsx";
import { DetailRow } from "./components/detail-row.tsx";
import { theme } from "./theme.ts";

// `createdAt` is the ISO-8601 string the producer serialized (Users'
// SqsEventPublisher calls `.toISOString()`), not a Date: it crossed a JSON
// boundary, and typing it as a Date here would be a lie the renderer would
// eventually trip over.
export interface UserCreatedEmailProps {
  fullName: string;
  email: string;
  userId: string;
  createdAt: string;
}

// The "Account Details" panel fill (`#F9FAFB`) is a one-off in the `.pen` rather
// than a named variable, so it is not in `theme.ts` — same treatment as the
// footer divider in `components/layout.tsx`.
const DETAILS_PANEL_BG = "#F9FAFB";

// The `.pen`'s "Member Since" row shows a human date ("August 5, 2026"), not the
// ISO-8601 string the envelope carries. Formatting is pinned to `en-US` and
// **UTC**: the renderer runs in a Lambda whose TZ is UTC anyway, and letting the
// host zone decide would make the same event render two different dates
// depending on where it was processed — and make the snapshot machine-dependent.
//
// A malformed or absent timestamp must never reach the reader as "Invalid Date":
// the row is dropped instead (see the conditional render below), which is why
// this returns null rather than a placeholder string.
function formatMemberSince(createdAt: string | undefined): string | null {
  if (!createdAt) return null;
  const parsed = new Date(createdAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// The `.pen`'s "Icon Circle" holds a 28px lucide `user-check`. NONE of the ways
// to ship a real icon survive email: an icon font needs @font-face (a <style>
// block, which clients strip), an SVG sprite needs an external reference, inline
// SVG is unsupported in Outlook and Gmail, and a remote <img> is blocked by
// default in many clients — leaving a broken-image box as the first thing above
// the heading.
//
// So the circle is kept and the glyph is TEXT: "✓" is in WGL4/basic Unicode and
// renders in every mail client without a webfont. The email therefore looks
// deliberate with zero images loaded, which is the state most readers see first.
//
// The circle itself is a fixed-width table cell with a 32px radius, not a flex
// box: `borderRadius` on a <td> is honoured by every client that matters, and
// the ones that ignore it degrade to an orange square — still deliberate.
function IconCircle() {
  return (
    <Row>
      <Column align="center">
        <table role="presentation" border={0} cellPadding={0} cellSpacing={0} align="center">
          <tbody>
            <tr>
              <td
                align="center"
                style={{
                  width: "64px",
                  height: "64px",
                  backgroundColor: theme.brandOrangeLight,
                  borderRadius: "32px",
                  textAlign: "center",
                  verticalAlign: "middle",
                }}
              >
                <Text
                  style={{
                    margin: "0",
                    fontFamily: theme.fontHeading,
                    fontSize: "28px",
                    lineHeight: "1",
                    fontWeight: 700,
                    color: theme.brandOrange,
                  }}
                >
                  ✓
                </Text>
              </td>
            </tr>
          </tbody>
        </table>
      </Column>
    </Row>
  );
}

// Default export, because react-email's `email dev` previews the default
// export of each file under `emails/`. The catalog imports the same symbol, so
// preview and production render the identical component.
//
// Ported from the "User Created Email" frame of `assets/email/emails.pen`. The
// `.pen` stacks the card's children with `layout: vertical` + `gap: 24` and
// centres them with `alignItems: center`; email clients support neither flexbox
// nor `gap`, so the INTENT is translated — vertical rhythm becomes explicit
// margins on each block, and centring becomes `textAlign`/`align` on the
// elements that need it. Never copy the `.pen`'s `justifyContent`/`gap` through.
//
// `userId` and `createdAt` are rendered DEFENSIVELY. `renderTemplate` erases the
// catalog's prop type to `unknown` (see `src/email/renderer.ts`), so a caller
// that omits one is a runtime possibility TypeScript cannot rule out here —
// and the existing snapshot test renders this template with only `fullName` and
// `email`. A missing value drops its row rather than printing "undefined" into
// a welcome email.
export default function UserCreatedEmail({ fullName, email, userId, createdAt }: UserCreatedEmailProps) {
  const memberSince = formatMemberSince(createdAt);

  return (
    <EmailLayout>
      <IconCircle />

      <Heading
        as="h1"
        style={{
          margin: "24px 0 0",
          fontFamily: theme.fontHeading,
          fontSize: "24px",
          fontWeight: 700,
          lineHeight: "1.3",
          color: theme.textPrimary,
          textAlign: "center",
        }}
      >
        Welcome to 3MRAI!
      </Heading>

      {/* "Greeting Block": greeting + welcome paragraph, 12px apart. */}
      <Text
        style={{
          margin: "24px 0 0",
          fontFamily: theme.fontBody,
          fontSize: "15px",
          fontWeight: 400,
          color: theme.textPrimary,
        }}
      >
        Hi {fullName},
      </Text>
      <Text
        style={{
          margin: "12px 0 0",
          fontFamily: theme.fontBody,
          fontSize: "14px",
          fontWeight: 400,
          lineHeight: "1.5",
          color: theme.textSecondary,
        }}
      >
        Your account has been successfully created. You&apos;re all set to explore the 3MRAI
        platform and start managing your orders, tracking, and more.
      </Text>

      {/* "Account Details" panel. */}
      <Section
        style={{
          margin: "24px 0 0",
          backgroundColor: DETAILS_PANEL_BG,
          borderRadius: "8px",
          padding: "20px 24px",
        }}
      >
        <Text
          style={{
            margin: "0 0 12px",
            fontFamily: theme.fontBody,
            fontSize: "13px",
            fontWeight: 600,
            letterSpacing: "1.5px",
            color: theme.textMuted,
          }}
        >
          YOUR ACCOUNT
        </Text>

        <DetailRow label="Email" value={email} />
        {memberSince ? <DetailRow label="Member Since" value={memberSince} /> : null}
        {userId ? <DetailRow label="Account ID" value={userId} /> : null}
      </Section>

      {/* "CTA Wrapper": the `.pen` centres the button with `justifyContent:
          center`; a centred table cell is the email-safe equivalent. No web app
          exists yet, so the href is a placeholder under app.3mrai.com. */}
      <Section style={{ margin: "24px 0 0" }}>
        <Row>
          <Column align="center">
            <Button href="https://app.3mrai.com/profile">View My Profile</Button>
          </Column>
        </Row>
      </Section>

      <Text
        style={{
          margin: "24px 0 0",
          fontFamily: theme.fontBody,
          fontSize: "12px",
          fontWeight: 400,
          color: theme.textMuted,
          textAlign: "center",
        }}
      >
        Need help getting started? Visit our help center or reply to this email.
      </Text>
    </EmailLayout>
  );
}
