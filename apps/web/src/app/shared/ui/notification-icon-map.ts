import type { AppNotification } from '../../core/api/types';

/**
 * CONTRACT: Presentation runs on TWO axes, deliberately not flattened into one
 * enum: `type` picks the toast eyebrow and CTA, `metadata.status` picks the icon
 * and tint. Flattening needs a variant per combination and makes an ORDER_STATUS
 * carrying no status yet unrepresentable.
 * See [[2026-09-10-in-app-notifications-design]]
 */
export interface NotificationVisual {
  /** A lucide icon name, resolved by LucideDynamicIcon from the registry. */
  icon: string;
  /** The bubble tint utility. */
  bubble: string;
  /** The glyph colour utility. */
  iconColor: string;
}

/**
 * CONTRACT: Every value here is a NAMED token utility. A hard-coded hex is the
 * detectable symptom of a skipped token step, and `bg-brand-navy-light` /
 * `bg-neutral-bg` exist only because they were added to the `.pen` first.
 * See [[pencil-design-extraction]]
 */
// Keyed by the STORED metadata.status, five wide. Which producer wrote a row is
// not a presentation concern: a PLACED row renders exactly like the four written
// from tracking transitions.
const BY_STATUS: Readonly<Record<string, NotificationVisual>> = {
  PLACED: { icon: 'receipt-text', bubble: 'bg-neutral-bg', iconColor: 'text-ink-secondary' },
  PROCESSING: { icon: 'package', bubble: 'bg-warn-bg', iconColor: 'text-warn-ink' },
  SHIPPED: { icon: 'warehouse', bubble: 'bg-info-bg', iconColor: 'text-info-blue' },
  OUT_FOR_DELIVERY: {
    icon: 'truck',
    bubble: 'bg-brand-orange-light',
    iconColor: 'text-brand-orange-text',
  },
  DELIVERED: { icon: 'package-check', bubble: 'bg-success-bg', iconColor: 'text-success-ink' },
};

const WELCOME: NotificationVisual = {
  icon: 'party-popper',
  bubble: 'bg-brand-navy-light',
  iconColor: 'text-brand-navy',
};

/**
 * CONTRACT: A status this build does not know renders a plain bell, never an
 * empty bubble. A new server variant reaches the client before the client is
 * redeployed, and a missing key would otherwise render a glyph-less circle.
 */
const FALLBACK: NotificationVisual = {
  icon: 'bell',
  bubble: 'bg-neutral-bg',
  iconColor: 'text-ink-secondary',
};

export function visualFor(notification: AppNotification): NotificationVisual {
  if (notification.type === 'WELCOME') return WELCOME;
  const status = notification.metadata.status;
  return (status && BY_STATUS[status]) || FALLBACK;
}
