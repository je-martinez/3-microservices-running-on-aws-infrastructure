import { ComponentRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LiveSessionChip } from './live-session-chip';
import type { LiveSessionState } from '../../core/notifications/notifications-socket';

describe('LiveSessionChip', () => {
  let fixture: ComponentFixture<LiveSessionChip>;
  let ref: ComponentRef<LiveSessionChip>;

  const render = (state: LiveSessionState) => {
    ref.setInput('state', state);
    fixture.detectChanges();
  };

  const host = () => fixture.nativeElement as HTMLElement;
  const chip = () => host().querySelector('button') as HTMLButtonElement;
  const retry = () =>
    [...host().querySelectorAll('button')].find((b) => b.textContent?.includes('Retry')) ?? null;
  const card = () => host().querySelector('[role="tooltip"]');
  const hover = (over: boolean) => {
    chip().dispatchEvent(new Event(over ? 'mouseenter' : 'mouseleave'));
    fixture.detectChanges();
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LiveSessionChip] });
    fixture = TestBed.createComponent(LiveSessionChip);
    ref = fixture.componentRef;
    render('live');
  });

  it('labels each state distinctly', () => {
    const labels = (['connecting', 'live', 'reconnecting', 'offline'] as const).map((state) => {
      render(state);
      return chip().textContent?.trim() ?? '';
    });

    expect(labels).toEqual([
      'Connecting…',
      'Live updates ON',
      'Reconnecting…',
      'Live updates OFF',
    ]);
  });

  it('tints the chip per state', () => {
    render('live');
    expect(chip().className).toContain('bg-success-bg');

    render('reconnecting');
    expect(chip().className).toContain('bg-warn-bg');

    render('offline');
    expect(chip().className).toContain('bg-neutral-bg');
  });

  /**
   * CONTRACT: Retry shows on `offline` ALONE. On `reconnecting` an attempt is
   * already armed, so the link would invite a click that changes nothing.
   */
  it('offers retry only when offline, and emits it', () => {
    const emitted: number[] = [];
    fixture.componentInstance.retryRequested.subscribe(() => emitted.push(1));

    for (const state of ['connecting', 'live', 'reconnecting'] as const) {
      render(state);
      expect(retry()).toBeNull();
    }

    render('offline');
    expect(retry()?.textContent?.trim()).toBe('Retry');

    retry()?.click();
    expect(emitted).toHaveLength(1);
  });

  it('announces the state rather than relying on the dot alone', () => {
    render('offline');

    expect(chip().textContent).toContain('Live updates OFF');
  });

  /**
   * CONTRACT: Hover AND focus open the card. The chip is a small target and a
   * keyboard reaches it only by focus, so hover alone hides the explanation.
   */
  it('explains the state on hover and on focus', () => {
    render('live');
    expect(card()).toBeNull();

    hover(true);
    expect(card()?.textContent).toContain('stream in real time');

    hover(false);
    expect(card()).toBeNull();

    chip().dispatchEvent(new Event('focus'));
    fixture.detectChanges();
    expect(card()).not.toBeNull();
  });

  it('gives each state its own explanation', () => {
    const details = (['connecting', 'live', 'reconnecting', 'offline'] as const).map((state) => {
      render(state);
      hover(true);
      const text = card()?.querySelector('p')?.textContent?.trim() ?? '';
      hover(false);
      return text;
    });

    expect(new Set(details).size).toBe(4);
    expect(details[3]).toContain('Retry');
  });

  /** The card must describe the chip, not float unlabelled. */
  it('ties the card to the chip with aria-describedby', () => {
    render('live');
    expect(chip().getAttribute('aria-describedby')).toBeNull();

    hover(true);
    expect(chip().getAttribute('aria-describedby')).toBe(card()?.id);
  });
});
