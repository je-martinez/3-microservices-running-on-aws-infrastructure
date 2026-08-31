import { Heading, Section, Row, Column, Text, Hr, Img } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { greeting } from "./components/greeting.ts";
import { Button } from "./components/button.tsx";
import { DetailRow } from "./components/detail-row.tsx";
import { theme } from "./theme.ts";
import { emailAssets, type EmailAsset } from "./assets.ts";

// CONTRACT: Render email layout using react-email Row/Column tables for broad client support.
// CONTRACT: Use remote PNGs from assets bucket for all icons and status dots. Do NOT use
// inline SVG or CSS border-radius (unsupported in Windows Outlook).
// See [[email-templates]]

// One entry per transition the shipment has already made, oldest first.
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
  // Optional because producer omits key when no shipping address exists.
  shippingAddress?: Record<string, unknown>;
  history: TrackingStatusChangedHistoryEntry[];
}

// Placeholder constants matching mockup until domain model supports carrier/origin.
const PLACEHOLDER_CARRIER = "FedEx Express";
const PLACEHOLDER_SHIP_FROM = "San Juan, PR";

// Forward-only status progression defining the sequence of timeline steps.
const STEPS = [
  { status: "PLACED", label: "Order Placed" },
  { status: "PROCESSING", label: "Processing" },
  { status: "SHIPPED", label: "Shipped" },
  { status: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
  { status: "DELIVERED", label: "Delivered" },
] as const;

// Resolves human label for a status enum value, falling back to raw string.
function statusLabel(status: string): string {
  return STEPS.find((step) => step.status === status)?.label ?? status;
}

// Estimated delivery offset in days from PLACED timestamp.
const ESTIMATED_DELIVERY_DAYS = 7;

// Copy variants rendered per status value.
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

const TIMELINE_BG = "#F9FAFB";

// Dates formatted in UTC to ensure consistent rendering across timezones.
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

// Calculates estimated delivery date from PLACED history entry.
function estimatedDelivery(history?: TrackingStatusChangedHistoryEntry[]): string | undefined {
  const placed = history?.find((entry) => entry.status === "PLACED");
  if (!placed) return undefined;
  const placedAt = new Date(placed.datetime);
  if (Number.isNaN(placedAt.getTime())) return undefined;
  const estimate = new Date(placedAt.getTime() + ESTIMATED_DELIVERY_DAYS * 24 * 60 * 60 * 1000);
  return formatLongDate(estimate);
}

// Formats shipping address defensively, omitting missing or invalid segments.
function formatShippingAddress(address?: Record<string, unknown>): string | undefined {
  if (!address) return undefined;
  const part = (key: string): string | undefined => {
    const value = address[key];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const cityLine = [part("city"), [part("country"), part("postal_code")].filter(Boolean).join(" ")]
    .filter((segment) => segment && segment !== "")
    .join(", ");
  const formatted = [part("line1"), cityLine].filter((segment) => segment && segment !== "").join(", ");
  return formatted === "" ? undefined : formatted;
}

type StepState = "done" | "active" | "pending";

// Maps step state to remote dot asset entry with fixed 22px dimensions.
const STEP_DOT: Record<StepState, EmailAsset> = {
  done: emailAssets.greenDot,
  active: emailAssets.orangeDot,
  pending: emailAssets.blankDot,
};

// Alt text per state for screen readers and blocked image mode.
const STEP_DOT_ALT: Record<StepState, string> = {
  done: "Completed",
  active: "In progress",
  pending: "Pending",
};

// CONTRACT: Step indicator dot is a remote PNG asset; connector is a table cell background color.
// Do NOT use CSS border-radius for dots (renders as square in Windows Outlook).
// See [[email-templates]]
function StepIndicator({ state, isLast }: { state: StepState; isLast: boolean }) {
  const lineFill = state === "done" ? theme.successGreen : theme.borderColor;

  return (
    <>
      <Row width="auto" className="border-collapse">
        <Column align="center" className="p-0 leading-[0]">
          {/* CONTRACT: Dot state renders via asset image selection with fixed dimensions.
              See [[email-templates]] */}
          <Img
            {...STEP_DOT[state]}
            alt={STEP_DOT_ALT[state]}
            className="block"
          />
        </Column>
      </Row>
      {!isLast && (
        <Row width="auto" className="border-collapse">
          {/* Line rendered via table cell background color. */}
          <Column
            align="center"
            className="w-[2px] h-[28px] text-[1px] leading-[28px]"
            style={{ backgroundColor: lineFill }}
          >
            &#8203;
          </Column>
        </Row>
      )}
    </>
  );
}

// Vertical timeline driven by history array and current status index.
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
    <Section className={`bg-[${TIMELINE_BG}] rounded-[8px] px-[20px] py-[24px] mb-[24px]`}>
      {STEPS.map((step, index) => {
        const state: StepState =
          index < currentIndex ? "done" : index === currentIndex ? "active" : "pending";
        const entry = history?.find((item) => item.status === step.status);

        let dateLabel = "—";
        if (state !== "pending" && entry) {
          dateLabel = formatShortDate(entry.datetime);
        } else if (state === "pending" && index === currentIndex + 1 && estimate) {
          dateLabel = `Estimated ${estimate}`;
        }

        return (
          <Row key={step.status}>
            <Column className="w-[36px] align-top">
              <StepIndicator state={state} isLast={index === STEPS.length - 1} />
            </Column>
            <Column className="align-top pt-[2px]">
              <Text
                className={`m-0 font-body text-[14px] ${state === "active" ? "font-semibold" : "font-normal"} ${
                  state === "pending" ? "text-text-muted" : "text-text-primary"
                }`}
              >
                {step.label}
              </Text>
              <Text className="mt-[2px] mb-0 mx-0 font-body text-[12px] text-text-muted">
                {dateLabel}
              </Text>
            </Column>
          </Row>
        );
      })}
    </Section>
  );
}

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
      {/* CONTRACT: map-pin PNG includes its own 64px disc. Do NOT nest CSS circle behind it.
          See [[email-templates]] */}
      <Row>
        <Column align="center">
          <Row width="auto" className="border-collapse">
            <Column align="center" className="text-center">
              <Img
                {...emailAssets.mapPin}
                alt="Shipment location update"
                className="inline-block align-middle"
              />
            </Column>
          </Row>
        </Column>
      </Row>

      <Heading className="mt-[24px] mb-0 mx-0 font-heading text-[24px] font-bold text-text-primary text-center">
        Tracking Update
      </Heading>

      {/* Greeting and status transition summary */}
      <Text className="mt-[24px] mb-0 mx-0 font-body text-[15px] text-text-primary">
        {greeting(fullName)}
      </Text>
      <Text className="mt-[12px] mb-[24px] mx-0 font-body text-[14px] leading-[1.5] text-text-secondary">
        {heading}: your order {orderId} {body} (previously: {statusLabel(previousStatus)}). Here&apos;s
        the latest on your shipment:
      </Text>

      <StatusTimeline status={status} history={history} />

      {/* Divider */}
      <Hr
        className="mt-0 mb-[24px] mx-0"
        style={{ borderColor: theme.borderColor, borderTopWidth: "1px" }}
      />

      {/* Shipment Details section */}
      <Text className="mt-0 mb-[12px] mx-0 font-body text-[14px] font-semibold text-text-primary">
        Shipment Details
      </Text>
      <DetailRow label="Carrier" value={PLACEHOLDER_CARRIER} />
      <DetailRow label="Tracking Number" value={trackingNumber} />
      {estimate && <DetailRow label="Estimated Delivery" value={estimate} />}
      <DetailRow label="Ship From" value={PLACEHOLDER_SHIP_FROM} />
      {shipTo && <DetailRow label="Ship To" value={shipTo} />}

      {/* Track Shipment CTA button with external-link icon */}
      <Section className="text-center pt-[24px] px-0 pb-0">
        <Button href={`https://app.3mrai.com/orders/${orderId}/tracking`} backgroundColor={theme.infoBlue}>
          <Img
            {...emailAssets.externalLink}
            alt="Opens in your browser"
            className="inline-block align-middle mr-[6px]"
          />
          <span className="align-middle">Track Your Shipment</span>
        </Button>
      </Section>

      <Text className="mt-[24px] mb-0 mx-0 font-body text-[12px] text-text-muted text-center">
        If you have questions about your delivery, contact our support team.
      </Text>
    </EmailLayout>
  );
}
