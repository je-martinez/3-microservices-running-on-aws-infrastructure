import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";

export interface UserCreatedEmailProps {
  fullName: string;
  email: string;
}

// Default export, because react-email's `email dev` previews the default
// export of each file under `emails/`. The catalog imports the same symbol, so
// preview and production render the identical component.
export default function UserCreatedEmail({ fullName, email }: UserCreatedEmailProps) {
  return (
    <EmailLayout>
      <Heading>Welcome, {fullName}!</Heading>
      <Text>Your account ({email}) has been created successfully.</Text>
    </EmailLayout>
  );
}
