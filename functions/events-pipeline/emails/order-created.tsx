import { Heading, Text } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";

// One receipt line, as #handlers/order-created maps it off the wire
// (`unit_price_cents` -> `unitPriceCents`). There is deliberately no per-line
// total: the template multiplies quantity by unit price, and a second figure
// on the props could contradict the two it was derived from.
export interface OrderCreatedEmailItem {
  name: string;
  quantity: number;
  unitPriceCents: number;
}

// Everything below `totalCents` is carried but NOT YET RENDERED — the mockup's
// line-item table, money breakdown and shipping block land with the visual
// redesign, which is a separate task. They are declared here now so that task is
// a template change alone, with no second pass through the schema, the handler
// and the catalog (same reasoning as `user-created.tsx`).
//
// `shippingAddress` is optional and never null: the producer omits the key
// entirely when the buyer has no address on file (see the handler's schema
// comment), so a template branches on ONE absence marker rather than two. It is
// typed as a permissive record because the column is a point-in-time snapshot
// whose shape is owned by Users' `Address` message.
//
// `createdAt` is the ISO-8601 string the producer serialized, not a Date — it
// crossed a JSON boundary, and typing it as a Date would be a lie the renderer
// would eventually trip over.
export interface OrderCreatedEmailProps {
  orderId: string;
  totalCents: number;
  fullName: string;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  shippingAddress?: Record<string, unknown>;
  items: OrderCreatedEmailItem[];
  createdAt: string;
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
