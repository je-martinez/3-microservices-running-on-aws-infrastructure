import { Section, Row, Column, Heading, Text, Hr, Img } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { greeting } from "./components/greeting.ts";
import { theme } from "./theme.ts";
import { emailAssets } from "./assets.ts";

export interface AuthOtpEmailProps {
  code: string;
  // Comes from the payload (`ttlSeconds / 60`), NEVER hardcoded. The `.pen`
  // mockup says "10 minutes"; the real backend TTL is 5
  // (`OTP_CODE_TTL_SECONDS=300`). The mockup is the wrong one — render the prop.
  ttlMinutes: number;
  // MAY BE THE EMPTY STRING, and that is the normal path today: Cognito has no
  // `name` attribute populated (Users' AdminCreateUser writes only `email`,
  // `email_verified` and `custom:app_user_id`), so the producer falls back to
  // "". Required rather than optional precisely so the template cannot forget
  // the case — it must degrade to a nameless greeting, never print an empty gap.
  fullName: string;
}

// Ported from the "OTP Login Email" frame of `assets/email/emails.pen`.
//
// This is a SIGN-IN code, not account verification. Cognito's CUSTOM_AUTH flow
// issues tokens the moment this code is verified, so the copy says "sign in"
// throughout. Never reword it to "verify your account" — that would describe a
// flow this service does not have.
//
// Icon treatment: the `.pen`'s two lucide glyphs (`log-in` inside the 64px
// info-blue circle, `triangle-alert` in the security notice) are served as
// REMOTE PNGs from the assets bucket (`emails/assets.ts`).
//
// Two alternatives still do not survive email: an icon font or an SVG sprite
// needs @font-face / an external reference, and inline SVG has 40.48% support and
// renders in NO version of Outlook on Windows (caniemail.com/features/html-svg).
// The third — a remote <img> — is the one that works: 100% client support, and
// Gmail has displayed remote images by default since 2013. This REPLACES the
// base64 `data:` URIs this file used to embed, whose 80.95% support left ~19% of
// readers with no icon. Full argument in `emails/assets.ts`.
//
// BOTH PNGs CARRY THEIR OWN DISC, so neither is scaled down inside a CSS shape
// any more — that arrangement nested two discs and shrank the visible glyph to a
// speck (the defect this replaced; measurements in `emails/assets.ts`). The CSS
// circle above the heading and the CSS badge in the security notice are both
// removed, and each image is shown at the full size of the shape it replaces.
//
// They do not look alike afterwards, and that follows from the artwork: the
// header PNG's rgb(239,246,255) disc contrasts with the white card, so it still
// reads as a circle, while the notice PNG's disc is the notice panel's own fill,
// so that one reads as a bare triangle in the gutter. See the notice itself for
// why its amber ring could not be kept.
//
// A reader with images off now loses both markers rather than keeping tinted
// shapes. Every <Img> keeps a meaningful `alt`, its `width`/`height` attributes
// hold the layout open, and neither icon was ever load-bearing: the heading
// names the email and the security notice states its warning in full in its own
// heading and body.
//
// Default export, because react-email's `email dev` previews the default export
// of each file under `emails/`. The catalog imports the same symbol, so preview
// and production render the identical component.

// The `.pen` "Digit N" frames: 48x56 boxes, 8px radius, #F9FAFB fill, 1px
// border, 28px/700 navy digit. A one-off tint in the design, not a named
// variable, so it is not in `theme.ts`.
const DIGIT_BG = "#F9FAFB";

// "Security Notice" panel fill — likewise a one-off in the `.pen` (amber warning
// block), deliberately not promoted into `theme.ts`.
//
// The frame's amber ACCENT (#F59E0B) is no longer a constant here. It drew the
// 1px ring around the notice badge, and that badge is now the `triangle-alert`
// PNG itself — the ring could not survive an image that fills the cell exactly
// (it painted as four detached segments; see the security notice below). The
// accent colour still ships: it is rasterised into the image.
const NOTICE_BG = "#FFF8E1";

