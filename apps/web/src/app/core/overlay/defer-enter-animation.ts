import { afterNextRender, Directive, ElementRef, inject, signal } from '@angular/core';

/**
 * Holds an overlay's `animate.enter` animation until its first frame has been
 * presented, then runs it from the start.
 */

/* WHY: The clock starts when the class lands, but a freshly mounted overlay's
 * first frame misses its deadline while the compositor rasters the panel's new
 * layers (~30ms, once per session). The panel holds at its start pose and then
 * jumps a fifth in — the flicker. See [[2026-09-03-cart-drawer-first-open-flicker]] */
@Directive({
  selector: '[appDeferEnterAnimation]',
  // The attribute drives `[data-deferred-enter]` in styles.css, which pauses the
  // host AND its panel child — a host-only style leaves the slide running.
  host: { '[attr.data-deferred-enter]': 'deferred() ? "" : null' },
})
export class DeferEnterAnimation {
  /**
   * CONTRACT: A signal, not a plain field. The unpause happens in a raw
   * `requestAnimationFrame` outside Angular's zone, where a field assignment
   * schedules no change detection: the attribute sticks, the animation stays
   * paused, and because Angular removes its enter class on `animationend` —
   * which a paused animation never fires — the overlay is left permanently
   * covering the page and swallowing clicks.
   * See [[2026-09-03-cart-drawer-first-open-flicker]]
   */
  protected readonly deferred = signal(true);

  private readonly element = inject(ElementRef<HTMLElement>);

  constructor() {
    // Two frames, not one: the first callback runs before the frame it belongs
    // to is composited, so only the second lands after the element has actually
    // reached the screen.
    afterNextRender(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          this.deferred.set(false);
          // CONTRACT: Restart the clock in the SAME callback that unpauses.
          // Resuming alone continues an animation whose `currentTime` already
          // advanced through the missed frame — the very jump this removes.
          for (const animation of this.animations()) animation.currentTime = 0;
        }),
      );
    });
  }

  /** The host's own animations plus its panel child's, which slides with it. */
  private animations(): readonly Animation[] {
    const host: HTMLElement = this.element.nativeElement;
    return [...host.getAnimations(), ...(host.firstElementChild?.getAnimations() ?? [])];
  }
}
