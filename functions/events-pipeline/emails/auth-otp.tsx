import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";

export interface AuthOtpEmailProps {
  code: string;
  ttlMinutes: number;
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
