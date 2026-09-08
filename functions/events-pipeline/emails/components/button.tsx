import { Button as ReactEmailButton } from "@react-email/components";
import type { ReactNode } from "react";
import { theme } from "../theme.ts";

// The CTA repeated across the `.pen` frames: a filled pill with a white label,
// brand orange by default and overridable for the tracking CTA. react-email's
// `Button` renders an <a> with table-safe padding, which is what survives
// Outlook.
// CONTRACT: The text label must ALWAYS stand alone. `children` is `ReactNode` so
// a CTA can add a remote icon, but a reader with images off never sees it, so no
// button may depend on the icon to be readable.
// See [[email-templates]]
export function Button({
  href,
  children,
  backgroundColor = theme.brandOrange,
}: {
  href: string;
  children: ReactNode;
  backgroundColor?: string;
}) {
  return (
    <ReactEmailButton
      href={href}
      className="rounded-[6px] text-bg-white font-body text-[15px] font-semibold no-underline text-center px-[40px] py-[14px]"
      // STOP POINT — `backgroundColor` stays inline. It is a runtime PROP (brand
      // orange by default, info-blue for the tracking CTAs), so there is no
      // static class Tailwind could compile it from. Everything that is fixed
      // for every button moved to `className` above.
      style={{ backgroundColor }}
    >
      {children}
    </ReactEmailButton>
  );
}
