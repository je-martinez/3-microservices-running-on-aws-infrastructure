import { Heading, Section, Row, Column, Text, Hr } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { Button } from "./components/button.tsx";
import { DetailRow } from "./components/detail-row.tsx";
import { theme } from "./theme.ts";

// Ported from the "Tracking Status Update Email" frame of
// `assets/email/emails.pen`. The `.pen` expresses its layout with flexbox
// (`justifyContent: space_between`, nested vertical frames for the timeline)
// because Pencil is a design tool; email clients do NOT reliably support flex or
// grid, so the INTENT is translated into react-email's `Row`/`Column`, which
// render as tables.
//
// ICONS: the `.pen` uses three lucide glyphs (`map-pin` in the header circle,
// `check` inside each completed timeline dot, `external-link` on the CTA). NONE
// of them is rendered as an icon here. An icon font never loads in email, inline
// SVG is unsupported by Outlook/Gmail's HTML sanitizers, and a remote <img> is
// blocked by default in many clients — all three roads end in a blank box. So:
//   - the header circle and the timeline dots are COLOURED SHAPES (a
//     background-filled, border-radiused table cell), which need no assets at
//     all, and
//   - the completed dots carry a "✓" TEXT GLYPH (U+2713), which is in every
//     mail-client font stack.
//   - the CTA's `external-link` is dropped entirely; a button labelled "Track
//     Your Shipment" already reads as a link, and a stray glyph would look like
//     a rendering artefact.
// The email therefore looks deliberate with zero images loaded, which is the
// state most recipients see on first open.

// One entry per transition the shipment has already made, oldest first. Carried
// on the event rather than re-derived here: the pipeline stores its own event
// documents but has no view of a tracking's history, and the timeline the
// rebranded template draws needs every prior step, not just this transition.
export interface TrackingStatusChangedHistoryEntry {
  status: string;
  datetime: string;
}

export interface TrackingStatusChangedEmailProps {
  orderId: string;
  status: "PLACED" | "PROCESSING" | "SHIPPED" | "OUT_FOR_DELIVERY" | "DELIVERED";
  previousStatus: string;
  changedAt: string;
  fullName: string;
  trackingNumber: string;
  // Optional because the producer OMITS the key when the shipment has no address
  // on file — never sends it as null. See the payload schema in
  // #handlers/tracking-status-changed.
  shippingAddress?: Record<string, unknown>;
  history: TrackingStatusChangedHistoryEntry[];
}

// PLACEHOLDER CONSTANTS, NOT DATA. Neither the carrier nor the origin warehouse
// exists anywhere in the domain — the tracking service models neither, so no
// producer can send them and no prop can carry them. The `.pen` shows both rows,
// so they are hardcoded here to match the mockup, and they must be replaced by
// real props the day those fields are modelled. Everything else in the Shipment
// Details block comes from the event.
const PLACEHOLDER_CARRIER = "FedEx Express";
const PLACEHOLDER_SHIP_FROM = "San Juan, PR";

