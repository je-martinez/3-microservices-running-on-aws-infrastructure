import { Component, computed, input, output, signal } from '@angular/core';
import { LucideDynamicIcon } from '@lucide/angular';
// CONTRACT: Import from `/min`, NEVER the package root. The root pulls the
// `max` metadata — 153 kB raw against `min`'s 82 kB — for number-*type* data
// this field never reads. See [[2026-09-05-phone-input-country-flag]]
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';

/** What the typed digits say about the number, recomputed on every keystroke. */
interface PhoneReading {
  /** ISO-3166 alpha-2, or null when the digits identify no single region. */
  readonly country: string | null;
  /** False only once a country is known AND the number is wrong for it. */
  readonly invalid: boolean;
}

const EMPTY_READING: PhoneReading = { country: null, invalid: false };

/**
 * CONTRACT: The country comes from PARSING the number, never from its calling
 * code. `+1 809…` is the Dominican Republic and `+1 212…` is the United
 * States; a calling-code lookup shows a US flag for every Dominican number,
 * including the one in this app's own placeholder.
 * See [[2026-09-05-phone-input-country-flag]]
 */
function read(value: string, seed: string | undefined): PhoneReading {
  const trimmed = value.trim();
  if (trimmed === '') return seed ? { country: seed, invalid: false } : EMPTY_READING;

  const parsed = parsePhoneNumberFromString(trimmed);
  if (!parsed?.country) return { country: null, invalid: false };
  return { country: parsed.country, invalid: !parsed.isValid() };
}

/**
 * CONTRACT: An ISO alpha-2 code maps to its flag by offsetting each letter into
 * the Unicode regional-indicator block. Any other input yields mojibake, so
 * non-letters produce no flag rather than a broken glyph.
 */
function flagEmoji(country: string): string {
  if (!/^[A-Za-z]{2}$/.test(country)) return '';
  return country
    .toUpperCase()
    .replace(/./g, (letter) => String.fromCodePoint(0x1f1e6 + letter.charCodeAt(0) - 65));
}

function sanitizePhoneInput(raw: string): string {
  const hasLeadingPlus = raw.trimStart().startsWith('+');
  const body = raw.replace(/\+/g, '').replace(/[^\d\s()-]/g, '').trimStart();
  return `${hasLeadingPlus ? '+' : ''}${body}`;
}

/**
 * A phone variant of `Field`, not a widening of it: `Field` backs every auth
 * screen and does not need a parser.
 *
 * CONTRACT: The `.pen` has NO frame for this control — the design's `Phone
 * Field` is a plain `Field`. Reuse `field.html`'s tokens; do not invent one.
 * See [[2026-09-05-phone-input-country-flag]]
 */
@Component({
  selector: 'app-phone-field',
  imports: [LucideDynamicIcon],
  templateUrl: './phone-field.html',
  // CONTRACT: Keep `block w-full` on the host, for the reason field.ts states —
  // a bare custom element is display:inline and shrinks to its content as a
  // flex item. See [[angular-component-authoring]]
  host: { class: 'block w-full' },
})
export class PhoneField {
  readonly label = input.required<string>();
  readonly placeholder = input('');
  readonly value = input('');
  /** Leading glyph, shown only while no country is known. */
  readonly icon = input<string>();
  readonly help = input<string>();
  /**
   * ISO alpha-2 seeding the flag BEFORE anything is typed, e.g. the saved
   * address's country. Once the user types, the number decides.
   */
  readonly defaultCountry = input<string>();

  readonly valueChange = output<string>();
  readonly countryChange = output<string | null>();

  /** Mirrors `value()` so the reading follows typing, not just the bound input. */
  private readonly typed = signal<string | null>(null);
  private readonly current = computed(() => this.typed() ?? this.value());

  protected readonly reading = computed(() => read(this.current(), this.defaultCountry()));
  protected readonly country = computed(() => this.reading().country);
  protected readonly flag = computed(() => {
    const country = this.country();
    return country ? flagEmoji(country) : '';
  });

  /**
   * CONTRACT: The warning NEVER blocks. It is advisory only — no disabled
   * button, no swallowed `valueChange` — because a false negative from the
   * parser must not stop someone completing an order.
   */
  protected readonly invalid = computed(() => this.reading().invalid);

  protected onInput(element: HTMLInputElement): void {
    const value = sanitizePhoneInput(element.value);
    element.value = value;
    this.typed.set(value);
    this.valueChange.emit(value);
    this.countryChange.emit(read(value, this.defaultCountry()).country);
  }
}
