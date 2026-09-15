import { ComponentFixture, TestBed } from '@angular/core/testing';

import { NotificationItem } from './notification-item';
import { NOTIFICATION_TEST_PROVIDERS, notification } from '../testing/notification-fixtures';

function render(
  overrides: Parameters<typeof notification>[0] = {},
  highlighted = false,
): ComponentFixture<NotificationItem> {
  const fixture = TestBed.createComponent(NotificationItem);
  fixture.componentRef.setInput('notification', notification(overrides));
  fixture.componentRef.setInput('highlighted', highlighted);
  fixture.detectChanges();
  return fixture;
}

function root(fixture: ComponentFixture<NotificationItem>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

/** The bubble is the only element carrying a `rounded-full` tint plus a glyph. */
function bubble(fixture: ComponentFixture<NotificationItem>): HTMLElement {
  const element = root(fixture).querySelector<HTMLElement>('[data-testid="icon-bubble"]');
  if (!element) throw new Error('No icon bubble rendered');
  return element;
}

function glyph(fixture: ComponentFixture<NotificationItem>): SVGElement {
  const element = bubble(fixture).querySelector('svg');
  if (!element) throw new Error('Icon bubble renders no glyph');
  return element;
}

/**
 * CONTRACT: Assert the `lucide-<name>` class the library actually emits. It
 * writes NO `data-icon`/`data-lucide-name` attribute, so an attribute-based
 * assertion reads null and a `.not.toBe(...)` on it passes vacuously.
 */
function iconName(fixture: ComponentFixture<NotificationItem>): string | undefined {
  return Array.from(glyph(fixture).classList)
    .find((name) => name.startsWith('lucide-'))
    ?.slice('lucide-'.length);
}

function dot(fixture: ComponentFixture<NotificationItem>): HTMLElement | null {
  return root(fixture).querySelector<HTMLElement>('[data-testid="unread-dot"]');
}

function row(fixture: ComponentFixture<NotificationItem>): HTMLElement {
  const element = root(fixture).querySelector<HTMLElement>('[data-testid="notification-row"]');
  if (!element) throw new Error('No row rendered');
  return element;
}

describe('NotificationItem', () => {
  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [...NOTIFICATION_TEST_PROVIDERS] });
    await TestBed.compileComponents();
  });

  afterEach(() => TestBed.resetTestingModule());

  /**
   * The six rows of the phase's visual table. PLACED is reached through
   * `metadata.status` exactly like the four tracking-written ones — the web
   * never sees which event produced the row.
   */
  const VARIANTS = [
    {
      name: 'WELCOME',
      overrides: { type: 'WELCOME' as const, metadata: { status: undefined } },
      icon: 'party-popper',
      bubble: 'bg-brand-navy-light',
      iconColor: 'text-brand-navy',
    },
    {
      name: 'PLACED',
      overrides: { metadata: { status: 'PLACED' as const } },
      icon: 'receipt-text',
      bubble: 'bg-neutral-bg',
      iconColor: 'text-ink-secondary',
    },
    {
      name: 'PROCESSING',
      overrides: { metadata: { status: 'PROCESSING' as const } },
      icon: 'package',
      bubble: 'bg-warn-bg',
      iconColor: 'text-warn-ink',
    },
    {
      name: 'SHIPPED',
      overrides: { metadata: { status: 'SHIPPED' as const } },
      icon: 'warehouse',
      bubble: 'bg-info-bg',
      iconColor: 'text-info-blue',
    },
    {
      name: 'OUT_FOR_DELIVERY',
      overrides: { metadata: { status: 'OUT_FOR_DELIVERY' as const } },
      icon: 'truck',
      bubble: 'bg-brand-orange-light',
      iconColor: 'text-brand-orange-text',
    },
    {
      name: 'DELIVERED',
      overrides: { metadata: { status: 'DELIVERED' as const } },
      icon: 'package-check',
      bubble: 'bg-success-bg',
      iconColor: 'text-success-ink',
    },
  ];

  for (const variant of VARIANTS) {
    it(`renders the ${variant.name} icon, bubble tint and glyph colour`, () => {
      const fixture = render(variant.overrides);

      expect(iconName(fixture)).toBe(variant.icon);
      expect(bubble(fixture).classList).toContain(variant.bubble);
      expect(glyph(fixture).classList).toContain(variant.iconColor);
    });
  }

  it('shows the unread dot and the subtle background while readAt is null', () => {
    const fixture = render({ readAt: null });

    expect(dot(fixture)).not.toBeNull();
    expect(row(fixture).classList).toContain('bg-surface-subtle');
  });

  it('drops the dot and the background once readAt is set', () => {
    const fixture = render({ readAt: '2026-09-12T08:00:00Z' });

    expect(dot(fixture)).toBeNull();
    expect(row(fixture).classList).not.toContain('bg-surface-subtle');
  });

  /**
   * CONTRACT: The arrival highlight survives the PATCH that marks the row read.
   * Without it, entering the All screen wipes every dot mid-render and the
   * reader never sees what arrived. See [[2026-09-10-in-app-notifications-design]]
   */
  it('keeps the dot and the background when highlighted, even once read', () => {
    const fixture = render({ readAt: '2026-09-12T08:00:00Z' }, true);

    expect(dot(fixture)).not.toBeNull();
    expect(row(fixture).classList).toContain('bg-surface-subtle');
  });

  it('renders a WELCOME row that carries no status', () => {
    const fixture = render({
      type: 'WELCOME',
      metadata: { status: undefined },
      title: 'Welcome to 3MRAI!',
    });

    expect(root(fixture).textContent).toContain('Welcome to 3MRAI!');
    expect(iconName(fixture)).toBe('party-popper');
  });

  /**
   * CONTRACT: A status this build does not know renders a bell rather than an
   * empty bubble — a new server variant reaching an un-redeployed client.
   */
  it('falls back to a bell glyph and a neutral tint for an unknown status', () => {
    const fixture = render({
      metadata: { status: 'RETURNED' as unknown as 'PLACED' },
    });

    expect(iconName(fixture)).toBe('bell');
    expect(bubble(fixture).classList).toContain('bg-neutral-bg');
  });

  it('renders the timestamp through formatShortDateTime', () => {
    const fixture = render({ createdAt: '2026-08-03T08:15:00Z' });

    expect(root(fixture).textContent).toContain('Aug 3 · 8:15 am');
  });
});
