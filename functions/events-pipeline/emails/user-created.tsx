import { Heading, Section, Row, Column, Text, Img } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { greeting } from "./components/greeting.ts";
import { Button } from "./components/button.tsx";
import { DetailRow } from "./components/detail-row.tsx";
import { emailAssets } from "./assets.ts";

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
//
// It is NOT promoted into the Tailwind config either, even though the same tint
// appears in three templates (here, the OTP digit boxes, the order items panel
// and the tracking timeline). Each is a local panel fill the `.pen` treats as an
// unnamed one-off; naming it in the shared config would invent a brand token the
// design does not have, and the next `.pen` change would have to decide whether
// all four move together. It stays an arbitrary value at its call site, where
// the hex is visible.
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

// The `.pen`'s "Icon Circle" — the brand-orange disc AND the lucide `user-check`
// inside it — is ONE remote PNG from the assets bucket (`emails/assets.ts`),
// rendered at its full 64px.
//
// Two of the three ways to ship an icon are still dead ends: an icon font needs
// @font-face (a <style> block, which Gmail and Outlook strip), and inline SVG has
// 40.48% support and renders in NO version of Outlook on Windows
// (caniemail.com/features/html-svg). The third — a remote <img> — is the one that
// works: 100% client support, and Gmail has displayed remote images by default
// since 2013. This REPLACES the base64 `data:` URI this file used to embed, whose
// 80.95% support left ~19% of readers with nothing and no way to fix it. Full
// argument in `emails/assets.ts`.
//
// THERE IS NO CSS CIRCLE HERE ANY MORE, AND ADDING ONE BACK IS A BUG.
// `user-check.png` already contains the rgb(255,244,229) disc — the exact tint
// the removed `bg-brand-orange-light` class emitted. Drawing both nested two
// discs: the PNG's own disc was invisible against the identical CSS one, so all
// the reader saw was the glyph inside it, shrunk to whatever display size the
// image was given (14px in a 64px disc — 22%, measured on a screenshot). Showing
// the image at the full 64px is what puts the glyph back at the 41% the artwork
// was drawn at.
//
// It also closes the Outlook Windows gap for this element for free: that client
// supports no `border-radius` at all and rendered the CSS disc as a SQUARE. A
// PNG of a circle is a circle everywhere — the same reason the timeline dots
// became images (see [[email-templates]] § Authoring rules).
//
// WITH IMAGES BLOCKED the reader now loses the marker entirely rather than
// keeping a tinted disc. The layout does not move: `width`/`height` are HTML
// ATTRIBUTES (spread from the asset entry, never CSS-only — Outlook sizes images
// from the attributes), so the 64x64 box is reserved and "Welcome to 3MRAI!"
// stays exactly where it is. The `alt` carries the meaning and the heading
// directly below states it in text.
//
// The `Row`/`Column` wrapper stays because it is what CENTRES the image;
// `width="auto"` on the inner `Row` keeps that table shrink-to-fit rather than
// `Row`'s default full width, and `align="center"` is already its default.
function IconCircle() {
  return (
    <Row>
      <Column align="center">
        <Row width="auto">
          <Column align="center" className="text-center">
            <Img
              {...emailAssets.userCheck}
              alt="Account created"
              className="inline-block align-middle"
            />
          </Column>
        </Row>
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
        className="mt-[24px] mb-0 mx-0 font-heading text-[24px] font-bold leading-[1.3] text-text-primary text-center"
      >
        Welcome to 3MRAI!
      </Heading>

      {/* "Greeting Block": greeting + welcome paragraph, 12px apart. */}
      <Text className="mt-[24px] mb-0 mx-0 font-body text-[15px] font-normal text-text-primary">
        {greeting(fullName)}
      </Text>
      <Text className="mt-[12px] mb-0 mx-0 font-body text-[14px] font-normal leading-[1.5] text-text-secondary">
        Your account has been successfully created. You&apos;re all set to explore the 3MRAI
        platform and start managing your orders, tracking, and more.
      </Text>

      {/* "Account Details" panel. The one-off tint is an arbitrary class rather
          than a config token — see DETAILS_PANEL_BG. */}
      <Section
        className={`mt-[24px] mb-0 mx-0 bg-[${DETAILS_PANEL_BG}] rounded-[8px] px-[24px] py-[20px]`}
      >
        <Text className="mt-0 mb-[12px] mx-0 font-body text-[13px] font-semibold tracking-[1.5px] text-text-muted">
          YOUR ACCOUNT
        </Text>

        <DetailRow label="Email" value={email} />
        {memberSince ? <DetailRow label="Member Since" value={memberSince} /> : null}
        {userId ? <DetailRow label="Account ID" value={userId} /> : null}
      </Section>

      {/* "CTA Wrapper": the `.pen` centres the button with `justifyContent:
          center`; a centred table cell is the email-safe equivalent. No web app
          exists yet, so the href is a placeholder under app.3mrai.com. */}
      <Section className="mt-[24px] mb-0 mx-0">
        <Row>
          <Column align="center">
            <Button href="https://app.3mrai.com/profile">View My Profile</Button>
          </Column>
        </Row>
      </Section>

      <Text className="mt-[24px] mb-0 mx-0 font-body text-[12px] font-normal text-text-muted text-center">
        Need help getting started? Visit our help center or reply to this email.
      </Text>
    </EmailLayout>
  );
}
