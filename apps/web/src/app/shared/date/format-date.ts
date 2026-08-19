import { addMinutes, format, isValid, parseISO } from 'date-fns';

/**
 * The one place this app turns a wire timestamp into a display string.
 *
 * Before this module, five call sites each built their own `new Date(...)`
 * and passed their own `toLocaleDateString` options object, which produced
 * three separate defects (all reproduced and fixed here):
 *
 *   1. The date-time format did not match the design. The frames show
 *      `Aug 2, 2026 · 10:24 am`; the code emitted `Aug 2, 4:24 AM` — no
 *      year, `,` instead of the design's `·`, and uppercase AM/PM.
 *   2. Every timestamp rendered in the VIEWER's timezone (see below).
 *   3. An unparseable string rendered the literal text `Invalid Date` on
 *      screen, which both contracts make reachable (see `INVALID_DATE`).
 *
 * ## Why UTC, not the viewer's local time
 *
 * Every timestamp these screens show is an ISO-8601 instant with an
 * explicit `Z` — an ORDER-HISTORY fact ("payment confirmed at 16:12"),
 * not an appointment the reader is about to keep. Three reasons UTC wins
 * for this app specifically:
 *
 *   - **The design fixes the expected output.** The frames pair
 *     `2026-08-02T10:24:00Z` with `Aug 2, 2026 · 10:24 am`. Local
 *     rendering only reproduces that for a viewer sitting in UTC; from
 *     this machine (UTC-6) the same instant read `4:24 am`, so the app
 *     silently disagreed with its own design for nearly every reader.
 *   - **It is stable and comparable.** A tracking timeline whose steps
 *     shift by the reader's travel is harder to reason about, and the
 *     same order read from two timezones would show two histories.
 *   - **It is deterministic to test.** A local-time assertion in the E2E
 *     suite passes or fails by the CI machine's `TZ`, which is exactly
 *     the class of flake worth designing out up front.
 *
 * This is a deliberate phase-1 choice, not an accident. If phase 2 decides
 * users should see their own timezone, that is a one-line change to
 * `toUtcWallClock` below plus a decision about WHOSE zone (the browser's
 * or the profile's) — the call sites do not change.
 *
 * The shift is done by adding the instant's own offset rather than pulling
 * in `@date-fns/tz`: `getTimezoneOffset()` is read FROM the instant, so it
 * carries that date's DST state and stays correct across the boundary.
 */

/**
 * Rendered in place of a timestamp that cannot be parsed.
 *
 * This is reachable, not defensive padding: `User.createdAt` is a bare
 * `string` with no `format: date-time` in `services/users/openapi.yaml`,
 * and Tracking's `datetime` is likewise an unformatted string documented
 * as ISO-8601 only in prose. Nothing on the wire enforces either, so a
 * malformed value is a contract-shaped possibility. An em dash degrades
 * the row quietly instead of printing `Invalid Date` at the reader.
 */
export const INVALID_DATE = '—';

/**
 * Parse a wire timestamp, returning `null` rather than an `Invalid Date`.
 *
 * `parseISO` is used over `new Date(...)` on purpose: `new Date()` falls
 * back to implementation-defined parsing for non-ISO input, so a value
 * like `"08/02/2026"` parses differently per browser instead of failing.
 */
function parseWireDate(iso: string): Date | null {
  const parsed = parseISO(iso);
  return isValid(parsed) ? parsed : null;
}

/**
 * Shift an instant so that formatting it with local-time getters yields
 * its UTC wall clock. See the UTC rationale in this file's header.
 */
function toUtcWallClock(date: Date): Date {
  return addMinutes(date, date.getTimezoneOffset());
}

/** Format a parsed instant as its UTC wall clock, or `INVALID_DATE`. */
function formatUtc(iso: string, pattern: string): string {
  const parsed = parseWireDate(iso);
  return parsed ? format(toUtcWallClock(parsed), pattern) : INVALID_DATE;
}

/**
 * `Aug 2, 2026` — a calendar day with its year.
 *
 * Design: the `Placed …` line on `Order Card` (`l6TyrG` / `tWTSZ`) and on
 * `Orders — Detail` (`x7ABM` / `eq3Tk`), both of which read
 * `Placed Aug 2, 2026 · 3 items`.
 */
export function formatDate(iso: string): string {
  return formatUtc(iso, 'MMM d, yyyy');
}

/**
 * `Aug 2, 2026 · 10:24 am` — a day and time of day.
 *
 * Design: the tracking-timeline rows on `Orders — Detail`, which read
 * `Aug 2, 2026 · 10:24 am` and `Aug 2, 2026 · 4:40 pm · Payment confirmed`.
 * `aaa` gives the design's lowercase `am`/`pm`; the JS default `AM`/`PM`
 * (and `,` as the separator) is what the hand-rolled version emitted.
 */
export function formatDateTime(iso: string): string {
  return formatUtc(iso, 'MMM d, yyyy · h:mm aaa');
}

/**
 * `Aug 3 · 8:15 am` — a day and time WITHOUT the year.
 *
 * Design: `Notification Item` (`qwO6X`) and `Toast Notification`
 * (`jYz4h`), whose rows read `Aug 3 · 8:15 am` and `Jul 29 · 9:02 am`.
 *
 * This is deliberately NOT the same helper as `formatDateTime`: the two
 * frames disagree on the year, and a notification list is a "recent
 * activity" surface where the year is noise. Collapsing them into one
 * format would break one frame or the other.
 */
export function formatShortDateTime(iso: string): string {
  return formatUtc(iso, 'MMM d · h:mm aaa');
}

/**
 * `Aug 2026` — a month and year.
 *
 * Design: `Profile` (`hZ87b` / `nyVEI`), which reads `Member since Aug 2026`.
 */
export function formatMonthYear(iso: string): string {
  return formatUtc(iso, 'MMM yyyy');
}

/**
 * `Placed Aug 2, 2026 · 3 items` — the order summary line.
 *
 * Lives here because `OrderCard` and `OrderDetailPage` each built this
 * exact string from their own copy of the logic, and the two had already
 * drifted apart in how they coerced the line count. One function keeps
 * the pluralisation and the `·` separator in a single place.
 *
 * An unparseable date degrades to `Placed — · 3 items` rather than
 * dropping the item count, which is the part still worth showing.
 */
export function formatPlacedLabel(iso: string, itemCount: number): string {
  return `Placed ${formatDate(iso)} · ${itemCount} item${itemCount === 1 ? '' : 's'}`;
}
