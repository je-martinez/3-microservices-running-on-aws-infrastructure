import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ToastNotification } from './toast-notification';
import { TOAST_DISMISS_MS } from '../../core/notifications/toast-queue';
import { NOTIFICATION_TEST_PROVIDERS, notification } from '../testing/notification-fixtures';

function render(
  overrides: Parameters<typeof notification>[0] = {},
): ComponentFixture<ToastNotification> {
  const fixture = TestBed.createComponent(ToastNotification);
  fixture.componentRef.setInput('notification', notification(overrides));
  fixture.detectChanges();
  return fixture;
}

function root(fixture: ComponentFixture<ToastNotification>): HTMLElement {
  return fixture.nativeElement as HTMLElement;
}

function query<T extends HTMLElement>(
  fixture: ComponentFixture<ToastNotification>,
  testId: string,
): T {
  const element = root(fixture).querySelector<T>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`No element with data-testid="${testId}"`);
  return element;
}

function textOfTestId(fixture: ComponentFixture<ToastNotification>, testId: string): string {
  return query(fixture, testId).textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

/** Collects every value emitted by an output, in order. */
function record<T>(emitter: { subscribe: (fn: (value: T) => void) => unknown }): T[] {
  const seen: T[] = [];
  emitter.subscribe((value) => seen.push(value));
  return seen;
}

describe('ToastNotification', () => {
  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [...NOTIFICATION_TEST_PROVIDERS] });
    await TestBed.compileComponents();
  });

  afterEach(() => TestBed.resetTestingModule());

  it('renders the ORDER UPDATE eyebrow and the View order CTA for a tracking row', () => {
    const fixture = render({ type: 'ORDER_STATUS' });

    expect(textOfTestId(fixture, 'toast-eyebrow')).toBe('ORDER UPDATE');
    expect(textOfTestId(fixture, 'toast-cta')).toBe('View order');
  });

  it('renders the WELCOME eyebrow and the profile CTA for a welcome row', () => {
    const fixture = render({ type: 'WELCOME', metadata: { status: undefined } });

    expect(textOfTestId(fixture, 'toast-eyebrow')).toBe('WELCOME');
    expect(textOfTestId(fixture, 'toast-cta')).toBe('View my profile');
  });

  /**
   * CONTRACT: Read the duration from the CONSTANT, never a literal 7000. The bar
   * IS the visible countdown, so a test pinned to a number lets the constant
   * change while the bar keeps lying about the time left.
   */
  it('drives the progress bar from TOAST_DISMISS_MS', () => {
    const fixture = render();

    expect(query(fixture, 'toast-progress').style.animationDuration).toBe(`${TOAST_DISMISS_MS}ms`);
  });

  it('pauses on hover and resumes on leave', () => {
    const fixture = render();
    const paused = record<boolean>(fixture.componentInstance.paused);
    const toast = query(fixture, 'toast');

    toast.dispatchEvent(new Event('mouseenter'));
    toast.dispatchEvent(new Event('mouseleave'));

    expect(paused).toEqual([true, false]);
  });

  /**
   * CONTRACT: focus-within pauses too. A toast reached by keyboard must not
   * vanish while it holds focus, which hover alone never covers.
   */
  it('pauses while it holds keyboard focus', () => {
    const fixture = render();
    const paused = record<boolean>(fixture.componentInstance.paused);
    const toast = query(fixture, 'toast');

    toast.dispatchEvent(new Event('focusin', { bubbles: true }));

    expect(paused).toEqual([true]);
  });

  /**
   * CONTRACT: Dismissing is NOT reading. The unread dot survives in the panel,
   * so this component emits no read-marking output at all.
   */
  it('emits dismissed from the close button and nothing else', () => {
    const fixture = render();
    const dismissed = record<void>(fixture.componentInstance.dismissed);
    const viewOrder = record<void>(fixture.componentInstance.viewOrder);

    query(fixture, 'toast-close').click();

    expect(dismissed.length).toBe(1);
    expect(viewOrder.length).toBe(0);
    expect(Object.keys(fixture.componentInstance)).not.toContain('markRead');
  });

  it('emits viewOrder from the CTA', () => {
    const fixture = render();
    const viewOrder = record<void>(fixture.componentInstance.viewOrder);
    const dismissed = record<void>(fixture.componentInstance.dismissed);

    query(fixture, 'toast-cta').click();

    expect(viewOrder.length).toBe(1);
    expect(dismissed.length).toBe(0);
  });
});
