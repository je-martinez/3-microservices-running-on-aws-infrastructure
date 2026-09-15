import { Provider } from '@angular/core';
import {
  LucideBell,
  LucidePackage,
  LucidePackageCheck,
  LucidePartyPopper,
  LucideReceiptText,
  LucideTruck,
  LucideWarehouse,
  LucideX,
  provideLucideIcons,
} from '@lucide/angular';

import type { AppNotification } from '../../core/api/types';

/**
 * WHY: LucideDynamicIcon resolves an icon by NAME from the registry, so an
 * unregistered one throws at render and the component dies before a single
 * assertion runs. This mirrors the notification subset app.config.ts registers.
 */
export const NOTIFICATION_TEST_PROVIDERS: Provider[] = [
  provideLucideIcons(
    LucideBell,
    LucidePackage,
    LucidePackageCheck,
    LucidePartyPopper,
    LucideReceiptText,
    LucideTruck,
    LucideWarehouse,
    LucideX,
  ),
];

const OCCURRED_AT = '2026-09-12T06:13:28.395Z';

/**
 * A complete `AppNotification`, overridable per assertion.
 * CONTRACT: `metadata` MERGES rather than replaces — an override naming only
 * `status` still satisfies the required `occurred_at`.
 */
export function notification(
  overrides: Partial<Omit<AppNotification, 'metadata'>> & {
    metadata?: Partial<AppNotification['metadata']>;
  } = {},
): AppNotification {
  const { metadata, ...rest } = overrides;
  return {
    id: 'ntf_1',
    type: 'ORDER_STATUS',
    title: 'Out for delivery',
    body: 'ORD-3MRAI-10482 · Arriving today, by 6:00 pm.',
    readAt: null,
    createdAt: '2026-09-12T06:13:28.400Z',
    ...rest,
    metadata: { occurred_at: OCCURRED_AT, ...metadata },
  };
}
