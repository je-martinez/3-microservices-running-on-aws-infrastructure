import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SaveErrorBanner } from './save-error-banner';

describe('SaveErrorBanner', () => {
  let fixture: ComponentFixture<SaveErrorBanner>;

  const host = () => fixture.nativeElement as HTMLElement;
  const text = () => host().textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const retryButton = () =>
    Array.from(host().querySelectorAll('button')).find((b) => b.textContent?.includes('Try again')) ?? null;
  const dismissButton = () => host().querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');

  function render(inputs: Record<string, unknown> = {}): void {
    fixture = TestBed.createComponent(SaveErrorBanner);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SaveErrorBanner] });
  });

  it('renders the design copy by default', () => {
    render();

    expect(text()).toContain('Couldn’t save your changes');
    expect(text()).toContain(
      'Something went wrong on our side. Your edits are still here — try again in a moment.',
    );
  });

  it('renders an overridden heading and message', () => {
    render({ heading: 'Couldn’t save your address', message: 'Try again in a moment.' });

    expect(text()).toContain('Couldn’t save your address');
    expect(text()).toContain('Try again in a moment.');
    expect(text()).not.toContain('Couldn’t save your changes');
  });

  /** CONTRACT: The alert is the host element itself, announced on insertion. */
  it('is a single alert on its host element', () => {
    render();

    expect(host().getAttribute('role')).toBe('alert');
    expect(host().querySelectorAll('[role]')).toHaveLength(0);
  });

  it('emits retry from Try again', () => {
    render();
    let retries = 0;
    fixture.componentInstance.retry.subscribe(() => (retries += 1));

    retryButton()?.click();

    expect(retries).toBe(1);
  });

  it('emits dismissed from its X', () => {
    render();
    let dismissals = 0;
    fixture.componentInstance.dismissed.subscribe(() => (dismissals += 1));

    dismissButton()?.click();

    expect(dismissals).toBe(1);
  });

  it('disables Try again and marks it busy only when told to', () => {
    render();
    expect(retryButton()?.disabled).toBe(false);
    expect(retryButton()?.getAttribute('aria-busy')).toBe('false');

    render({ retryDisabled: true, busy: true });
    expect(retryButton()?.disabled).toBe(true);
    expect(retryButton()?.getAttribute('aria-busy')).toBe('true');
  });

  /** CONTRACT: No auto-dismiss — see the class doc. */
  it('never emits dismissed on its own', () => {
    vi.useFakeTimers();
    try {
      render();
      let dismissals = 0;
      fixture.componentInstance.dismissed.subscribe(() => (dismissals += 1));

      vi.advanceTimersByTime(60_000);

      expect(dismissals).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts the given test ids on its buttons, and none by default', () => {
    render();
    expect(retryButton()?.hasAttribute('data-testid')).toBe(false);
    expect(dismissButton()?.hasAttribute('data-testid')).toBe(false);

    render({ retryTestId: 'profile-save-error-retry', dismissTestId: 'profile-save-error-dismiss' });
    expect(retryButton()?.getAttribute('data-testid')).toBe('profile-save-error-retry');
    expect(dismissButton()?.getAttribute('data-testid')).toBe('profile-save-error-dismiss');
  });
});
