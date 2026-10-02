import { ComponentRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { LiveSessionBadge } from './live-session-badge';
import type { LiveSessionState } from '../../core/notifications/notifications-socket';

describe('LiveSessionBadge', () => {
  let fixture: ComponentFixture<LiveSessionBadge>;
  let ref: ComponentRef<LiveSessionBadge>;

  const render = (state: LiveSessionState) => {
    ref.setInput('state', state);
    fixture.detectChanges();
  };

  const host = () => fixture.nativeElement as HTMLElement;
  const scanner = () => host().querySelector('.badge-scan');
  const ring = () => host().querySelector('.badge-arc');

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [LiveSessionBadge] });
    fixture = TestBed.createComponent(LiveSessionBadge);
    ref = fixture.componentRef;
    render('connecting');
  });

  /**
   * CONTRACT: The ring belongs to `live` alone. It is what the comet closes
   * into, so drawing it while the socket is still reaching for a connection
   * claims a session that does not exist yet.
   */
  it('scans until live, then closes into the ring', () => {
    expect(scanner()).not.toBeNull();
    expect(ring()).toBeNull();

    render('live');
    expect(ring()).not.toBeNull();
    expect(scanner()).toBeNull();
  });

  it('keeps scanning in reconnecting and offline', () => {
    for (const state of ['reconnecting', 'offline'] as const) {
      render(state);
      expect(scanner()).not.toBeNull();
      expect(ring()).toBeNull();
    }
  });

  it('colours the scanner per state', () => {
    render('connecting');
    expect(scanner()?.className).toContain('bg-success-green/45');

    render('reconnecting');
    expect(scanner()?.className).toContain('bg-warn-amber');

    render('offline');
    expect(scanner()?.className).toContain('bg-ink-muted');
  });

  /**
   * CONTRACT: Silent and inert. The words and the retry live in the account
   * menu's chip; a control here would fight the button it rides for the click.
   */
  it('offers no control and no visible text', () => {
    for (const state of ['connecting', 'live', 'reconnecting', 'offline'] as const) {
      render(state);
      expect(host().querySelector('button')).toBeNull();
      expect(host().querySelector('[role="tooltip"]')).toBeNull();
      expect(host().querySelector('[aria-hidden="true"]')?.className).toContain(
        'pointer-events-none',
      );
    }
  });

  /** A colour announces nothing; the state still has to reach assistive tech. */
  it('announces each state in a live region', () => {
    const heard = (['connecting', 'live', 'reconnecting', 'offline'] as const).map((state) => {
      render(state);
      return host().querySelector('[role="status"]')?.textContent?.trim() ?? '';
    });

    expect(heard[0]).toContain('Connecting');
    expect(heard[1]).toContain('Live updates on');
    expect(heard[2]).toContain('Reconnecting');
    expect(heard[3]).toContain('Offline');
    expect(new Set(heard).size).toBe(4);
  });
});
