import { Heading, Section, Row, Column, Text, Hr, Img } from "@react-email/components";
import { EmailLayout } from "./components/layout.tsx";
import { greeting } from "./components/greeting.ts";
import { Button } from "./components/button.tsx";
import { DetailRow } from "./components/detail-row.tsx";
import { theme } from "./theme.ts";
import { emailAssets, type EmailAsset } from "./assets.ts";

// Ported from the "Tracking Status Update Email" frame of
// `assets/email/emails.pen`. The `.pen` expresses its layout with flexbox
// (`justifyContent: space_between`, nested vertical frames for the timeline)
// because Pencil is a design tool; email clients do NOT reliably support flex or
// grid, so the INTENT is translated into react-email's `Row`/`Column`, which
// render as tables.
//
// ICONS: the `.pen` uses `map-pin` in the header circle and `external-link` on
// the CTA, plus a dot per timeline step. All are served as REMOTE PNGs from the
// assets bucket (`emails/assets.ts`).
//
// Two alternatives still fail: an icon font needs @font-face (a <style> block
// Gmail and Outlook strip), and inline SVG has 40.48% support and renders in NO
// version of Outlook on Windows (caniemail.com/features/html-svg). The third — a
// remote <img> — is the one that works: 100% client support, and Gmail has
// displayed remote images by default since 2013. This REPLACES the base64
// `data:` URIs this file used to embed, whose 80.95% support left ~19% of
// readers with nothing. Full argument in `emails/assets.ts`.
//
// THE TIMELINE DOTS ARE THE BIG WIN HERE, and the reason is not the support
// number. They used to be `inline-block` <span>s with `border-radius: 50%`.
// `border-radius` has 82.92% support (caniemail.com/features/css-border-radius)
// and Outlook on Windows — Word's HTML engine — has NONE of it, so every dot
// rendered as a SQUARE there while the rest of the email looked correct. Three
// dot PNGs (green = done, orange = active, blank = pending) are circles in every
// client, and they remove this template's dependence on BOTH `border-radius` and
// `inline-block` from its most fragile construct.
//
// THE HEADER CIRCLE IS NOW THE SAME KIND OF IMAGE as those dots: the info-blue
// disc is baked into `map-pin.png` rather than drawn by the cell, so it is shown
// at the full 64px. Scaling it down inside a CSS disc nested two identical
// circles and left the glyph at 19% of the circle — the defect that motivated
// this; measurements in `emails/assets.ts`. It gains the same Outlook Windows
// benefit the dots did: a real circle instead of a square.
//
// A reader may still have images off, so the design still holds with zero
// assets loaded:
//   - the header marker disappears rather than degrading to a tinted disc, but
//     its 64x64 box is still reserved by the <Img>'s width/height attributes, so
//     "Tracking Update" does not jump upward and the `alt` names it;
//   - each timeline step keeps its TEXT LABEL, its date, and the bold weight on
//     the active one, so the progression is readable without any dot;
//   - the CTA still reads "Track Your Shipment" without its glyph.
// Every <Img> carries a meaningful `alt`.

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

// The human label for a raw status enum, for the places a status is printed as
// PROSE rather than rendered as a timeline step — today just the "(previously:
// …)" clause, which was showing the enum itself ("SHIPPED", not "Shipped").
//
// Falls back to the raw value rather than throwing or blanking: `previousStatus`
// is typed `string`, not the five-way union, so a status this template does not
// know about is reachable. Printing it raw is ugly; printing nothing would lose
// the transition the sentence exists to state.
function statusLabel(status: string): string {
  return STEPS.find((step) => step.status === status)?.label ?? status;
}

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

// The three dot images, one per state. A lookup rather than a chain of
// ternaries at the call site: the mapping IS the meaning (green = done,
// orange = active, blank = pending), and stating it once keeps the three from
// drifting apart as the component grows.
//
// Each entry already carries its 22px display width/height — the exact diameter
// the CSS-drawn dots had — so the indicator column's alignment is unchanged by
// the switch from spans to images.
const STEP_DOT: Record<StepState, EmailAsset> = {
  done: emailAssets.greenDot,
  active: emailAssets.orangeDot,
  pending: emailAssets.blankDot,
};

