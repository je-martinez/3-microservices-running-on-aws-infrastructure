import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDateTime,
  formatMonthYear,
  formatPlacedLabel,
  formatShortDateTime,
  INVALID_DATE,
} from './format-date';

/**
 * The per-formatter half of the UTC contract.
 *
 * CONTRACT: The E2E layer cannot carry this alone — its only remaining guard is the
 * notifications panel, covering `formatShortDateTime` and nothing else.
 * CONTRACT: Every expectation is a HARDCODED literal, never computed from
 * `format-date.ts` or `date-fns` — a derived expectation reimplements the bug it
 * exists to catch. See [[testing]]
 */

/**
 * CONTRACT: These cases only mean anything when the process TZ is NOT UTC — at
 * UTC the correct code and unnormalised code print identical strings, and CI boxes
 * commonly run there. `apps/web/package.json`'s `test` script pins the zone.
 *
 * WARNING: That pinning is a bare `TZ=…` prefix, which `cmd.exe` does not honour.
 * On Windows move it to `cross-env`, never delete it — dropping it turns nine
 * assertions here into silent no-ops. See [[testing]]
 */
describe('the test environment itself', () => {
  it('runs in a non-UTC timezone, or these tests prove nothing', () => {
    const offsetMinutes = new Date('2026-08-02T10:24:00Z').getTimezoneOffset();

    expect(
      offsetMinutes,
      'the process is running at UTC+0, where a formatter that ignores the UTC contract ' +
        'renders exactly the same string as one that honours it — pin a non-UTC TZ ' +
        '(vitest.config.ts sets it) or this file is decorative',
    ).not.toBe(0);
  });
});

/**
 * The instant the design frames pair with `Aug 2, 2026 · 10:24 am`. Deliberately
 * mid-morning UTC so that a local-zone regression moves the TIME but not the
 * date — the subtler of the two failure shapes.
 */
const MORNING = '2026-08-02T10:24:00Z';

/**
 * Late-evening UTC, which is the NEXT day east of UTC and the SAME day west of
 * it. A formatter that drops the normalisation prints a different calendar date
 * here, not merely a different clock time.
 */
const LATE_EVENING = '2026-08-02T23:30:00Z';

/** Just past midnight UTC — the mirror case, a day EARLIER west of UTC. */
const JUST_AFTER_MIDNIGHT = '2026-08-02T00:30:00Z';

describe('formatDate', () => {
  it('renders the UTC calendar date', () => {
    expect(formatDate(MORNING)).toBe('Aug 2, 2026');
  });

  it('keeps the UTC date for an instant late in the UTC evening', () => {
    expect(
      formatDate(LATE_EVENING),
      'a viewer east of UTC sees Aug 3 for this instant; the formatter must not',
    ).toBe('Aug 2, 2026');
  });

  it('keeps the UTC date for an instant just after UTC midnight', () => {
    expect(
      formatDate(JUST_AFTER_MIDNIGHT),
      'a viewer west of UTC sees Aug 1 for this instant; the formatter must not',
    ).toBe('Aug 2, 2026');
  });
});

describe('formatDateTime', () => {
  it('renders the UTC wall clock with a lowercase meridiem', () => {
    expect(formatDateTime(MORNING)).toBe('Aug 2, 2026 · 10:24 am');
  });

  it('does not roll the date at a late-evening UTC instant', () => {
    expect(formatDateTime(LATE_EVENING)).toBe('Aug 2, 2026 · 11:30 pm');
  });

  it('renders midnight as 12 am, not 0 am', () => {
    expect(formatDateTime('2026-08-02T00:00:00Z')).toBe('Aug 2, 2026 · 12:00 am');
  });

  it('renders noon as 12 pm, not 0 pm', () => {
    expect(formatDateTime('2026-08-02T12:00:00Z')).toBe('Aug 2, 2026 · 12:00 pm');
  });
});

