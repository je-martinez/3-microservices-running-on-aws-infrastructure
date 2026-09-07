import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideDynamicIcon } from '@lucide/angular';
import { Subject, debounceTime, distinctUntilChanged, of, switchMap } from 'rxjs';

import { APP_CONFIG } from '../../core/config/app-config';
import { GeocodeApi, MIN_QUERY_LENGTH, type StreetSuggestion } from '../../core/api/geocode-api';
import type { Address } from '../../core/api/types';

/** Long enough that a fast typist sends one request per word, not per letter. */
const DEBOUNCE_MS = 300;

/** No suggestion is highlighted until the user presses a key. */
const NO_ACTIVE_INDEX = -1;

/**
 * A STREET autocomplete, not a full-address one.
 *
 * CONTRACT: OpenStreetMap holds no house numbers for Santo Domingo, so a
 * suggestion fills the street and everything above it while the buyer types
 * their own number. Copy that promises full-address completion under-delivers
 * on every Dominican address. See [[2026-09-06-address-geocoding-proxy-design]]
 *
 * CONTRACT: The `.pen` has NO frame for this control — the design's street
 * field is a plain `Field`. Reuse `field.html`'s tokens for the input chrome
 * and `account-menu.html`'s for the dropdown; do not invent a token.
 */
