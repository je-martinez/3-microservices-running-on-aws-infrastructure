import { Button as ReactEmailButton } from "@react-email/components";
import type { ReactNode } from "react";
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
//
// `children` is `ReactNode`, not `string`, because the `.pen`'s CTA pattern is
// "optional 16x16 icon + 15px bold white label" (see DESIGN.md § CTA Button) and
// the order/tracking CTAs now put a base64 `<Img>` beside their text. The label
// must ALWAYS be able to stand alone: the icon is an enhancement that ~20% of
// recipients never see (see `icons.generated.ts`), so no button may rely on it
// to be readable.
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
