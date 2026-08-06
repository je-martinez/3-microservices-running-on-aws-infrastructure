import { Button as ReactEmailButton } from "@react-email/components";
import { theme } from "../theme.ts";

// The CTA that repeats across the `.pen` frames ("Dashboard Button", "Track
// Button", …): a filled pill, 6px radius, 14px/40px padding, 15px/600 white
// label. Brand orange is the default; the "Order Created" frame uses info-blue
// for its tracking CTA, which is why `backgroundColor` is overridable.
//
// No web app exists yet, so every `href` is a placeholder under
// `https://app.3mrai.com/…` (see the email-payload-enrichment spec). When the
// frontend ships, only the URLs change.
//
// `Button` from react-email renders an <a> with table-safe padding rather than a
// <button>, which is what survives Outlook.
export function Button({
  href,
  children,
  backgroundColor = theme.brandOrange,
}: {
  href: string;
  children: string;
  backgroundColor?: string;
}) {
  return (
    <ReactEmailButton
      href={href}
      style={{
        backgroundColor,
        borderRadius: "6px",
        color: theme.bgWhite,
        fontFamily: theme.fontBody,
        fontSize: "15px",
        fontWeight: 600,
        textDecoration: "none",
        textAlign: "center",
        padding: "14px 40px",
      }}
    >
      {children}
    </ReactEmailButton>
  );
}
