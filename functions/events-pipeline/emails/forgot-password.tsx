import { Section, Row, Column, Heading, Text, Hr, Img } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { greeting } from "./components/greeting.ts";
import { theme } from "./theme.ts";
import { emailAssets } from "./assets.ts";

export interface ForgotPasswordEmailProps {
  // The six-digit reset code Cognito's ForgotPassword API issues. A STRING, and
  // never parsed as a number — see the split in the component body.
  code: string;
  // Comes from the payload (`ttlSeconds / 60`), NEVER hardcoded. The `.pen`
  // mockup says "30 minutes"; whatever the producer actually sends is what the
  // recipient must read, so render the prop.
  ttlMinutes: number;
  // MAY BE THE EMPTY STRING, and that is the normal path today, exactly as in
  // auth-otp: Cognito has no `name` attribute populated (Users' AdminCreateUser
  // writes only `email`, `email_verified` and `custom:app_user_id`), so the
  // producer falls back to "". Required rather than optional precisely so the
  // template cannot forget the case — it must degrade to a nameless greeting
  // via `greeting()`, never print an empty gap.
  fullName: string;
}

// Ported from the "Forgot Password Email" frame of `assets/email/emails.pen`,
// with ONE DELIBERATE DEPARTURE FROM THE DESIGN — read this before "restoring"
// the mockup's layout.
//
// THE FRAME SHOWS A BUTTON AND A LINK; THIS SENDS A CODE. The `.pen` draws a
// "Reset Password" CTA (`$brand-orange`, `lock` glyph) plus a copy-and-paste
// fallback URL pointing at `https://app.3mrai.com/reset-password?token=…`.
// Neither can be honoured:
//
//   - Cognito's ForgotPassword API emits a SIX-DIGIT CODE, not a tokenised
//     link. The token in the mockup's URL does not exist, and nothing in this
//     system can mint one that ConfirmForgotPassword would accept.
//   - There is no frontend at app.3mrai.com to land on. A button linking there
//     would be a dead link in every delivered message.
//
// So the CTA block and the link fallback are REPLACED by the same six boxed
// digits `auth-otp.tsx` renders, and the copy describes a code rather than a
// button or a link.
//
// THE DESIGN HAS SINCE CAUGHT UP WITH THE CODE: the `.pen` frame was revised to
// drop the button, the link fallback and the `timer` expiry panel, and to place
// the six digits and a single muted expiry line where they are here. This file
// now matches the frame rather than departing from it — the one exception is the
// intro sentence, which additionally carries the code inline for the E2E scrape
// (see the comment on it below).
//
// Copy that promises a button or a link must not survive anywhere in this file.
// A recipient told to "click the button below" who finds only digits will
// conclude the email is broken. The frame's `lock` and `timer` glyphs went with
// the blocks they belonged to and are deliberately NOT registered in
// `emails/assets.ts` — an asset entry nothing renders is an invitation to
// reintroduce the block.
//
// Icon treatment follows the other templates: both remaining lucide glyphs
// (`key-round` in the 64px header disc, `triangle-alert` in the security notice)
// are REMOTE PNGs from the assets bucket (`emails/assets.ts`). An icon font
// needs @font-face and inline SVG has 40.48% support with NO support in any
// Outlook on Windows; a remote <img> is the only one at 100%. Full argument in
// `emails/assets.ts`.
//
// THE HEADER PNG CARRIES ITS OWN DISC, so it is shown at the full 64px with no
// CSS circle behind it — nesting the two shrinks the visible glyph to a speck
// (measurements in `emails/assets.ts`).
//
// Default export, because react-email's `email dev` previews the default export
// of each file under `emails/`. The catalog imports the same symbol, so preview
// and production render the identical component.

// The digit boxes, matching `auth-otp.tsx` exactly: the two code displays are
// the same component in the reader's eyes and must not drift apart. A one-off
// tint in the `.pen`, not a named variable, so it is not in `theme.ts`.
const DIGIT_BG = "#F9FAFB";

// "Security Notice" panel fill — a one-off in the `.pen` (amber warning block),
// deliberately not promoted into `theme.ts`. Same value as auth-otp's notice.
//
// The frame's amber ACCENT (#F59E0B) is not a constant here: it drew a ring
// around the notice glyph, and that ring cannot survive an image that fills its
// cell exactly (it paints as four detached segments — see the note in
// `emails/auth-otp.tsx`). The accent still ships, rasterised into the PNG.
const NOTICE_BG = "#FFF8E1";

