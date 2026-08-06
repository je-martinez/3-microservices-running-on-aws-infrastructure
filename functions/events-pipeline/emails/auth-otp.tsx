import { Section, Row, Column, Heading, Text, Hr } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { theme } from "./theme.ts";

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
// Icon treatment: the `.pen` puts a lucide `log-in` glyph inside a 64px
// info-blue circle. Neither an icon font nor an SVG sprite survives email
// clients, inline SVG has poor support (Gmail strips it), and a remote <img> is
// blocked by default in most clients — any of those leaves a broken box.
// So the circle is rendered as a bordered, info-tinted round table cell
// containing a TEXT glyph ("→", the log-in arrow), which needs no images and
// looks deliberate with images disabled.
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
  // `fullName` is routinely "" (see the prop comment). Greeting with a trailing
  // name would print "Hi ," with a dangling comma and a gap, so the nameless
  // case gets its own complete string rather than an interpolated empty value.
  const greeting = fullName.trim().length > 0 ? `Hi ${fullName.trim()},` : "Hi,";

  // Split for the six-box display ONLY. The code is a STRING and is never
  // parsed as a number anywhere here: it is zero-padded to six digits
  // (e.g. "042817") and `Number("042817")` would render "42817" — a code that
  // does not exist. Codes of unexpected length still render, one box per
  // character, instead of being truncated or padded.
  const digits = code.split("");

  return (
    <EmailLayout>
      {/* Icon Circle — a text glyph, not an image. See the note above. */}
      <Row>
        <Column align="center">
          <Text className="mx-auto my-0 w-[64px] h-[64px] leading-[64px] rounded-[32px] bg-info-bg text-info font-heading text-[28px] font-bold text-center">
            &#8594;
          </Text>
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
        {greeting}
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
          again a text character ("!") in a tinted circle, for the same
          no-images reason as the header icon. */}
      <Section className={`bg-[${NOTICE_BG}] rounded-[8px] px-[16px] py-[14px]`}>
        <Row>
          <Column width="32" valign="top">
            <Text
              className={`m-0 w-[20px] h-[20px] leading-[20px] rounded-[10px] bg-[${NOTICE_ACCENT}] text-bg-white font-heading text-[13px] font-bold text-center`}
            >
              !
            </Text>
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
