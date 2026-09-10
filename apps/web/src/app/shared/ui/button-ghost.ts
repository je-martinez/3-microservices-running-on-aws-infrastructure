import { Component, input, output } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';

/**
 * Design: frame `Button Ghost` (aUEDx). White outline button, e.g. "Continue
 * with email only" on the passwordless auth screens. Always shows its
 * leading icon (no disabled override in the design, unlike Button Primary's
 * trailing icon). `compact` renders the shorter in-card size.
 */
@Component({
  selector: 'app-button-ghost',
  imports: [LucideDynamicIcon],
  templateUrl: './button-ghost.html',
})
export class ButtonGhost {
  readonly label = input.required<string>();
  readonly icon = input.required<string>();
  readonly disabled = input(false);
  /**
   * Shorter variant used inside cards and banners, where the auth screens'
   * full-height form control would tower over the copy beside it.
   */
  readonly compact = input(false);

  readonly clicked = output<void>();
}
