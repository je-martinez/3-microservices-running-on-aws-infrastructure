import { chromium, type Browser } from "@playwright/test";

/**
 * CONTRACT: These specs are HEADED on purpose. Headless draws overlay
 * scrollbars, so a width-shift regression measures clean — with the gutter
 * removed from `.app-scroll`, headed reads 1440/1425 across two routes and
 * headless 1440/1440. Injecting `::-webkit-scrollbar` does not restore it.
 * CONTRACT: A window steals focus. ASK before running anything that opens one.
 * See [[testing]]
 */
export function launchWebBrowser(): Promise<Browser> {
  // Defaults to the built-in display's origin. `WEB_WINDOW_POSITION` overrides it
  // for a different machine or monitor; origins come from NSScreen and are in
  // points, so they differ per setup.
  const position = process.env.WEB_WINDOW_POSITION ?? "0,0";

  return chromium.launch({
    headless: false,
    args: [`--window-position=${position}`],
  });
}
