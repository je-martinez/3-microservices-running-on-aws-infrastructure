import { Heading, Section, Row, Column, Text, Img } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { greeting } from "./components/greeting.ts";
import { Button } from "./components/button.tsx";
import { DetailRow } from "./components/detail-row.tsx";
import { emailAssets } from "./assets.ts";

// `createdAt` is the producer's ISO-8601 STRING, not a Date — it crossed a JSON
// boundary, and typing it as a Date is a lie the renderer trips over.
export interface UserCreatedEmailProps {
  fullName: string;
  email: string;
  userId: string;
  createdAt: string;
}

// A one-off panel fill in the `.pen`, so it is neither in `theme.ts` nor the
// Tailwind config. The same tint appears in other templates, but each is a local
// one-off the design does not name — a shared token would invent a brand value
// and force the next `.pen` change to decide whether all of them move together.
const DETAILS_PANEL_BG = "#F9FAFB";

// CONTRACT: Pin the formatting to `en-US` and UTC. Letting the host zone decide
// renders the same event as two different dates depending on where it was
// processed, and makes the snapshot machine-dependent. Return null, never a
// placeholder — a malformed timestamp must never reach the reader as
// "Invalid Date"; the row is dropped instead.
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

// CONTRACT: The disc AND the glyph are ONE remote PNG. Do NOT add a CSS circle
// back: the PNG already contains the tint, so both nested makes the artwork's
// own disc invisible and shrinks the glyph to a fraction of the box. It also
// keeps Outlook on Windows correct, which supports no `border-radius` and draws
// a CSS disc as a SQUARE. An icon font needs @font-face and inline SVG renders
// in no Outlook on Windows, so a remote <img> is the only option that works.
// See [[email-templates]]

// CONTRACT: `width`/`height` are HTML ATTRIBUTES, never CSS-only — Outlook sizes
// images from the attributes, and they reserve the box so the heading does not
// move when images are blocked. The `alt` carries the meaning. The `Row`/
// `Column` wrapper is what CENTRES the image; `width="auto"` keeps the inner
// table shrink-to-fit rather than full width.
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

// Default export, because `email dev` previews the default export of each file
// under `emails/` — preview and production then render the identical component.
// CONTRACT: Never copy the `.pen`'s `justifyContent`/`gap` through; email
// clients support neither flexbox nor `gap`, so rhythm becomes explicit margins
// and centring becomes `textAlign`/`align`. Render `userId` and `createdAt`
// DEFENSIVELY: `renderTemplate` erases the prop type to `unknown`, so a missing
// value is a runtime possibility and must drop its row rather than print
// "undefined" into a welcome email.
// See [[email-templates]]
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
