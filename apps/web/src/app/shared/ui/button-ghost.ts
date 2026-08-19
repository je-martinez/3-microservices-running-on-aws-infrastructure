import { Component, input, output } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';

/**
 * Design: frame `Button Ghost` (aUEDx). White outline button, e.g. "Continue
 * with email only" on the passwordless auth screens. Always shows its
 * leading icon (no disabled override in the design, unlike Button Primary's
 * trailing icon).
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

  readonly clicked = output<void>();
}
