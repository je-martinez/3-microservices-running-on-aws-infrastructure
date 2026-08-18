import { Component, input, output } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';

/**
 * Design: frame `Field` (TLRTA). Label + icon input box + optional trailing
 * icon (`Field Trailing`, disabled by default — the password show/hide
 * toggle) + optional help text (`Field Help`, disabled by default).
 *
 * Screens (Tasks 9-11) own the actual value/model — this component only
 * wraps an `<input>` with the label/icon/help chrome the design shows,
 * exposing `valueChange` for two-way binding convenience.
 */
@Component({
  selector: 'app-field',
  imports: [LucideDynamicIcon],
  template: `
    <label class="flex h-fit w-full flex-col gap-2">
      <span class="text-ink-primary text-sm font-semibold">{{ label() }}</span>
      <span
        class="h-field border-line bg-surface-white flex w-full items-center gap-[13px] rounded-md border px-[18px]"
      >
        @if (icon(); as iconName) {
          <svg [lucideIcon]="iconName" class="text-ink-muted shrink-0 text-[19px]"></svg>
        }
        <input
          class="text-ink-primary placeholder:text-ink-muted w-full flex-1 border-0 bg-transparent text-base outline-none"
          [type]="type()"
          [placeholder]="placeholder()"
          [value]="value()"
          (input)="valueChange.emit($any($event.target).value)"
        />
        @if (trailingIcon(); as trailingIconName) {
          <button
            type="button"
            class="text-ink-muted shrink-0 text-[19px]"
            (click)="trailingIconClick.emit()"
          >
            <svg [lucideIcon]="trailingIconName"></svg>
          </button>
        }
      </span>
      @if (help(); as helpText) {
        <span class="text-ink-secondary text-[13px]">{{ helpText }}</span>
      }
    </label>
  `,
})
export class Field {
  readonly label = input.required<string>();
  readonly placeholder = input('');
  readonly value = input('');
  readonly type = input<'text' | 'email' | 'password'>('text');
  /** Leading glyph, e.g. "mail". */
  readonly icon = input<string>();
  /** Trailing glyph, e.g. "eye-off" for the password show/hide toggle. Absent by default. */
  readonly trailingIcon = input<string>();
  readonly help = input<string>();

  readonly valueChange = output<string>();
  readonly trailingIconClick = output<void>();
}
