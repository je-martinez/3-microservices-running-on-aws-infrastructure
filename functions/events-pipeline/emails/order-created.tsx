import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";

export interface OrderCreatedEmailProps {
  orderId: string;
  totalCents: number;
}

// totalCents is an integer of cents (see #handlers/order-created's payload
// schema comment) — never a decimal. Divide by 100 and fix to two decimals so
// the email always shows a human-readable amount ($45.99), not raw cents.
function formatCents(totalCents: number): string {
  return `$${(totalCents / 100).toFixed(2)}`;
}

// Default export, because react-email's `email dev` previews the default
// export of each file under `emails/`. The catalog imports the same symbol, so
// preview and production render the identical component.
export default function OrderCreatedEmail({ orderId, totalCents }: OrderCreatedEmailProps) {
  return (
    <EmailLayout>
      <Heading>Order confirmed</Heading>
      <Text>
        Your order {orderId} for {formatCents(totalCents)} has been placed.
      </Text>
    </EmailLayout>
  );
}
