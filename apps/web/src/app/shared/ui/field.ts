import { Component, computed, input, model, output, ChangeDetectionStrategy } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
import { digitsOnly } from './numeric-input';

type FieldType = 'text' | 'email' | 'password' | 'numeric';

/**
 * Design: frame `Field` (TLRTA). Label + icon input box + optional trailing icon
 * (the password show/hide toggle) + optional help text, both off by default.
 *
 * CONTRACT: Implements Signal Forms' `FormValueControl`, so `[formField]` binds
 * it with no glue: `value` is a `model()` (never an `input()`), and the optional
 * `errors`/`disabled`/`required`/`touched` inputs are filled by the directive
 * from the field's own state. Re-typing `value` breaks every `[formField]`
 * binding silently. See [[angular-component-authoring]]
 */
@Component({
  selector: 'app-field',
  imports: [LucideDynamicIcon],
  templateUrl: './field.html',
  // CONTRACT: Keep `block w-full` on the host. A bare custom element is
  // display:inline and shrinks to its content as a flex item, so the template's
  // `w-full` resolves against that instead of the row — profile's Address field
  // rendered 304px inside a 760px card. See [[angular-component-authoring]]
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block w-full' },
})
export class Field {
  readonly label = input.required<string>();
  readonly placeholder = input('');
  readonly value = model('');
  readonly type = input<FieldType>('text');
  readonly autocomplete = input<string>();
  readonly maxLength = input<number>();
  /** Leading glyph, e.g. "mail". */
  readonly icon = input<string>();
  /** Trailing glyph, e.g. "eye-off" for the password show/hide toggle. Absent by default. */
  readonly trailingIcon = input<string>();
  readonly help = input<string>();

  /** Filled by `[formField]`; inert for a field used outside a form. */
  readonly errors = input<readonly { readonly message?: string }[]>([]);
  readonly disabled = input(false);
  readonly required = input(false);
  readonly touched = input(false);

  readonly trailingIconClick = output<void>();

  protected readonly nativeType = computed(() => (this.type() === 'numeric' ? 'text' : this.type()));

  /**
   * WHY: An error stays hidden until the field is touched, so a pristine form
   * does not greet the user in red before they have typed anything.
   */
  protected readonly visibleError = computed(() =>
    this.touched() ? (this.errors()[0]?.message ?? null) : null,
  );

  protected onInput(element: HTMLInputElement): void {
    const value =
      this.type() === 'numeric' ? digitsOnly(element.value, this.maxLength()) : element.value;
    element.value = value;
    this.value.set(value);
  }
}
