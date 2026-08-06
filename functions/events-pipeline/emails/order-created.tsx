import { Heading, Section, Row, Column, Text, Hr } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { Button } from "./components/button.tsx";
import { theme } from "./theme.ts";

// Ported from the "Order Created Email" frame of `assets/email/emails.pen`: a
// success circle, "Order Confirmed!", a greeting, an ITEM/QTY/PRICE line-items
// table, a totals block, a "SHIPPING TO" panel, the tracking CTA and a help
// line.
//
// Two things the `.pen` hardcodes come from PROPS here, not from the mockup:
// the three fixed products (this iterates `items`) and every money figure
// (formatted from cents). The mockup is a picture of one order; the template
// has to render any order.

// One receipt line, as #handlers/order-created maps it off the wire
// (`unit_price_cents` -> `unitPriceCents`). There is deliberately no per-line
// total: the template multiplies quantity by unit price, and a second figure
// on the props could contradict the two it was derived from.
export interface OrderCreatedEmailItem {
  name: string;
  quantity: number;
  unitPriceCents: number;
}

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

// Every money figure on this receipt is an integer of cents (see
// #handlers/order-created's payload schema comment) — never a decimal. Divide
// by 100 and fix to two decimals so the email always shows a human-readable
// amount ($47.39), not raw cents. Used for the line prices AND the four totals,
// so no figure on the page can be formatted a second, different way.
function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// The mockup's `package-check` lucide icon cannot ship as-is. An icon font
// needs @font-face (a <style> block, which clients strip), an SVG sprite or
// inline <svg> is unsupported in Outlook and several webmail clients, and a
// remote <img> is blocked by default for most readers — all three degrade to a
// broken box or nothing. So the circle is kept (it carries the "success" colour
// cue on its own) and the glyph inside it is TEXT: a check mark, which every
// client renders with no assets loaded at all.
const ICON_GLYPH = "✓";

// The `.pen` sizes the right-hand QTY/PRICE columns by flex `gap`, which email
// clients do not support. Fixed pixel widths inside the table are the portable
// equivalent, and they are what makes the money column line up: every price
// cell is the same width and right-aligned, so the decimal points stack.
const QTY_COLUMN_WIDTH = "56px";
const PRICE_COLUMN_WIDTH = "88px";

// The `.pen`'s "Order Items" panel background — a one-off tint (#F9FAFB) rather
// than a named variable, so it is not in `theme.ts`.
const ITEMS_PANEL_BG = "#F9FAFB";

// The repeated cell recipes, now as class strings instead of style objects.
// Composed by interpolation at the call sites that need a variant (a different
// weight or colour), which is the `className` equivalent of the old object
// spread — Tailwind resolves the LAST conflicting utility, so an appended
// `text-text-secondary` beats the `text-text-primary` in the base string.
const CELL = "m-0 font-body text-[14px] font-normal text-text-primary";
const HEADER_CELL = "m-0 font-body text-[12px] font-semibold tracking-[1px] text-text-muted";

// A hairline rule matching the `.pen`'s 1px `$border-color` divider frames.
//
// STOP POINT — the border stays an inline `style`. `Hr` emits its own default
// ("border:none;border-top:1px solid #eaeaea") AFTER the styles compiled from
// `className`, so a `border-line` class loses the cascade and the rule renders
// grey instead of the brand line colour. Nothing fails loudly when that happens,
// which is exactly why it is called out here. `margin` is also a runtime prop
// (callers pass "0", "8px 0", "24px 0"), so it could not be a static class
// anyway.
function Divider({ margin }: { margin: string }) {
  return <Hr style={{ borderColor: theme.borderColor, borderTopWidth: "1px", margin }} />;
}

