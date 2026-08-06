import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";

export interface TrackingStatusChangedEmailProps {
  orderId: string;
  status: "PLACED" | "PROCESSING" | "SHIPPED" | "OUT_FOR_DELIVERY" | "DELIVERED";
  previousStatus: string;
}

// ONE component, five rendered variants — the copy varies by `status`, not
// the file. See the milestone design spec's "tracking-status-changed template
// family" and #handlers/tracking-status-changed for where the fan-out from
// payload.status to a catalog key (and from there to this component) lives.
const COPY: Record<TrackingStatusChangedEmailProps["status"], { heading: string; body: string }> = {
  PLACED: {
    heading: "Order placed",
    body: "has been received and confirmed. We'll let you know as soon as it's being prepared.",
  },
  PROCESSING: {
    heading: "Your order is being prepared",
    body: "is being picked and packed for shipment.",
  },
  SHIPPED: {
    heading: "Your order has shipped",
    body: "has been handed to the carrier and is on its way to you.",
  },
  OUT_FOR_DELIVERY: {
    heading: "Out for delivery",
    body: "is out for delivery today.",
  },
  DELIVERED: {
    heading: "Delivered",
    body: "has been delivered.",
  },
};

// Default export, because react-email's `email dev` previews the default
// export of each file under `emails/`. The catalog imports the same symbol,
// so preview and production render the identical component.
export default function TrackingStatusChangedEmail({
  orderId,
  status,
  previousStatus,
}: TrackingStatusChangedEmailProps) {
  const { heading, body } = COPY[status];
  return (
    <EmailLayout>
      <Heading>{heading}</Heading>
      <Text>
        Order {orderId} {body} (previously: {previousStatus}).
      </Text>
    </EmailLayout>
  );
}
