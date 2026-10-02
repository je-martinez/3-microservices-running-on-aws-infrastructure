import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';

import type { LiveSessionState } from '../../core/notifications/notifications-socket';

interface ChipCopy {
  readonly label: string;
  /** What the chip means, shown in the card on hover or focus. */
  readonly detail: string;
  /** Chip background plus the dot and label colours, all tokens. */
  readonly chip: string;
  readonly dot: string;
  readonly text: string;
}

const COPY: Record<LiveSessionState, ChipCopy> = {
  connecting: {
    label: 'Connecting…',
    detail: 'Setting up live updates for this session.',
    chip: 'bg-warn-bg',
    dot: 'bg-warn-amber',
    text: 'text-warn-ink',
  },
  live: {
    label: 'Live updates ON',
    detail: 'Orders, tracking and notifications stream in real time.',
    chip: 'bg-success-bg',
    dot: 'bg-success-green',
    text: 'text-success-ink',
  },
  reconnecting: {
    label: 'Reconnecting…',
    detail: 'Updates are paused. Trying to reconnect.',
    chip: 'bg-warn-bg',
    dot: 'bg-warn-amber',
    text: 'text-warn-ink',
  },
  offline: {
    label: 'Live updates OFF',
    detail: 'Not receiving updates. Retry to reconnect now.',
    chip: 'bg-neutral-bg',
    dot: 'bg-ink-muted',
    text: 'text-ink-secondary',
  },
};

/**
 * CONTRACT: Retry shows on `offline` ALONE. On `reconnecting` an attempt is
 * already armed, so the link invites a click that changes nothing.
 */
@Component({
  selector: 'app-live-session-chip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './live-session-chip.html',
  host: { class: 'block w-full' },
})
export class LiveSessionChip {
  readonly state = input.required<LiveSessionState>();

  readonly retryRequested = output<void>();

  protected readonly open = signal(false);

  protected readonly copy = computed(() => COPY[this.state()]);

  protected setOpen(open: boolean): void {
    this.open.set(open);
  }
  protected readonly showsRetry = computed(() => this.state() === 'offline');
}
