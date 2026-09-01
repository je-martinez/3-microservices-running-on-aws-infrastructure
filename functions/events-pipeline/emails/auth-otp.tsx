import { Section, Row, Column, Heading, Text, Hr, Img } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { greeting } from "./components/greeting.ts";
import { theme } from "./theme.ts";
import { emailAssets } from "./assets.ts";

export interface AuthOtpEmailProps {
  code: string;
  // Dynamic expiry derived from payload ttlSeconds / 60.
  ttlMinutes: number;
  // Empty string falls back to a nameless greeting, never printing an empty gap.
  fullName: string;
}

// CONTRACT: Renders 6-digit sign-in OTP with dynamic TTL from payload.
// CONTRACT: Use remote PNGs from assets bucket for icons (log-in and triangle-alert).
// See [[email-templates]]

const DIGIT_BG = "#F9FAFB";
const NOTICE_BG = "#FFF8E1";

export default function AuthOtpEmail({ code, ttlMinutes, fullName }: AuthOtpEmailProps) {
  // Split for 6-box display; string format preserves leading zeros.
  const digits = code.split("");

  return (
    <EmailLayout>
      {/* CONTRACT: log-in PNG contains its own 64px disc. Do NOT nest CSS circle behind it.
          See [[email-templates]] */}
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

      {/* CONTRACT: Include contiguous plain-text code in body for E2E scraper extraction.
          See [[email-templates]] */}
      <Text className="mt-[12px] mb-0 mx-0 font-body text-[14px] font-normal leading-[1.5] text-text-secondary">
        Use this code to sign in to your 3MRAI account: {code}. Enter it on the login screen to
        continue:
      </Text>

      {/* OTP Section — six table columns with padding for email client compatibility. */}
      <Section className="mt-[24px] mb-0 mx-0">
        <Row>
          {digits.map((digit, index) => (
            // Positional key is stable because digit sequence is static within a render.
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

      {/* Inline border style prevents Tailwind override. */}
      <Hr className="my-[24px] mx-0" style={{ borderColor: theme.borderColor, borderTopWidth: "1px" }} />

      {/* CONTRACT: Security notice uses remote triangleAlert PNG.
          See [[email-templates]] */}
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
