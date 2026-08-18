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
  template: `
    <button
      type="button"
      class="h-field bg-surface-white border-line-strong text-brand-navy rounded-md inline-flex w-full items-center justify-center gap-[10px] border text-base font-semibold"
      [disabled]="disabled()"
      [class.opacity-50]="disabled()"
      (click)="clicked.emit()"
    >
      <svg [lucideIcon]="icon()" class="text-[19px]"></svg>
      {{ label() }}
    </button>
  `,
})
export class ButtonGhost {
  readonly label = input.required<string>();
  readonly icon = input.required<string>();
  readonly disabled = input(false);

  readonly clicked = output<void>();
}
