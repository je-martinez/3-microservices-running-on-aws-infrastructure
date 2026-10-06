import { ComponentFixture, TestBed } from '@angular/core/testing';

import { SAVED_BANNER_DISMISS_MS, SavedBanner } from './saved-banner';

describe('SavedBanner', () => {
  let fixture: ComponentFixture<SavedBanner>;
  let dismissals: number;

  const host = () => fixture.nativeElement as HTMLElement;
  const dismissButton = () => host().querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
  const text = () => host().textContent?.replace(/\s+/g, ' ').trim() ?? '';

  function render(inputs: Record<string, unknown> = {}): void {
    fixture = TestBed.createComponent(SavedBanner);
    for (const [name, value] of Object.entries(inputs)) fixture.componentRef.setInput(name, value);
    dismissals = 0;
    fixture.componentInstance.dismissed.subscribe(() => (dismissals += 1));
    fixture.detectChanges();
  }

  function elapse(ms: number): void {
    vi.advanceTimersByTime(ms);
  }

  // WHY: Fake timers go in BEFORE creation, so the countdown armed on the
  // first render is faked too.
  beforeEach(() => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({ imports: [SavedBanner] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders the design copy by default', () => {
    render();

    expect(text()).toContain('Changes saved');
    expect(text()).toContain('Your personal details are up to date.');
  });

  it('renders an overridden heading and message', () => {
    render({ heading: 'Address saved', message: 'Checkout will use it next time.' });

    expect(text()).toContain('Address saved');
    expect(text()).toContain('Checkout will use it next time.');
    expect(text()).not.toContain('Changes saved');
  });

  /** CONTRACT: The live region belongs to the host — see the class doc. */
  it('carries no live-region role of its own', () => {
    render();

    expect(host().querySelector('[role]')).toBeNull();
    expect(host().getAttribute('role')).toBeNull();
  });

  it('puts the given test id on its dismiss button, and none by default', () => {
    render();
    expect(dismissButton()?.hasAttribute('data-testid')).toBe(false);

    fixture.componentRef.setInput('dismissTestId', 'profile-saved-banner-dismiss');
    fixture.detectChanges();
    expect(dismissButton()?.getAttribute('data-testid')).toBe('profile-saved-banner-dismiss');
  });

  it('emits dismissed on the X, leaving no countdown to emit again', () => {
    render();
    elapse(4000);

    dismissButton()?.click();
    expect(dismissals).toBe(1);

    elapse(SAVED_BANNER_DISMISS_MS * 2);
    expect(dismissals).toBe(1);
  });

  it('emits dismissed after SAVED_BANNER_DISMISS_MS and not before', () => {
    render();

    elapse(SAVED_BANNER_DISMISS_MS - 1);
    expect(dismissals).toBe(0);

    elapse(1);
    expect(dismissals).toBe(1);
  });

  it('pauses while hovered and resumes with the remaining time on leave', () => {
    render();

    elapse(2000);
    host().dispatchEvent(new MouseEvent('mouseenter'));
    elapse(SAVED_BANNER_DISMISS_MS * 3);
    expect(dismissals).toBe(0);

    host().dispatchEvent(new MouseEvent('mouseleave'));
    elapse(SAVED_BANNER_DISMISS_MS - 2000 - 1);
    expect(dismissals).toBe(0);
    elapse(1);
    expect(dismissals).toBe(1);
  });

  it('pauses while it holds keyboard focus, even after the pointer leaves', () => {
    render();

    host().dispatchEvent(new MouseEvent('mouseenter'));
    host().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    host().dispatchEvent(new MouseEvent('mouseleave'));
    elapse(SAVED_BANNER_DISMISS_MS * 3);
    expect(dismissals).toBe(0);

    host().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    elapse(SAVED_BANNER_DISMISS_MS);
    expect(dismissals).toBe(1);
  });

  it('stays paused while focus moves between elements inside it', () => {
    render();
    const inner = document.createElement('span');
    host().appendChild(inner);

    host().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    host().dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: inner }));
    elapse(SAVED_BANNER_DISMISS_MS * 3);

    expect(dismissals).toBe(0);
  });

  it('restarts the full countdown when restartKey changes', () => {
    render({ restartKey: 1 });

    elapse(4000);
    fixture.componentRef.setInput('restartKey', 2);
    fixture.detectChanges();

    elapse(SAVED_BANNER_DISMISS_MS - 1);
    expect(dismissals).toBe(0);
    elapse(1);
    expect(dismissals).toBe(1);
  });

  it('clears the countdown when destroyed', () => {
    const armed = vi.spyOn(globalThis, 'setTimeout');
    render();
    const call = armed.mock.calls.findIndex(([, ms]) => ms === SAVED_BANNER_DISMISS_MS);
    expect(call).toBeGreaterThanOrEqual(0);
    const handle = armed.mock.results[call]?.value as unknown;
    const cleared = vi.spyOn(globalThis, 'clearTimeout');

    fixture.destroy();

    expect(cleared).toHaveBeenCalledWith(handle);
    elapse(SAVED_BANNER_DISMISS_MS);
    expect(dismissals).toBe(0);
  });
});
