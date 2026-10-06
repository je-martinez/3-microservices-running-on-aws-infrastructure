import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  output,
  untracked,
} from '@angular/core';
import { LucideCircleCheck, LucideX } from '@lucide/angular';

/**
 * WHY 6000: "Changes saved" plus an eight-word line is about 2-3 seconds of
 * reading at ~200 wpm; the rest is the time to notice the banner appeared.
 * Toast guidance floors auto-dismissal around 5s for a message with no action.
 */
export const SAVED_BANNER_DISMISS_MS = 6000;

/**
 * Design: `Saved Banner` (`ldokh`). Emits `dismissed` on its X or when the
 * countdown elapses. CONTRACT: Do NOT give it `role="status"` — a status node
 * inserted with its text is never announced, so the persistent live region
 * belongs to the host and wraps this component.
 */
@Component({
  selector: 'app-saved-banner',
  imports: [LucideCircleCheck, LucideX],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './saved-banner.html',
  host: {
    class: 'block w-full',
    '(mouseenter)': 'onHover(true)',
    '(mouseleave)': 'onHover(false)',
    '(focusin)': 'onFocus($event, true)',
    '(focusout)': 'onFocus($event, false)',
  },
})
export class SavedBanner {
  readonly heading = input('Changes saved');
  readonly message = input('Your personal details are up to date.');
  readonly dismissTestId = input<string | null>(null);
  /** A new value restarts the full countdown on this same instance. */
  readonly restartKey = input<unknown>();

  readonly dismissed = output<void>();

  /**
   * CONTRACT: Hover and keyboard focus pause the countdown independently
   * (WCAG 2.2.1), so leaving with the mouse while the X still holds focus keeps
   * it paused. Both reset on every restart: a pointer resting on the banner
   * fires no `mouseenter`, and a stale `true` would hold it up forever.
   */
  private hovered = false;
  private focused = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Milliseconds left on the countdown; a resume continues from here. */
  private remaining = SAVED_BANNER_DISMISS_MS;
  private startedAt = 0;

  constructor() {
    effect(() => {
      this.restartKey();
      untracked(() => this.restart());
    });
    inject(DestroyRef).onDestroy(() => this.stopTimer());
  }

  protected dismiss(): void {
    this.stopTimer();
    this.dismissed.emit();
  }

  protected onHover(hovered: boolean): void {
    this.hovered = hovered;
    this.syncTimer();
  }

  /** Focus moving between elements INSIDE the banner is not a blur. */
  protected onFocus(event: FocusEvent, focused: boolean): void {
    const banner = event.currentTarget as HTMLElement;
    if (!focused && banner.contains(event.relatedTarget as Node | null)) return;
    this.focused = focused;
    this.syncTimer();
  }

  private restart(): void {
    this.stopTimer();
    this.hovered = false;
    this.focused = false;
    this.remaining = SAVED_BANNER_DISMISS_MS;
    this.armTimer();
  }

  /** Pauses while held; a resume continues the banked remainder, not a fresh 6s. */
  private syncTimer(): void {
    if (this.hovered || this.focused) {
      if (this.timer === null) return;
      this.stopTimer();
      this.remaining = Math.max(0, this.remaining - (Date.now() - this.startedAt));
    } else if (this.timer === null) {
      this.armTimer();
    }
  }

  private armTimer(): void {
    this.startedAt = Date.now();
    this.timer = setTimeout(() => this.dismiss(), this.remaining);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
