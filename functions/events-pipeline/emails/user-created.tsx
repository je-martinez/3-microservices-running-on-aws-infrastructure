import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";

// `userId` and `createdAt` are carried but NOT YET RENDERED — the mockup's
// "Account ID" and "Member Since" rows land with the visual redesign, which is a
// separate task. They are declared here now so that task is a template change
// alone, with no second pass through the schema, the handler and the catalog.
//
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