export default function AuthOtpEmail({ code, ttlMinutes, fullName }: AuthOtpEmailProps) {
  // Split for the six-box display ONLY. The code is a STRING and is never
  // parsed as a number anywhere here: it is zero-padded to six digits
  // (e.g. "042817") and `Number("042817")` would render "42817" — a code that
  // does not exist. Codes of unexpected length still render, one box per
  // character, instead of being truncated or padded.
  const digits = code.split("");

  return (
    <EmailLayout>
      {/* Icon Circle — the info-tinted disc and the `log-in` glyph inside it are
          ONE remote PNG, shown at its full 64px. See the note above.

          NO CSS DISC BEHIND IT, DELIBERATELY. `log-in.png` already carries the
          rgb(239,246,255) disc that `bg-info-bg` used to draw; stacking both
          nested two identical circles and left only the glyph visible, shrunk to
          the image's display size (14px in a 64px disc — 22%, measured on a
          rendered screenshot). Full size restores the ~38% the artwork was drawn
          at. Measurements in `emails/assets.ts`.

          `width`/`height` stay HTML attributes because Outlook sizes images from
          those and ignores CSS dimensions — and because they reserve the 64x64
          box when a client blocks the image, so "Your Login Code" below keeps
          its position instead of jumping up. The `alt` carries the meaning.

          The `Row`/`Column` wrapper is what CENTRES the image; the inner `Row`
          is `width="auto"` because `Row` defaults to `width="100%"` and would
          stretch this shrink-to-fit wrapper. */}
      <Row>
        <Column align="center">
          <Row width="auto">
            <Column align="center" className="text-center">
              <Img
                {...emailAssets.logIn}
                alt="Sign in"
                className="inline-block align-middle"
              />
            </Column>
          </Row>
        </Column>
      </Row>

      <Heading
        as="h1"
        className="mt-[24px] mb-0 mx-0 font-heading text-[24px] font-bold text-text-primary text-center"
      >
        Your Login Code
      </Heading>

      {/* Greeting Block */}
      <Text className="mt-[24px] mb-0 mx-0 font-body text-[15px] font-normal text-text-primary">
        {greeting(fullName)}
      </Text>

      {/*
        LOAD-BEARING, NOT REDUNDANT — DO NOT "CLEAN THIS UP".

        The gateway E2E spec scrapes the OTP out of the delivered message body,
        so the full code must appear ONCE as plain, contiguous text in the HTML.
        The six boxed digits below satisfy the mockup for humans, but they split
        the code across six table cells with markup in between, which no simple
        extraction can reassemble. This sentence is the machine-readable copy.
        Deleting it (or moving the code out of it) silently breaks the E2E suite
        — the emails still look right, the tests stop being able to sign in.

        It also earns its place for humans: it is what a screen reader and a
        plaintext/preview snippet read out, and it keeps the code near the top
        of the body, which is the region mail clients (and Mailpit) expose as
        the snippet used for that extraction.
      */}
      <Text className="mt-[12px] mb-0 mx-0 font-body text-[14px] font-normal leading-[1.5] text-text-secondary">
        Use this code to sign in to your 3MRAI account: {code}. Enter it on the login screen to
        continue:
      </Text>

      {/* OTP Section — "Code Row" in the `.pen`.
          The design expresses the row as flex with a 10px gap; email clients do
          not reliably support flexbox, so it becomes a table Row of six
          Columns, with the gap carried by per-cell horizontal padding. */}
      <Section className="mt-[24px] mb-0 mx-0">
        <Row>
          {digits.map((digit, index) => (
            // Positional key on purpose: the characters of an OTP repeat
            // routinely (e.g. "111111"), so the digit itself is not a unique
            // key. The list is static within a render and never reordered, so
            // the index is stable here.
            <Column key={index} align="center" className="px-[5px] py-0">
              <Text
                className={`mx-auto my-0 w-[48px] h-[56px] leading-[56px] bg-[${DIGIT_BG}] border border-solid border-line rounded-[8px] font-heading text-[28px] font-bold text-brand-navy text-center`}
              >
                {digit}
              </Text>
            </Column>
          ))}
        </Row>

        <Text className="mt-[16px] mb-0 mx-0 font-body text-[12px] font-normal text-text-muted text-center">
          This code expires in {ttlMinutes} minutes
        </Text>
      </Section>

      {/* STOP POINT — `Hr`'s border stays inline: its own default style is
          emitted after Tailwind's compiled classes and would override a
          `border-line` class. See the same note in `components/layout.tsx`. */}
      <Hr className="my-[24px] mx-0" style={{ borderColor: theme.borderColor, borderTopWidth: "1px" }} />

      {/* Security Notice — the `.pen` lays the warning glyph beside the text
          with flex; two Columns render the same intent as a table. The glyph is
          the real lucide `triangle-alert`, served as a remote PNG.

          THE IMAGE NOW FILLS THE BADGE INSTEAD OF FLOATING INSIDE IT. Measured
          on the file: `triangle-alert.png` is a 40x40 rgb(255,248,225) disc with
          the amber glyph filling 48% of it. It was being shown at 13px inside a
          20px CSS badge, which left the visible triangle at ~6px — a speck, and
          the ring was the only part of the marker a reader actually registered.
          It is shown at the badge's full 20px now, so the triangle reads at ~50%
          of the badge.

          THE CSS BADGE AROUND IT IS GONE — both its white fill and its 1px
          amber ring — and both were verified as unrecoverable rather than
          dropped for tidiness:

          - The WHITE FILL cannot show. The PNG is opaque across its whole disc
            (1516 of its 1600 pixels are alpha 255; only the corners are
            transparent), so a `background-color` behind it is simply covered.
          - The AMBER RING was tried and REVERTED after looking at the render.
            At the size the fix requires, the image fills the cell exactly, so
            the ring had no gap to curve through: it painted as FOUR DETACHED
            STRAIGHT SEGMENTS around the triangle — visibly broken, and worse
            than either alternative. Reinstating it would need the image inset
            inside a LARGER badge, which reintroduces the very nesting that made
            the glyph a speck.

          So the marker is a pale-amber triangle sitting directly on the notice
          panel. It has no disc edge of its own, since the PNG's disc is the
          panel's own rgb(255,248,225) — that is the difference from the four
          header icons, whose discs contrast against the white card and so still
          read as circles.

          WITH IMAGES BLOCKED the gutter is empty rather than showing a ringed
          disc. The notice never depended on the icon: its heading ("Wasn't
          you?") and body state the warning in full, and `Column width="32"`
          still reserves the gutter so the text does not reflow into it. */}
      <Section className={`bg-[${NOTICE_BG}] rounded-[8px] px-[16px] py-[14px]`}>
        <Row>
          {/* `align="left"` is passed EXPLICITLY — `Row` defaults to
              `align="center"`, and the badge sits in the notice's left gutter,
              not centred in it. `width="auto"` keeps the wrapper table
              shrink-to-fit instead of `Row`'s default full width. */}
          <Column width="32" valign="top">
            <Row width="auto" align="left">
              <Column align="center" className="text-center">
                <Img
                  {...emailAssets.triangleAlert}
                  alt="Security notice"
                  className="inline-block align-middle"
                />
              </Column>
            </Row>
          </Column>
          <Column valign="top">
            <Text className="m-0 font-body text-[13px] font-semibold text-text-primary">
              Wasn&apos;t you?
            </Text>
            <Text className="mt-[4px] mb-0 mx-0 font-body text-[12px] font-normal leading-[1.5] text-text-secondary">
              If you didn&apos;t try to sign in, you can safely ignore this email. No one can access
              your account without this code.
            </Text>
          </Column>
        </Row>
      </Section>

      <Text className="mt-[24px] mb-0 mx-0 font-body text-[12px] font-normal text-text-muted text-center">
        If you need assistance, contact us at support@3mrai.com
      </Text>
    </EmailLayout>
  );
}