export default function ForgotPasswordEmail({
  code,
  ttlMinutes,
  fullName,
}: ForgotPasswordEmailProps) {
  // Split for the six-box display ONLY. The code is a STRING and is never
  // parsed as a number anywhere here: it is zero-padded to six digits
  // (e.g. "042817") and `Number("042817")` would render "42817" — a code that
  // does not exist. Codes of unexpected length still render, one box per
  // character, instead of being truncated or padded.
  const digits = code.split("");

  return (
    <EmailLayout>
      {/* Icon Circle — the #FEE2E2 disc and the `key-round` glyph inside it are
          ONE remote PNG, shown at its full 64px.

          NO CSS DISC BEHIND IT, DELIBERATELY. `key-round.png` already carries
          the disc the `.pen` frame draws; stacking a CSS circle on top would
          nest two identical shapes and leave only the key visible, shrunk to the
          image's display size — the defect documented in `emails/assets.ts`.

          `width`/`height` stay HTML attributes because Outlook sizes images from
          those and ignores CSS dimensions — and because they reserve the 64x64
          box when a client blocks the image, so "Reset Your Password" below
          keeps its position instead of jumping up. The `alt` carries the
          meaning.

          The `Row`/`Column` wrapper is what CENTRES the image; the inner `Row`
          is `width="auto"` because `Row` defaults to `width="100%"` and would
          stretch this shrink-to-fit wrapper. */}
      <Row>
        <Column align="center">
          <Row width="auto">
            <Column align="center" className="text-center">
              <Img
                {...emailAssets.keyRound}
                alt="Password reset"
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
        Reset Your Password
      </Heading>

      {/* Greeting Block */}
      <Text className="mt-[24px] mb-0 mx-0 font-body text-[15px] font-normal text-text-primary">
        {greeting(fullName)}
      </Text>

      {/*
        LOAD-BEARING, NOT REDUNDANT — DO NOT "CLEAN THIS UP".

        This is the same rule `emails/auth-otp.tsx` documents, and it applies
        here for the same reason: an E2E that drives the password-reset flow can
        only complete it by scraping the code out of the delivered message body,
        so the full code must appear ONCE as plain, contiguous text in the HTML.
        The six boxed digits below satisfy the design for humans, but they split
        the code across six table cells with markup in between, which no simple
        extraction can reassemble. This sentence is the machine-readable copy.
        Deleting it (or moving the code out of it) silently breaks that suite —
        the emails still look right, the tests stop being able to reset.

        It also earns its place for humans: it is what a screen reader and a
        plaintext/preview snippet read out, and it keeps the code near the top of
        the body, which is the region mail clients (and Mailpit) expose as the
        snippet used for that extraction.

        THE SENTENCE CARRIES THE CODE, and that is the one departure from the
        `.pen`'s intro copy, which names no code inline. The frame is a visual
        mockup and shows the code only as the six boxed digits; those cannot be
        scraped (see above), so the machine-readable copy has to live somewhere.
        Everything else in this sentence is the frame's wording verbatim.
      */}
      <Text className="mt-[12px] mb-0 mx-0 font-body text-[14px] font-normal leading-[1.5] text-text-secondary">
        {/* `{code}.` STAYS ON ONE LINE — the period must sit flush against the
            code in the delivered HTML ("…720486<!-- -->. Enter it…"). Splitting
            them across lines lets JSX collapse the newline into a real space,
            leaving "720486 ." in the message body.

            Note when verifying this by hand: React emits `<!-- -->` markers
            between adjacent text and expression children, so a naive
            tag-stripping regex turns them into spaces and makes a CORRECT render
            look like "720486 . Enter". Check the raw HTML, not the stripped
            text. `auth-otp.tsx` renders identically. */}
        We received a request to reset the password for your 3MRAI account. Use the code below to
        verify it&apos;s you and set a new password: {code}.
      </Text>

      {/* Code Section — the same six-box display as `auth-otp.tsx`, standing in
          for the frame's CTA button and link fallback.
          The design expresses digit rows as flex with a gap; email clients do
          not reliably support flexbox, so it becomes a table Row of six
          Columns, with the gap carried by per-cell horizontal padding. */}
      <Section className="mt-[24px] mb-0 mx-0">
        <Row>
          {digits.map((digit, index) => (
            // Positional key on purpose: the characters of a reset code repeat
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

        {/* Expiry line — INSIDE the code section, directly under the digits,
            exactly as the `.pen` places it. It was previously a separate
            `timer`-glyph panel below the divider; the design dropped that panel
            in favour of this single muted line, so the glyph went with it (and
            `timer` is no longer registered in `emails/assets.ts` — nothing else
            renders it).

            THE TTL IS THE PROP, NEVER THE LITERAL. The frame reads "10 minutes"
            and the sample props match it, but a real envelope carries its own
            `ttlSeconds`; rendering the mockup's number would tell users the
            wrong deadline the moment the producer picks a different TTL. */}
        <Text className="mt-[16px] mb-0 mx-0 font-body text-[12px] font-normal text-text-muted text-center">
          This code expires in {ttlMinutes} minutes
        </Text>
      </Section>

      {/* STOP POINT — `Hr`'s border stays inline: its own default style is
          emitted after Tailwind's compiled classes and would override a
          `border-line` class. See the same note in `components/layout.tsx`. */}
      <Hr className="my-[24px] mx-0" style={{ borderColor: theme.borderColor, borderTopWidth: "1px" }} />

      {/* Security Notice — identical construction to `auth-otp.tsx`'s, down to
          the panel fill and the glyph, because it is the same warning in the
          same position. See that file for why the CSS badge around the image
          (white fill + 1px amber ring) is gone and could not be recovered: the
          PNG is opaque across its disc, and at the size that keeps the triangle
          legible the ring paints as four detached segments.

          The marker is therefore a pale-amber triangle sitting directly on the
          notice panel, with no disc edge of its own — the PNG's disc IS the
          panel's #FFF8E1. WITH IMAGES BLOCKED the gutter is simply empty; the
          notice never depended on it, since its heading ("Didn't request this?")
          and body state the warning in full. */}
      <Section className={`bg-[${NOTICE_BG}] rounded-[8px] px-[16px] py-[14px]`}>
        <Row>
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
              Didn&apos;t request this?
            </Text>
            <Text className="mt-[4px] mb-0 mx-0 font-body text-[12px] font-normal leading-[1.5] text-text-secondary">
              If you didn&apos;t request a password reset, you can safely ignore this email. No one
              can change your password without this code.
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
