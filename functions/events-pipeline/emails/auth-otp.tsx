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
// Both COLOURED SHAPES STAY, because a reader may still have images off: the
// info-tinted round cell above the heading and the amber badge beside the
// warning both draw with zero assets loaded, and each <Img> carries a meaningful
// `alt`. The security notice in particular must never depend on its icon — its
// heading and body text state the warning in full.
//
// Default export, because react-email's `email dev` previews the default export
// of each file under `emails/`. The catalog imports the same symbol, so preview
// and production render the identical component.

// The `.pen` "Digit N" frames: 48x56 boxes, 8px radius, #F9FAFB fill, 1px
// border, 28px/700 navy digit. A one-off tint in the design, not a named
// variable, so it is not in `theme.ts`.
const DIGIT_BG = "#F9FAFB";

// "Security Notice" frame tints — likewise one-offs in the `.pen` (amber warning
// block), deliberately not promoted into `theme.ts`.
const NOTICE_BG = "#FFF8E1";
const NOTICE_ACCENT = "#F59E0B";

export default function AuthOtpEmail({ code, ttlMinutes, fullName }: AuthOtpEmailProps) {
  // Split for the six-box display ONLY. The code is a STRING and is never
  // parsed as a number anywhere here: it is zero-padded to six digits
  // (e.g. "042817") and `Number("042817")` would render "42817" — a code that
  // does not exist. Codes of unexpected length still render, one box per
  // character, instead of being truncated or padded.
  const digits = code.split("");

  return (
    <EmailLayout>
      {/* Icon Circle — the real `log-in` icon as a base64 PNG inside the
          unchanged info-tinted disc. See the note above.
          A table cell with `align`/`align-middle` rather than the old `<Text>`
          with a 64px line-height: line-height centres a text glyph, but an <Img>
          is a replaced element Outlook positions from the cell's attributes.
          `width`/`height` are HTML attributes because Outlook sizes images from
          those and ignores CSS dimensions — the 56px raster would otherwise
          display full-size and burst the circle.

          The cell is a `Column` (which IS a <td>), so the disc styling lands on
          the cell itself — `Section` puts its props on its <table> and leaves
          the inner <td> bare, so it cannot express this. The inner `Row` is
          `width="auto"`: `Row` defaults to `width="100%"`, which would stretch
          the shrink-to-fit wrapper the 64px cell needs. `align="center"` is
          already `Row`'s default and is what centres the disc. */}
      <Row>
        <Column align="center">
          <Row width="auto">
            <Column
              align="center"
              className="w-[64px] h-[64px] rounded-[32px] bg-info-bg text-center align-middle"
            >
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
          now the real lucide `triangle-alert` as a base64 PNG.
          NOTE THE COLOUR INVERSION vs the header icon. `triangle-alert` is
          rasterised IN the warning amber (the uploaded
          `assets/email/triangle-alert.png` is amber, not white), so the
          circle behind it CANNOT stay amber-FILLED the way it was under the
          white "!" — amber on amber is invisible. The circle is kept and
          inverted instead: a pale disc with a 1px amber ring, which is still a
          deliberate 20px marker in the gutter for the ~20% of readers whose
          client shows no image. The notice's heading and body state the warning
          in full either way; the icon is never the thing carrying it. */}
      <Section className={`bg-[${NOTICE_BG}] rounded-[8px] px-[16px] py-[14px]`}>
        <Row>
          {/* The badge is the same shape as the header disc, so it is built the
              same way: a `Column` (a <td>) carries the ring, wrapped in a
              `width="auto"` `Row` so the table shrinks to the 20px cell instead
              of `Row`'s default full width. `align="left"` is passed EXPLICITLY
              here — `Row` defaults to `align="center"`, and the badge sits in
              the notice's left gutter, not centred in it. */}
          <Column width="32" valign="top">
            <Row width="auto" align="left">
              <Column
                align="center"
                className={`w-[20px] h-[20px] rounded-[10px] bg-bg-white border border-solid border-[${NOTICE_ACCENT}] text-center align-middle`}
              >
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
