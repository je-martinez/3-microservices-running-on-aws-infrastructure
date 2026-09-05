/**
 * The web suite runs TWICE, once per pinned browser timezone.
 *
 * CONTRACT: Neither zone is UTC. `format-date.ts` normalises every timestamp to
 * UTC, so a regression to viewer-local rendering is INVISIBLE on a UTC box —
 * the wrong code and the right code print the same string. Two non-UTC zones
 * nine hours apart make the same instant render identically only if the
 * normalisation holds. See [[testing]]
 */
export const WEB_TIMEZONES = {
  // UTC+9, no DST. The zone that catches a DATE roll: an 18:22Z instant reads
  // Aug 16 here and still Aug 15 at UTC-6, so this project alone fails the
  // order-card assertion when normalisation breaks. Verified by mutation.
  "web-tokyo": "Asia/Tokyo",
  // UTC-6, no DST — the zone the original local-time bug was reported from.
  "web-tegucigalpa": "America/Tegucigalpa",
} as const;

export type WebProjectName = keyof typeof WEB_TIMEZONES;

export const WEB_PROJECT_NAMES = Object.keys(WEB_TIMEZONES) as WebProjectName[];

/**
 * CONTRACT: `global-setup.ts` skips the backend health checks only when EVERY
 * selected project is one of these. Reading the list from here rather than
 * hardcoding "web" is what keeps a `--project=web-tokyo` run from dying on a
 * Users health check the web app never calls. See [[testing]]
 */
export function isWebProject(name: string): boolean {
  return Object.hasOwn(WEB_TIMEZONES, name);
}
