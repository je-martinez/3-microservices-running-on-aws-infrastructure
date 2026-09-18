import { differenceInCalendarDays, differenceInMinutes } from 'date-fns';

import type { AppNotification } from '../../core/api/types';
import { formatShortDateTime, formatUtcTime, parseUtcWallClock } from '../../shared/date/format-date';

export type GroupLabel = 'TODAY' | 'YESTERDAY' | 'EARLIER';

export interface NotificationGroup {
  label: GroupLabel;
  rows: readonly GroupedNotification[];
}

export interface GroupedNotification {
  notification: AppNotification;
  /** The per-group time format the frames use, already rendered. */
  time: string;
}

/** Below this, the frames read "N min ago" instead of a clock time. */
const RELATIVE_MINUTES = 60;

/**
 * CONTRACT: Compare in UTC WALL CLOCK, not local time. Every timestamp in this
 * app renders in UTC, so grouping by the viewer's local calendar day puts a row
 * under YESTERDAY while its own label still reads today's date.
 * See [[angular-component-authoring]]
 */
function groupOf(createdAt: Date, now: Date): GroupLabel {
  const days = differenceInCalendarDays(now, createdAt);
  if (days <= 0) return 'TODAY';
  if (days === 1) return 'YESTERDAY';
  return 'EARLIER';
}

/**
 * The time format per group: relative within the hour, a bare clock for the rest
 * of today and yesterday, and the dated form for EARLIER.
 */
function timeOf(iso: string, createdAt: Date, now: Date, label: GroupLabel): string {
  if (label === 'EARLIER') return formatShortDateTime(iso);

  const minutes = differenceInMinutes(now, createdAt);
  if (label === 'TODAY' && minutes >= 0 && minutes < RELATIVE_MINUTES) {
    return `${minutes} min ago`;
  }
  return formatUtcTime(iso);
}

/**
 * Buckets rows into TODAY / YESTERDAY / EARLIER, newest group first.
 *
 * CONTRACT: Derived ENTIRELY from `createdAt`. A server-sent group would let the
 * bucket disagree with the timestamp beside it once a page sits open past
 * midnight. See [[2026-09-10-in-app-notifications-design]]
 */
export function groupByDay(
  notifications: readonly AppNotification[],
  now: Date,
): readonly NotificationGroup[] {
  const buckets = new Map<GroupLabel, GroupedNotification[]>();

  for (const notification of notifications) {
    const createdAt = parseUtcWallClock(notification.createdAt);
    // An unparseable timestamp cannot be bucketed; EARLIER renders it with the
    // shared invalid-date marker rather than dropping the row.
    const label = createdAt === null ? 'EARLIER' : groupOf(createdAt, now);
    const time =
      createdAt === null
        ? formatShortDateTime(notification.createdAt)
        : timeOf(notification.createdAt, createdAt, now, label);

    const rows = buckets.get(label) ?? [];
    rows.push({ notification, time });
    buckets.set(label, rows);
  }

  const order: GroupLabel[] = ['TODAY', 'YESTERDAY', 'EARLIER'];
  return order
    .filter((label) => buckets.has(label))
    .map((label) => ({ label, rows: buckets.get(label) ?? [] }));
}
