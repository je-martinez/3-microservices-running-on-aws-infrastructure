import { Component, input, output, ChangeDetectionStrategy } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';

/**
 * Design: frame `Button Primary` (sHl96). Orange filled button with an
 * optional trailing icon (`Button Icon`, disabled by default — the
 * `arrow-right` glyph screens like Verify Code enable via override).
 */
@Component({
  selector: 'app-button-primary',
  imports: [LucideDynamicIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './button-primary.html',
})
export class ButtonPrimary {
  readonly label = input.required<string>();
  /** Trailing glyph, e.g. "arrow-right". Absent by default, matching the design. */
  readonly icon = input<string>();
  readonly disabled = input(false);

  readonly clicked = output<void>();
}
