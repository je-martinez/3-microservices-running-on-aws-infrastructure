import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";

export interface AuthOtpEmailProps {
  code: string;
  ttlMinutes: number;
  // MAY BE THE EMPTY STRING, and that is the normal path today: Cognito has no
  // `name` attribute populated (Users' AdminCreateUser writes only `email`,
  // `email_verified` and `custom:app_user_id`), so the producer falls back to
  // "". Required rather than optional precisely so the template cannot forget
  // the case — it must degrade to a nameless greeting, never print an empty gap.
  fullName: string;
}

// Default export, because react-email's `email dev` previews the default
// export of each file under `emails/`. The catalog imports the same symbol, so
// preview and production render the identical component.
//
// The code is rendered as plain visible text (not an image, not obfuscated,
// not split across elements) — deliberately, so the gateway E2E spec can
// extract it from the delivered message body without OCR or fragile markup
// scraping. It sits near the top of the body for the same reason: mail clients
// (and Mailpit) truncate the snippet used for that extraction.
export default function AuthOtpEmail({ code, ttlMinutes }: AuthOtpEmailProps) {
  return (
    <EmailLayout>
      <Heading>Your one-time code</Heading>
      <Text>
        Use this code to sign in: {code}. It expires in {ttlMinutes} minutes.
      </Text>
      <Text style={{ fontSize: "28px", fontWeight: "bold", letterSpacing: "4px" }}>{code}</Text>
      <Text>If you did not request this, you can safely ignore this email.</Text>
    </EmailLayout>
  );
}
