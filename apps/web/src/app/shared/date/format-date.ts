import { addMinutes, format, isValid, parseISO } from 'date-fns';

/**
 * The one place this app turns a wire timestamp into a display string.
 *
 * CONTRACT: Render every timestamp in UTC, never the viewer's local zone. The
 * frames pair `2026-08-02T10:24:00Z` with `Aug 2, 2026 · 10:24 am`; local
 * rendering shows `4:24 am` from UTC-6, so the app disagrees with its own design
 * for nearly every reader and E2E assertions flake on the CI machine's `TZ`.
 * See [[angular-component-authoring]]
 */

/**
 * Rendered in place of a timestamp that cannot be parsed.
 * CONTRACT: Do NOT drop this as defensive padding — it is reachable.
 * `User.createdAt` and Tracking's `datetime` are bare `string` on the wire with no
 * `format: date-time`, so a malformed value prints `Invalid Date` at the reader.
 * See [[openapi-specs]]
 */
export const INVALID_DATE = '—';

/**
 * Parse a wire timestamp, returning `null` rather than an `Invalid Date`.
 * WHY: `parseISO` over `new Date(...)`, whose fallback parsing reads
 * `"08/02/2026"` differently per browser instead of failing.
 */
function parseWireDate(iso: string): Date | null {
  const parsed = parseISO(iso);
  return isValid(parsed) ? parsed : null;
}

/**
 * Shift an instant so local-time getters format its UTC wall clock.
 * WHY: The offset is read FROM the instant, carrying that date's DST state,
 * so no `@date-fns/tz` dependency is needed.
 */
function toUtcWallClock(date: Date): Date {
  return addMinutes(date, date.getTimezoneOffset());
}

function formatUtc(iso: string, pattern: string): string {
  const parsed = parseWireDate(iso);
  return parsed ? format(toUtcWallClock(parsed), pattern) : INVALID_DATE;
}

export function formatDate(iso: string): string {
  return formatUtc(iso, 'MMM d, yyyy');
}

/** `Aug 2, 2026 · 10:24 am` — `Orders — Detail` rows; `aaa` is lowercase am/pm. */
export function formatDateTime(iso: string): string {
  return formatUtc(iso, 'MMM d, yyyy · h:mm aaa');
}

/**
 * `Aug 3 · 8:15 am` — `Notification Item` (`qwO6X`), `Toast` (`jYz4h`).
 * CONTRACT: Do NOT collapse this into `formatDateTime`. Those frames disagree
 * on the year; merging breaks one or the other.
 * See [[angular-component-authoring]]
 */
export function formatShortDateTime(iso: string): string {
  return formatUtc(iso, 'MMM d · h:mm aaa');
}

export function formatMonthYear(iso: string): string {
  return formatUtc(iso, 'MMM yyyy');
}

/**
 * `Placed Aug 2, 2026 · 3 items` — the order summary line.
 * CONTRACT: `OrderCard` and `OrderDetailPage` call this rather than rebuilding
 * it; their own copies drifted on item-count coercion.
 * See [[angular-component-authoring]]
 */
export function formatPlacedLabel(iso: string, itemCount: number): string {
  return `Placed ${formatDate(iso)} · ${itemCount} item${itemCount === 1 ? '' : 's'}`;
}