/**
 * CONTRACT: The year asymmetry between this and `formatDateTime` is the DESIGN,
 * verified against the Pencil exports — the order timeline carries the year, the
 * notification item does not. Collapsing the two formatters breaks one frame or
 * the other. See [[angular-component-authoring]]
 */
describe('formatShortDateTime', () => {
  it('renders the UTC wall clock with no year', () => {
    expect(formatShortDateTime(MORNING)).toBe('Aug 2 · 10:24 am');
  });

  it('matches the instant the E2E notifications assertion pins', () => {
    expect(formatShortDateTime('2026-08-12T14:30:05Z')).toBe('Aug 12 · 2:30 pm');
  });

  it('does not roll the date at a late-evening UTC instant', () => {
    expect(formatShortDateTime(LATE_EVENING)).toBe('Aug 2 · 11:30 pm');
  });
});

describe('formatMonthYear', () => {
  it('renders the UTC month and year', () => {
    expect(formatMonthYear('2026-02-11T15:04:22Z')).toBe('Feb 2026');
  });

  /**
   * The case that makes this formatter worth testing at all: month granularity
   * hides a local-zone regression for all but ~a day per month, which is exactly
   * why the cross-timezone E2E comparison on `Member since` was vacuous. Here the
   * instant is chosen to sit ON the boundary, where the bug is visible.
   */
  it('keeps the UTC month for an instant late on the last day of a month', () => {
    expect(
      formatMonthYear('2026-08-31T23:30:00Z'),
      'a viewer east of UTC sees September for this instant; the formatter must not',
    ).toBe('Aug 2026');
  });

  it('keeps the UTC month for an instant just after the first midnight of a month', () => {
    expect(
      formatMonthYear('2026-09-01T00:30:00Z'),
      'a viewer west of UTC sees August for this instant; the formatter must not',
    ).toBe('Sep 2026');
  });
});

describe('formatPlacedLabel', () => {
  it('singularises a one-item order', () => {
    expect(formatPlacedLabel(MORNING, 1)).toBe('Placed Aug 2, 2026 · 1 item');
  });

  it('pluralises a multi-item order', () => {
    expect(formatPlacedLabel(MORNING, 3)).toBe('Placed Aug 2, 2026 · 3 items');
  });

  /**
   * Zero pluralises. Worth pinning rather than leaving to chance: the `=== 1`
   * check makes this fall out correctly, but the naive `> 1` that replaces it
   * during a refactor renders "0 item".
   */
  it('pluralises a zero-item order', () => {
    expect(formatPlacedLabel(MORNING, 0)).toBe('Placed Aug 2, 2026 · 0 items');
  });
});

/**
 * CONTRACT: `INVALID_DATE` is reachable, not defensive padding. `User.createdAt`
 * and Tracking's `datetime` are bare `string` on the wire with no
 * `format: date-time`, so a malformed value reaches these formatters.
 * See [[openapi-specs]]
 */
describe('an unparseable timestamp', () => {
  const unparseable = ['', 'not a date', '08/02/2026', '2026-13-45T99:99:99Z'];

  for (const value of unparseable) {
    it(`degrades ${JSON.stringify(value)} rather than rendering "Invalid Date"`, () => {
      expect(formatDate(value)).toBe(INVALID_DATE);
      expect(formatDateTime(value)).toBe(INVALID_DATE);
      expect(formatShortDateTime(value)).toBe(INVALID_DATE);
      expect(formatMonthYear(value)).toBe(INVALID_DATE);
    });
  }

  /**
   * The label wraps a degraded date rather than propagating the sentinel alone,
   * so the item count still renders — a support surface that shows "Placed — ·
   * 2 items" is more useful than one that shows only a dash.
   */
  it('still renders the item count in the placed label', () => {
    expect(formatPlacedLabel('not a date', 2)).toBe(`Placed ${INVALID_DATE} · 2 items`);
  });
});
