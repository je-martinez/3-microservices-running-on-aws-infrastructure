import { Component, input, output } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';

/**
 * Design: frame `Field` (TLRTA). Label + icon input box + optional trailing icon
 * (the password show/hide toggle) + optional help text, both off by default.
 * Screens own the value/model; this only wraps an `<input>` with the design's
 * chrome, exposing `valueChange` for two-way binding.
 */
@Component({
  selector: 'app-field',
  imports: [LucideDynamicIcon],
  templateUrl: './field.html',
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