// One line item: name on the left, quantity centred, extended price
// right-aligned. The mockup shows the UNIT price; this shows quantity × unit
// price, because a receipt whose line figures do not sum to its own subtotal is
// worse than one that repeats the unit price.
function ItemRow({ item }: { item: OrderCreatedEmailItem }) {
  return (
    <Row className="px-0 py-[12px]">
      <Column align="left">
        <Text className={CELL}>{item.name}</Text>
      </Column>
      {/* The fixed column widths stay inline: they are shared constants that
          must match the header row and the totals block exactly (that is what
          makes the decimal points stack), so they read from one declaration
          rather than being restated as a class in four places. */}
      <Column align="center" style={{ width: QTY_COLUMN_WIDTH }}>
        <Text className={`${CELL} text-text-secondary`}>{item.quantity}</Text>
      </Column>
      <Column align="right" style={{ width: PRICE_COLUMN_WIDTH }}>
        <Text className={`${CELL} font-medium`}>
          {formatCents(item.quantity * item.unitPriceCents)}
        </Text>
      </Column>
    </Row>
  );
}

// A totals line: muted label left, figure right. Right-aligned so Subtotal /
// Shipping / Tax / Total line up under each other.
function TotalRow({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  // `emphasis` is a runtime prop, but it has only TWO outcomes, so each branch
  // selects a COMPLETE static class string. That keeps every class literal and
  // visible to Tailwind — unlike interpolating a computed value into a class
  // (`text-[${size}]`), which would produce a rule Tailwind never generates.
  const emphasisClasses = emphasis ? "text-[16px] font-bold" : "text-[14px] font-normal";
  const labelColor = emphasis ? "text-text-primary" : "text-text-secondary";

  return (
    <Row className="mb-[8px]">
      <Column align="left">
        <Text className={`m-0 font-body ${emphasisClasses} ${labelColor}`}>{label}</Text>
      </Column>
      <Column align="right" style={{ width: PRICE_COLUMN_WIDTH }}>
        <Text className={`m-0 font-body ${emphasisClasses} text-text-primary`}>{value}</Text>
      </Column>
    </Row>
  );
}

// `shippingAddress` is a `Record<string, unknown>` whose real shape today is
// `{ line1, city, country, postal_code }`, but the snapshot is owned by Users —
// a field can be missing, or arrive as something that is not a string. So each
// field is read defensively: non-strings are DROPPED rather than coerced, which
// is what keeps "[object Object]" and "undefined" out of a customer's receipt.
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// Two display lines: street, then "city, postal_code, country". Whatever is
// absent simply does not contribute a segment, so a half-filled address renders
// as the half it has instead of a line of placeholders.
function formatAddressLines(address: Record<string, unknown>): string[] {
  const street = readString(address, "line1");
  const locality = [readString(address, "city"), readString(address, "postal_code"), readString(address, "country")]
    .filter((part): part is string => part !== undefined)
    .join(", ");

  return [street, locality.length > 0 ? locality : undefined].filter(
    (line): line is string => line !== undefined,
  );
}

// Default export, because react-email's `email dev` previews the default
// export of each file under `emails/`. The catalog imports the same symbol, so
// preview and production render the identical component.
export default function OrderCreatedEmail({
  orderId,
  fullName,
  subtotalCents,
  taxCents,
  shippingCents,
  totalCents,
  shippingAddress,
  items,
}: OrderCreatedEmailProps) {
  // Computed BEFORE the JSX so the panel's presence is one decision: the whole
  // "SHIPPING TO" block disappears when the producer omitted the key, and also
  // when it sent an object none of whose fields survived the reads above. An
  // empty blue panel would look like a rendering bug to the customer.
  const addressLines = shippingAddress ? formatAddressLines(shippingAddress) : [];
  const hasShippingPanel = addressLines.length > 0;

  return (
    <EmailLayout>
      {/* "Icon Circle": 64px, success-tinted, centred. Rendered as a table cell
          with a fixed line-height rather than flex centring. */}
      <Section>
        <Row>
          <Column align="center">
            <Text className="mx-auto my-0 w-[64px] h-[64px] rounded-[32px] bg-success-bg text-success font-heading text-[28px] leading-[64px] text-center">
              {ICON_GLYPH}
            </Text>
          </Column>
        </Row>
      </Section>

      <Heading
        as="h1"
        className="mt-[24px] mb-0 mx-0 font-heading text-[24px] font-bold text-text-primary text-center"
      >
        Order Confirmed!
      </Heading>

      <Text className="mt-[24px] mb-0 mx-0 font-body text-[15px] text-text-primary">
        Hi {fullName},
      </Text>

      <Text className="mt-[12px] mb-0 mx-0 font-body text-[14px] leading-[1.5] text-text-secondary">
        Thank you for your order! We&apos;ve received your order {orderId} and it&apos;s being
        prepared. Here&apos;s a summary of what you ordered:
      </Text>

      {/* "Order Items": the ITEM/QTY/PRICE table. The `.pen` splits it with
          `justifyContent: space_between`; email clients do not support flex, so
          the INTENT (a three-column row) is a Row/Column table here. */}
      <Section
        className={`bg-[${ITEMS_PANEL_BG}] rounded-[8px] px-[24px] py-[20px] mt-[24px] mb-0 mx-0`}
      >
        <Row className="pb-[12px]">
          <Column align="left">
            <Text className={HEADER_CELL}>ITEM</Text>
          </Column>
          <Column align="center" style={{ width: QTY_COLUMN_WIDTH }}>
            <Text className={HEADER_CELL}>QTY</Text>
          </Column>
          <Column align="right" style={{ width: PRICE_COLUMN_WIDTH }}>
            <Text className={HEADER_CELL}>PRICE</Text>
          </Column>
        </Row>

        <Divider margin="0" />

        {/* The mockup's divider-between-rows, driven by the data: a rule before
            every line except the first, so N items produce N-1 dividers and the
            table never ends on a dangling rule. */}
        {items.map((item, index) => (
          <Section key={`${item.name}-${index}`}>
            {index > 0 ? <Divider margin="0" /> : null}
            <ItemRow item={item} />
          </Section>
        ))}
      </Section>

      <Divider margin="24px 0" />

      {/* "Totals": every figure formatted from cents, right-aligned in the same
          fixed-width column as the line prices so the amounts stack. */}
      <Section>
        <TotalRow label="Subtotal" value={formatCents(subtotalCents)} />
        <TotalRow label="Shipping" value={formatCents(shippingCents)} />
        <TotalRow label="Tax" value={formatCents(taxCents)} />
        <Divider margin="8px 0" />
        <TotalRow label="Total" value={formatCents(totalCents)} emphasis />
      </Section>

      {/* "Shipping Info": omitted entirely when there is no address to show. */}
      {hasShippingPanel ? (
        <Section className="bg-info-bg rounded-[8px] px-[20px] py-[16px] mt-[24px] mb-0 mx-0">
          <Text className="m-0 font-body text-[13px] font-semibold tracking-[1px] text-info">
            SHIPPING TO
          </Text>
          <Text className="mt-[8px] mb-0 mx-0 font-body text-[14px] font-medium text-text-primary">
            {fullName}
          </Text>
          {addressLines.map((line) => (
            <Text
              key={line}
              className="mt-[4px] mb-0 mx-0 font-body text-[13px] leading-[1.5] text-text-secondary"
            >
              {line}
            </Text>
          ))}
        </Section>
      ) : null}

      {/* "Track Button" — info-blue in this frame, not brand orange. Its lucide
          `package-search` icon is dropped for the same reason as the header
          glyph: the label alone must carry the CTA with no images loaded. */}
      <Section className="mt-[24px] mb-0 mx-0">
        <Row>
          <Column align="center">
            <Button
              href={`https://app.3mrai.com/orders/${orderId}/tracking`}
              backgroundColor={theme.infoBlue}
            >
              Track Your Order
            </Button>
          </Column>
        </Row>
      </Section>

      <Text className="mt-[24px] mb-0 mx-0 font-body text-[12px] text-text-muted text-center">
        Questions about your order? Contact us at support@3mrai.com
      </Text>
    </EmailLayout>
  );
}