@Component({
  selector: 'app-street-autocomplete',
  imports: [LucideDynamicIcon],
  templateUrl: './street-autocomplete.html',
  // CONTRACT: Keep `block w-full` on the host, for the reason field.ts states —
  // a bare custom element is display:inline and shrinks to its content as a
  // flex item. See [[angular-component-authoring]]
  host: { class: 'block w-full' },
})
export class StreetAutocomplete {
  private readonly geocode = inject(GeocodeApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly label = input.required<string>();
  readonly placeholder = input('');
  readonly value = input('');
  /** Leading glyph, e.g. "map-pin". */
  readonly icon = input<string>();
  readonly help = input<string>();

  readonly valueChange = output<string>();
  /** Emits the resolved address when a suggestion is chosen, never on typing. */
  readonly addressSelected = output<Address>();

  /** Read from APP_CONFIG, never from import.meta.env — see app-config.ts. */
  protected readonly enabled = APP_CONFIG.geocodeEnabled;

  protected readonly suggestions = signal<readonly StreetSuggestion[]>([]);
  protected readonly activeIndex = signal(NO_ACTIVE_INDEX);
  /** Closed after a selection or Escape, until the next keystroke reopens it. */
  private readonly dismissed = signal(false);

  /**
   * The query the pipeline still owes an answer for, or null when it owes none.
   *
   * CONTRACT: Set it ONLY for a query the pipeline really emits for, and clear
   * it ONLY in the single subscribe. A boolean flipped at each call site spins
   * forever on the two paths that emit nothing — a query under
   * MIN_QUERY_LENGTH, and a repeat distinctUntilChanged swallows.
   * See [[2026-09-06-address-geocoding-proxy-design]]
   */
  private readonly pendingQuery = signal<string | null>(null);

  /**
   * WHY: "No matches" is a positive fact, not the absence of suggestions — an
   * untouched field holds an empty list too, and would otherwise announce a
   * failed search before the buyer has typed anything.
   */
  private readonly emptyQuery = signal<string | null>(null);

  /** The last query handed downstream — mirrors distinctUntilChanged's memory. */
  private lastAcceptedQuery: string | null = null;

  protected readonly pending = computed(() => this.pendingQuery() !== null);

  /** Distinct from "searching": the lookup finished and found nothing. */
  protected readonly empty = computed(() => this.emptyQuery() !== null);

  protected readonly open = computed(
    () =>
      this.enabled &&
      !this.dismissed() &&
      (this.pending() || this.empty() || this.suggestions().length > 0),
  );

  protected readonly activeId = computed(() => {
    const index = this.activeIndex();
    const suggestion = this.suggestions()[index];
    return this.open() && suggestion ? this.optionId(index) : null;
  });

  private readonly queries = new Subject<string>();

  constructor() {
    // WHY: Nothing subscribes when the flag is off, so no pipeline exists to
    // fire a request — the guarantee is structural rather than a branch that a
    // later edit could slip past.
    if (!this.enabled) return;

    this.queries
      .pipe(
        debounceTime(DEBOUNCE_MS),
        distinctUntilChanged(),
        // CONTRACT: A too-short query emits `of([])` rather than being dropped
        // by a `filter`. Dropping it leaves the previous, longer query's
        // suggestions on screen while the buyer deletes back past the minimum.
        switchMap((query) =>
          query.length < MIN_QUERY_LENGTH ? of([]) : this.geocode.suggest(query),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((suggestions) => {
        // WHY: The sole clearing point. switchMap emits once per surviving
        // query, and GeocodeApi.suggest turns every failure into `[]`, so a
        // 503, a network drop and an empty result all land right here.
        const query = this.pendingQuery();
        this.pendingQuery.set(null);
        this.emptyQuery.set(query !== null && suggestions.length === 0 ? query : null);
        this.suggestions.set(suggestions);
        this.activeIndex.set(NO_ACTIVE_INDEX);
      });
  }

  protected optionId(index: number): string {
    return `street-option-${String(index)}`;
  }

  /**
   * CONTRACT: Pending starts HERE, not inside switchMap. The 300ms debounce is
   * part of the dead interval the buyer perceives; flagging it only once the
   * request goes out leaves every keystroke burst looking frozen for exactly as
   * long as it does with no indicator at all.
   */
  protected onInput(raw: string): void {
    this.valueChange.emit(raw);
    this.dismissed.set(false);

    const query = raw.trim();
    // WHY: Both guards replicate what the pipeline does with this query, so
    // pending is set only when an emission is genuinely coming. A repeat query
    // keeps whatever pending state the earlier one left, rather than starting a
    // second wait that nothing downstream will ever end.
    if (query !== this.lastAcceptedQuery) {
      this.lastAcceptedQuery = query;
      this.emptyQuery.set(null);
      this.pendingQuery.set(query.length < MIN_QUERY_LENGTH ? null : query);
    }

    this.queries.next(query);
  }

  /**
   * CONTRACT: Arrow keys must not also move the text caret, and Enter must not
   * submit the checkout form, while the list is open — both are prevented here.
   * Without it, ArrowDown jumps the caret to the end of the input and the
   * highlight appears to move a line at a time behind the cursor.
   */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.dismiss();
      return;
    }
    // CONTRACT: Gate on the SUGGESTION COUNT, not on `open()`. The list also
    // opens with zero options to show "Searching…", and an ArrowDown there
    // computes `% 0` — activeIndex becomes NaN and every option silently stops
    // highlighting for the rest of the session.
    const count = this.suggestions().length;
    if (!this.open() || count === 0) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        this.activeIndex.set((this.activeIndex() + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        // WHY: The -1 "nothing highlighted" state is handled apart from the
        // wrap. Folding it into the modulo lands on the FIRST option, where
        // ArrowUp from nothing is expected to reach the last.
        this.activeIndex.set(
          this.activeIndex() <= 0 ? count - 1 : this.activeIndex() - 1,
        );
        break;
      case 'Enter': {
        const active = this.suggestions()[this.activeIndex()];
        if (!active) return;
        event.preventDefault();
        this.select(active);
        break;
      }
      default:
        break;
    }
  }

  /**
   * CONTRACT: Emit the WHOLE resolved address, not just the street text. City,
   * state and postal code are known facts once a suggestion is chosen, and
   * re-deriving them from the label re-introduces the heuristic parse the
   * suggestion exists to replace.
   */
  protected select(suggestion: StreetSuggestion): void {
    this.valueChange.emit(suggestion.address.line1);
    this.addressSelected.emit(suggestion.address);
    this.dismiss();
  }

  /**
   * CONTRACT: Clear pending as well as the highlight. An in-flight lookup still
   * resolves after a dismiss, but nothing may keep spinning over a closed list
   * — and `lastAcceptedQuery` stays as it is, because the pipeline's own
   * distinctUntilChanged would swallow that repeat too.
   */
  protected dismiss(): void {
    this.dismissed.set(true);
    this.pendingQuery.set(null);
    this.emptyQuery.set(null);
    this.activeIndex.set(NO_ACTIVE_INDEX);
  }
}
