import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { LiveSessionState } from '../../core/notifications/notifications-socket';

interface StateVisual {
  /** Scanner bar colour, shown while no ring is drawn. */
  readonly scanner: string;
  readonly announcement: string;
}

const VISUALS: Record<LiveSessionState, StateVisual> = {
  connecting: {
    scanner: 'bg-success-green/45',
    announcement: 'Connecting. Setting up live updates for this session.',
  },
  live: {
    scanner: '',
    announcement: 'Live updates on. Orders, tracking and notifications stream in real time.',
  },
  reconnecting: {
    scanner: 'bg-warn-amber',
    announcement: 'Reconnecting. Updates are paused.',
  },
  offline: {
    scanner: 'bg-ink-muted',
    announcement: 'Offline. Not receiving updates.',
  },
};

/**
 * CONTRACT: This indicator is SILENT — no words, no action. The state's label
 * and its retry live in the account menu's chip, so a hover card here would
 * say the same thing twice and fight that menu for the same corner.
 */
@Component({
  selector: 'app-live-session-badge',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './live-session-badge.html',
  styleUrl: './live-session-badge.css',
  host: { class: 'relative inline-flex' },
})
export class LiveSessionBadge {
  readonly state = input.required<LiveSessionState>();

  protected readonly copy = computed(() => VISUALS[this.state()]);

  /** The ring belongs to `live` alone; every other state is still scanning. */
  protected readonly showsRing = computed(() => this.state() === 'live');
  protected readonly showsScanner = computed(() => this.state() !== 'live');
}
