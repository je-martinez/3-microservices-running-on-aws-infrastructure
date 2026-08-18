import { Component, input, output } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';

/**
 * Design: frame `Button Primary` (sHl96). Orange filled button with an
 * optional trailing icon (`Button Icon`, disabled by default — the
 * `arrow-right` glyph screens like Verify Code enable via override).
 */
@Component({
  selector: 'app-button-primary',
  imports: [LucideDynamicIcon],
  template: `
    <button
      type="button"
      class="h-field bg-brand-orange rounded-md text-surface-white inline-flex w-full items-center justify-center gap-[10px] text-base font-semibold"
      [disabled]="disabled()"
      [class.opacity-50]="disabled()"
      (click)="clicked.emit()"
    >
      {{ label() }}
      @if (icon(); as iconName) {
        <svg [lucideIcon]="iconName" class="text-[19px]"></svg>
      }
    </button>
  `,
})
export class ButtonPrimary {
  readonly label = input.required<string>();
  /** Trailing glyph, e.g. "arrow-right". Absent by default, matching the design. */
  readonly icon = input<string>();
  readonly disabled = input(false);

  readonly clicked = output<void>();
}