// The forward-only progression a shipment walks, with the human labels the
// `.pen` prints. Order is load-bearing: the timeline's done/active/pending state
// is derived from a step's INDEX relative to the current status, so this array
// is the single source of the sequence.
const STEPS = [
  { status: "PLACED", label: "Order Placed" },
  { status: "PROCESSING", label: "Processing" },
  { status: "SHIPPED", label: "Shipped" },
  { status: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
  { status: "DELIVERED", label: "Delivered" },
] as const;

// Days between the order being placed and its estimated delivery. A template
// constant for the same reason as the carrier: the domain carries no promised
// delivery date, so the mockup's "Estimated Delivery" row is COMPUTED from the
// PLACED timestamp rather than read from a field that does not exist.
const ESTIMATED_DELIVERY_DAYS = 7;

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

// The `.pen`'s timeline panel background (`#F9FAFB`) — a one-off tint in the
// design rather than a named variable, so it is not in `theme.ts`.
const TIMELINE_BG = "#F9FAFB";

// The mockup's short step date ("Jul 28, 2026") and the longer estimate
// ("August 5, 2026"). Both pinned to UTC: the datetimes are ISO-8601 strings the
// producer serialized in UTC, and formatting them in the RENDERER's local zone
// would make the same event show a different day depending on which region the
// Lambda ran in — and would make snapshots depend on the machine running them.
function formatShortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatLongDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Placed + 7 days. Returns undefined when there is no usable PLACED entry, so
// the caller OMITS the row rather than printing a wrong or "Invalid Date"
// estimate — a delivery date is exactly the field a recipient acts on, and a
// made-up one is worse than a missing one.
// `history` is typed as required, but `renderTemplate` erases its props to
// `unknown` before calling the component, so a caller that skips the handler's
// Zod validation reaches here with the array absent — the existing
// tracking-status-changed tests do exactly that. Guarding is not defensive
// paranoia about the type: it is the difference between a missing timeline row
// and a Lambda that throws while rendering a delivery notification.
function estimatedDelivery(history?: TrackingStatusChangedHistoryEntry[]): string | undefined {
  const placed = history?.find((entry) => entry.status === "PLACED");
  if (!placed) return undefined;
  const placedAt = new Date(placed.datetime);
  if (Number.isNaN(placedAt.getTime())) return undefined;
  const estimate = new Date(placedAt.getTime() + ESTIMATED_DELIVERY_DAYS * 24 * 60 * 60 * 1000);
  return formatLongDate(estimate);
}

// `shippingAddress` is a permissive record: the column is a point-in-time
// snapshot whose shape is owned by Users' `Address` message, so this reads the
// fields it knows (`line1`, `city`, `country`, `postal_code`) DEFENSIVELY and
// drops anything non-string instead of interpolating "[object Object]" or
// "undefined" into the email. Returns undefined when nothing usable survives, so
// the Ship To row disappears exactly as it does when the key is absent.
function formatShippingAddress(address?: Record<string, unknown>): string | undefined {
  if (!address) return undefined;
  const part = (key: string): string | undefined => {
    const value = address[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  // "1 Ada Way, San Juan, PR 00901" — postal code joined to the country with a
  // space, everything else comma-separated, matching the mockup's "Miami, FL
  // 33101".
  const cityLine = [part("city"), [part("country"), part("postal_code")].filter(Boolean).join(" ")]
    .filter((segment) => segment && segment !== "")
    .join(", ");
  const formatted = [part("line1"), cityLine].filter((segment) => segment && segment !== "").join(", ");
  return formatted === "" ? undefined : formatted;
}

type StepState = "done" | "active" | "pending";

// The indicator column of one timeline row: the dot, and below it the connector
// line running to the next step. Both are plain table cells with a background
// colour — no image, no SVG, no positioned element (absolute positioning is
// stripped by Outlook, which renders through Word's HTML engine).
//
// The connector is omitted on the last step, matching the `.pen`, where only
// "Step Delivered" has no "Line" child.
function StepIndicator({ state, isLast }: { state: StepState; isLast: boolean }) {
  const dotFill =
    state === "done" ? theme.successGreen : state === "active" ? theme.brandOrange : theme.bgWhite;
  // The connector takes the colour of the step ABOVE it: green once that step is
  // reached (the `.pen` draws the line under the active "Shipped" step green
  // too), grey for everything still ahead.
  const lineFill = state === "pending" ? theme.borderColor : theme.successGreen;

  return (
    <>
      <table cellPadding="0" cellSpacing="0" role="presentation" style={{ borderCollapse: "collapse" }}>
        <tbody>
          <tr>
            <td
              align="center"
              style={{
                width: "22px",
                height: "22px",
                backgroundColor: dotFill,
                borderRadius: "11px",
                // The pending dot is a hollow ring; done/active are filled, and
                // the active one gets a white centre from the "●" glyph below.
                border: state === "pending" ? `2px solid ${theme.borderColor}` : "none",
                fontFamily: theme.fontBody,
                fontSize: state === "done" ? "13px" : "10px",
                lineHeight: "22px",
                color: theme.bgWhite,
                textAlign: "center",
              }}
            >
              {/* Text glyphs, not icons — see the ICONS note at the top of the
                  file. "✓" replaces lucide's `check`; "●" is the `.pen`'s white
                  10px "Inner Dot" inside the orange active ring. A pending step
                  has an empty ring, exactly as designed. */}
              {state === "done" ? "✓" : state === "active" ? "●" : ""}
            </td>
          </tr>
          {!isLast && (
            <tr>
              <td align="center" style={{ padding: "0" }}>
                <table cellPadding="0" cellSpacing="0" role="presentation" style={{ borderCollapse: "collapse" }}>
                  <tbody>
                    <tr>
                      <td
                        style={{
                          width: "2px",
                          height: "28px",
                          backgroundColor: lineFill,
                          // Some clients collapse a cell with no content to zero
                          // height; a zero-width space keeps the line drawn.
                          fontSize: "1px",
                          lineHeight: "28px",
                        }}
                      >
                        &#8203;
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

// The five-step vertical timeline, driven ENTIRELY by `history` + `status` — no
// hardcoded dates. A step is `done` when it precedes the current status,
// `active` when it IS the current status, and `pending` after it. The date under
// a done step is that step's REAL `datetime` from history; pending steps show an
// em-dash, and the step immediately after the current one shows the computed
// estimate, as the `.pen` does with "Estimated Aug 5".
//
// If `status` is somehow not one of the five (it is typed as a union and the
// handler validates it, but this renders untrusted-shaped data), `currentIndex`
// is -1 and every step falls through to `pending` — a degraded but honest
// timeline rather than a crash.
function StatusTimeline({
  status,
  history,
}: {
  status: TrackingStatusChangedEmailProps["status"];
  history?: TrackingStatusChangedEmailProps["history"];
}) {
  const currentIndex = STEPS.findIndex((step) => step.status === status);
  const estimate = estimatedDelivery(history);

  return (
    <Section
      style={{
        backgroundColor: TIMELINE_BG,
        borderRadius: "8px",
        padding: "24px 20px",
        marginBottom: "24px",
      }}
    >
      {STEPS.map((step, index) => {
        const state: StepState =
          index < currentIndex ? "done" : index === currentIndex ? "active" : "pending";
        const entry = history?.find((item) => item.status === step.status);

        // A done or active step prints the timestamp it actually happened at.
        // The step immediately AFTER the current one carries the computed
        // estimate; anything further out is an em-dash, because guessing two
        // steps ahead would be fiction.
        let dateLabel = "—";
        if (state !== "pending" && entry) {
          dateLabel = formatShortDate(entry.datetime);
        } else if (state === "pending" && index === currentIndex + 1 && estimate) {
          dateLabel = `Estimated ${estimate}`;
        }

        return (
          <Row key={step.status}>
            {/* Two columns, not flex: an indicator column of fixed width and a
                text column that takes the rest. `verticalAlign: top` keeps the
                label level with its dot once the connector stretches the row. */}
            <Column style={{ width: "36px", verticalAlign: "top" }}>
              <StepIndicator state={state} isLast={index === STEPS.length - 1} />
            </Column>
            <Column style={{ verticalAlign: "top", paddingTop: "2px" }}>
              <Text
                style={{
                  margin: "0",
                  fontFamily: theme.fontBody,
                  fontSize: "14px",
                  // The `.pen` bolds ONLY the active step's label and mutes the
                  // ones not yet reached.
                  fontWeight: state === "active" ? 600 : 400,
                  color: state === "pending" ? theme.textMuted : theme.textPrimary,
                }}
              >
                {step.label}
              </Text>
              <Text
                style={{
                  margin: "2px 0 0",
                  fontFamily: theme.fontBody,
                  fontSize: "12px",
                  color: theme.textMuted,
                }}
              >
                {dateLabel}
              </Text>
            </Column>
          </Row>
        );
      })}
    </Section>
  );
}

// Default export, because react-email's `email dev` previews the default
// export of each file under `emails/`. The catalog imports the same symbol,
// so preview and production render the identical component.
export default function TrackingStatusChangedEmail({
  orderId,
  status,
  previousStatus,
  fullName,
  trackingNumber,
  shippingAddress,
  history,
}: TrackingStatusChangedEmailProps) {
  const { heading, body } = COPY[status];
  const estimate = estimatedDelivery(history);
  const shipTo = formatShippingAddress(shippingAddress);

  return (
    <EmailLayout>
      {/* "Icon Circle" — the `.pen`'s 64px info-blue disc holding a `map-pin`.
          Rendered as a filled, border-radiused cell with no icon at all (see the
          ICONS note): a shape that always draws beats a glyph that may not. */}
      <Row>
        <Column align="center">
          <table cellPadding="0" cellSpacing="0" role="presentation" style={{ borderCollapse: "collapse" }}>
            <tbody>
              <tr>
                <td
                  align="center"
                  style={{
                    width: "64px",
                    height: "64px",
                    backgroundColor: theme.infoBg,
                    borderRadius: "32px",
                    fontFamily: theme.fontBody,
                    fontSize: "26px",
                    lineHeight: "64px",
                    color: theme.infoBlue,
                    textAlign: "center",
                  }}
                >
                  {/* U+25CE — a ring around a dot, which reads as a map pin /
                      location marker and exists in the default font stacks. */}
                  ◎
                </td>
              </tr>
            </tbody>
          </table>
        </Column>
      </Row>

      <Heading
        style={{
          margin: "24px 0 0",
          fontFamily: theme.fontHeading,
          fontSize: "24px",
          fontWeight: 700,
          color: theme.textPrimary,
          textAlign: "center",
        }}
      >
        Tracking Update
      </Heading>

      {/* "Greeting Block". The `.pen`'s literal "Hi {{name}}," / order number are
          template placeholders; the real props fill them. `previousStatus` keeps
          its sentence here so each of the five variants states the transition it
          is actually reporting. */}
      <Text
        style={{
          margin: "24px 0 0",
          fontFamily: theme.fontBody,
          fontSize: "15px",
          color: theme.textPrimary,
        }}
      >
        Hi {fullName},
      </Text>
      <Text
        style={{
          margin: "12px 0 24px",
          fontFamily: theme.fontBody,
          fontSize: "14px",
          lineHeight: "1.5",
          color: theme.textSecondary,
        }}
      >
        {heading}: your order {orderId} {body} (previously: {previousStatus}). Here&apos;s the latest
        on your shipment:
      </Text>

      <StatusTimeline status={status} history={history} />

      <Hr style={{ borderColor: theme.borderColor, borderTopWidth: "1px", margin: "0 0 24px" }} />

      {/* "Shipping Details". Carrier and Ship From are the placeholder constants
          declared above; the other three come from the event, and the two that
          can be missing (estimate, address) omit their ROW rather than printing
          a blank or a wrong value. */}
      <Text
        style={{
          margin: "0 0 12px",
          fontFamily: theme.fontBody,
          fontSize: "14px",
          fontWeight: 600,
          color: theme.textPrimary,
        }}
      >
        Shipment Details
      </Text>
      <DetailRow label="Carrier" value={PLACEHOLDER_CARRIER} />
      <DetailRow label="Tracking Number" value={trackingNumber} />
      {estimate && <DetailRow label="Estimated Delivery" value={estimate} />}
      <DetailRow label="Ship From" value={PLACEHOLDER_SHIP_FROM} />
      {shipTo && <DetailRow label="Ship To" value={shipTo} />}

      {/* "Track Button" — info-blue in this frame, not brand orange, which is
          why `Button` takes an overridable background. No web app exists yet, so
          the href is a placeholder under app.3mrai.com. */}
      <Section style={{ textAlign: "center", padding: "24px 0 0" }}>
        <Button href={`https://app.3mrai.com/orders/${orderId}/tracking`} backgroundColor={theme.infoBlue}>
          Track Your Shipment
        </Button>
      </Section>

      <Text
        style={{
          margin: "24px 0 0",
          fontFamily: theme.fontBody,
          fontSize: "12px",
          color: theme.textMuted,
          textAlign: "center",
        }}
      >
        If you have questions about your delivery, contact our support team.
      </Text>
    </EmailLayout>
  );
}
