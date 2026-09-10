import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LucidePhone, provideLucideIcons } from '@lucide/angular';

import { PhoneField } from './phone-field';

describe('PhoneField', () => {
  let fixture: ComponentFixture<PhoneField>;

  beforeEach(async () => {
    TestBed.configureTestingModule({ providers: [provideLucideIcons(LucidePhone)] });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(PhoneField);
    fixture.componentRef.setInput('label', 'Phone number');
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function render(value: string, defaultCountry?: string): HTMLElement {
    fixture.componentRef.setInput('value', value);
    if (defaultCountry !== undefined) {
      fixture.componentRef.setInput('defaultCountry', defaultCountry);
    }
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function countryOf(root: HTMLElement): string | null {
    return root.querySelector('[data-country]')?.getAttribute('data-country') ?? null;
  }

  /**
   * CONTRACT: THE case this component exists for. Both numbers are `+1`, and a
   * calling-code lookup would call both US — including the app's own
   * `+1 809 000 0000` placeholder. Parsing separates them by area code.
   * See [[2026-09-05-phone-input-country-flag]]
   */
  it.each([
    ['+1 809 555 0142', 'DO', '\u{1F1E9}\u{1F1F4}'],
    ['+1 212 555 0142', 'US', '\u{1F1FA}\u{1F1F8}'],
  ])('reads %s as %s', (typed, expected, flag) => {
    const root = render(typed);

    expect(countryOf(root)).toBe(expected);
    expect(root.textContent).toContain(expected);
    expect(root.textContent).toContain(flag);
  });

  it('reads a Spanish number as ES', () => {
    expect(countryOf(render('+34 612 345 678'))).toBe('ES');
  });

  /** A number identifying no country shows no flag, and parsing must not throw. */
  it.each(['809555', 'abc', '++++', '+999 111 2222'])('shows no flag for %s', (typed) => {
    const root = render(typed);

    expect(countryOf(root)).toBeNull();
    expect(root.querySelector('[data-testid="phone-invalid"]')).toBeNull();
  });

  it('renders neither flag nor warning when empty', () => {
    const root = render('');

    expect(countryOf(root)).toBeNull();
    expect(root.querySelector('[data-testid="phone-invalid"]')).toBeNull();
  });

  it('seeds the flag from defaultCountry before anything is typed', () => {
    expect(countryOf(render('', 'DO'))).toBe('DO');
  });

  /**
   * CONTRACT: Once the user types, the NUMBER decides — the seed is only a
   * pre-typing default. A seed that kept winning would show DO for a US number
   * the buyer just entered.
   */
  it('lets the typed number override the seeded country', () => {
    expect(countryOf(render('+1 212 555 0142', 'DO'))).toBe('US');
  });

  /**
   * CONTRACT: An invalid number WARNS but never blocks. The value still reaches
   * `valueChange`, because a false negative from the parser must not stop
   * someone completing their order.
   */
  it('warns on an invalid number while still propagating the value', () => {
    const emitted: string[] = [];
    fixture.componentRef.setInput('value', '');
    fixture.componentInstance.value.subscribe((v) => emitted.push(v));
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector('input');
    if (!input) throw new Error('no input rendered');
    input.value = '+1 809 555';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(emitted).toEqual(['+1 809 555']);
    expect(root.querySelector('[data-testid="phone-invalid"]')).not.toBeNull();
    // Still identified, and no control disabled by the warning.
    expect(countryOf(root)).toBe('DO');
    expect(input.disabled).toBe(false);
  });

  it('reports no warning for a valid number', () => {
    const root = render('+1 809 555 0142');

    expect(root.querySelector('[data-testid="phone-invalid"]')).toBeNull();
  });

  it('emits the derived country as the user types', () => {
    const countries: (string | null)[] = [];
    fixture.componentInstance.countryChange.subscribe((c) => countries.push(c));
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector('input');
    if (!input) throw new Error('no input rendered');
    input.value = '+1 212 555 0142';
    input.dispatchEvent(new Event('input'));

    expect(countries).toEqual(['US']);
  });

  it('strips letters while preserving a leading plus and phone separators', () => {
    const emitted: string[] = [];
    fixture.componentInstance.value.subscribe((value) => emitted.push(value));
    fixture.detectChanges();

    const input = (fixture.nativeElement as HTMLElement).querySelector('input');
    if (!input) throw new Error('no input rendered');
    input.value = '+1 (809) CALL-0142+';
    input.dispatchEvent(new Event('input'));

    expect(input.value).toBe('+1 (809) -0142');
    expect(emitted).toEqual(['+1 (809) -0142']);
  });
});