// `alt` per state, so a reader with images off gets the step's status as text
// rather than three identical "dot" strings. Kept beside STEP_DOT because the
// two are the same decision seen twice.
const STEP_DOT_ALT: Record<StepState, string> = {
  done: "Completed",
  active: "In progress",
  pending: "Pending",
};

// The indicator column of one timeline row: the dot, and below it the connector
// line running to the next step.
//
// THE DOT IS AN IMAGE, NOT A STYLED BOX — and that is the point of this
// component's current shape. It used to be an `inline-block` <span> with
// `border-radius: 50%`, which Outlook on Windows renders as a SQUARE:
// `border-radius` has 82.92% support and Word's HTML engine implements none of
// it. A PNG circle is a circle everywhere, and it takes both `border-radius` and
// `inline-block` out of the most fragile part of this layout. Do not "simplify"
// it back into a styled span.
//
// The CONNECTOR stays a plain table cell with a background colour — no image, no
// SVG, no positioned element (absolute positioning is stripped by Outlook). A
// rectangle needs no radius, so it never had the problem the dot did, and a
// runtime-coloured 2px band is cheaper as a cell than as a third asset.
//
// The connector is omitted on the last step, matching the `.pen`, where only
// "Step Delivered" has no "Line" child.
function StepIndicator({ state, isLast }: { state: StepState; isLast: boolean }) {
  // The connector spans the step above it to the step below, so it is only
  // TRAVELLED once the step above is COMPLETE. Under the active step the journey
  // has not been made yet, so that segment is grey like the ones ahead of it.
  //
  // Colouring it green (which is what the `.pen` appears to draw) put a green
  // run under "Shipped" followed by grey, which read as the line breaking off
  // mid-timeline rather than as progress. Only `done` earns green.
  const lineFill = state === "done" ? theme.successGreen : theme.borderColor;

  // The dot and the connector are two STACKED `Row`s rather than two <tr>s of
  // one hand-written table. Each `Row` is its own <table>, and a table is a
  // block-level box, so they stack in the same order and with the same result —
  // while `align="center"` (already `Row`'s default) centres each one in the
  // 36px indicator column exactly as the single table's own `align` did.
  // `width="auto"` on both: `Row` defaults to `width="100%"`, which would
  // stretch these shrink-to-fit wrappers past the dot and the 2px line.
  return (
    <>
      <Row width="auto" className="border-collapse">
        {/* `leading-[0]` on the cell kills the line box an inline replaced
            element would otherwise sit on, which used to add a few px under
            the dot and push the connector away from it. The dot's own
            `block` display does the rest. */}
        <Column align="center" className="p-0 leading-[0]">
          {/* The whole state distinction now lives in WHICH image is chosen —
              no runtime colour, no border, no radius, so nothing here needs an
              inline `style` at all. That is a direct consequence of the switch:
              the old span carried a computed `backgroundColor` precisely
              because Tailwind cannot compile an interpolated colour class
              (`bg-[${dotFill}]` generates no rule), and picking between three
              static assets sidesteps the problem instead of working around it.

              `width`/`height` come from the asset entry as HTML ATTRIBUTES —
              Outlook sizes images from those and ignores CSS. They are 22px,
              the same diameter the CSS dots had, so the indicator column lines
              up exactly as before.

              `alt` varies by state, so a reader with images off gets
              "Completed"/"In progress"/"Pending" rather than three identical
              strings. The step's own label and date sit beside it either way,
              so the timeline never depends on these images. */}
          <Img
            {...STEP_DOT[state]}
            alt={STEP_DOT_ALT[state]}
            className="block"
          />
        </Column>
      </Row>
      {!isLast && (
        <Row width="auto" className="border-collapse">
          {/* `backgroundColor` is again runtime-derived (green once the step
              above is reached, grey ahead of it), so it stays inline for the
              same reason as the dot.

              The line is drawn by the CELL itself, so it is a `Column`: a
              `Section` would put the width/height/fill on its <table> and leave
              the <td> that actually paints the 2px band unstyled. One `Row` is
              enough here — the extra wrapper table the hand-written version had
              between the outer cell and the line cell carried no styling of its
              own and produced nothing the single Row does not. */}
          <Column
            align="center"
            // Some clients collapse a cell with no content to zero height; the
            // 1px font-size plus the zero-width space below keep the line drawn.
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
    <Section className={`bg-[${TIMELINE_BG}] rounded-[8px] px-[20px] py-[24px] mb-[24px]`}>
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
            <Column className="w-[36px] align-top">
              <StepIndicator state={state} isLast={index === STEPS.length - 1} />
            </Column>
            <Column className="align-top pt-[2px]">
              {/* The `.pen` bolds ONLY the active step's label and mutes the
                  ones not yet reached. `state` is runtime, but it has three
                  known values, so each branch picks a COMPLETE static class —
                  never an interpolated one Tailwind could not compile. */}
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
      {/* "Icon Circle" — the `.pen`'s 64px info-blue disc and the `map-pin`
          glyph inside it are ONE remote PNG, shown at its full 64px.

          THE CSS DISC IS GONE, AND RE-ADDING IT IS A REGRESSION. The file
          already carries the rgb(239,246,255) disc that `bg-info-bg` used to
          paint, so drawing both stacked two identical circles and left only the
          glyph readable, scaled down to the image's display size — 12x14px
          inside a 64px disc, i.e. 19% of it, measured on a rendered screenshot.
          At full size the glyph sits at the ~38% the artwork was drawn at. The
          pixel measurements are in `emails/assets.ts`.

          This also RETIRES a long-standing hazard specific to this template: the
          old cell's class ORDER was load-bearing, because with `bg-info-bg`
          written before `rounded-[32px]` it compiled to no `background-color` at
          all and the disc rendered transparent, silently. There is no fill class
          left to lose, so that failure mode is gone rather than documented.

          `width`/`height` remain HTML ATTRIBUTES (spread from the asset entry):
          Outlook sizes images from the attributes and ignores CSS dimensions,
          and they are what reserves the 64x64 box when a client blocks the
          image, so "Tracking Update" below does not jump upward. The `alt`
          carries the meaning.

          The `Row`/`Column` wrapper stays because it is what CENTRES the image;
          the inner `Row` is `width="auto"` because `Row` defaults to
          `width="100%"` and would stretch this shrink-to-fit wrapper. */}
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

      {/* "Greeting Block". The `.pen`'s literal "Hi {{name}}," / order number are
          template placeholders; the real props fill them. `previousStatus` keeps
          its sentence here so each of the five variants states the transition it
          is actually reporting. */}
      <Text className="mt-[24px] mb-0 mx-0 font-body text-[15px] text-text-primary">
        {greeting(fullName)}
      </Text>
      <Text className="mt-[12px] mb-[24px] mx-0 font-body text-[14px] leading-[1.5] text-text-secondary">
        {heading}: your order {orderId} {body} (previously: {statusLabel(previousStatus)}). Here&apos;s
        the latest on your shipment:
      </Text>

      <StatusTimeline status={status} history={history} />

      {/* STOP POINT — `Hr`'s border colour stays inline; its own default style
          is emitted after Tailwind's classes and would win. See the same note
          in `components/layout.tsx`. */}
      <Hr
        className="mt-0 mb-[24px] mx-0"
        style={{ borderColor: theme.borderColor, borderTopWidth: "1px" }}
      />

      {/* "Shipping Details". Carrier and Ship From are the placeholder constants
          declared above; the other three come from the event, and the two that
          can be missing (estimate, address) omit their ROW rather than printing
          a blank or a wrong value. */}
      <Text className="mt-0 mb-[12px] mx-0 font-body text-[14px] font-semibold text-text-primary">
        Shipment Details
      </Text>
      <DetailRow label="Carrier" value={PLACEHOLDER_CARRIER} />
      <DetailRow label="Tracking Number" value={trackingNumber} />
      {estimate && <DetailRow label="Estimated Delivery" value={estimate} />}
      <DetailRow label="Ship From" value={PLACEHOLDER_SHIP_FROM} />
      {shipTo && <DetailRow label="Ship To" value={shipTo} />}

      {/* "Track Button" — info-blue in this frame, not brand orange, which is
          why `Button` takes an overridable background. No web app exists yet, so
          the href is a placeholder under app.3mrai.com.
          It now carries the `.pen`'s 16px `external-link` icon, white so it
          reads against the filled button. Purely an ENHANCEMENT: with images
          blocked the button still reads "Track Your Shipment". `align="middle"`
          plus the 6px right margin keeps it on the label's baseline — an <Img>
          defaults to `vertical-align: baseline`, which drops it below the text
          in several clients. */}
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
