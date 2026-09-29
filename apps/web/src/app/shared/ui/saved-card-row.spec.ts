import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LucideCreditCard, LucideTrash2, provideLucideIcons } from '@lucide/angular';

import { SavedCardRow } from './saved-card-row';
import type { PaymentMethodView } from '../../core/api/types';

const CARD: PaymentMethodView = {
  id: 'pm_1',
  type: 'card',
  brand: 'visa',
  last4: '4242',
  expMonth: 4,
  expYear: 2028,
  isDefault: false,
};

describe('SavedCardRow', () => {
  let fixture: ComponentFixture<SavedCardRow>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideLucideIcons(LucideCreditCard, LucideTrash2)],
    });
    await TestBed.compileComponents();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function render(
    props: Partial<{
      card: PaymentMethodView;
      selected: boolean;
      selectable: boolean;
      expired: boolean;
    }> = {},
  ): HTMLElement {
    fixture = TestBed.createComponent(SavedCardRow);
    fixture.componentRef.setInput('card', props.card ?? CARD);
    fixture.componentRef.setInput('selected', props.selected ?? false);
    if (props.selectable !== undefined) fixture.componentRef.setInput('selectable', props.selectable);
    if (props.expired !== undefined) fixture.componentRef.setInput('expired', props.expired);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function query(root: HTMLElement, testid: string): HTMLElement | null {
    return root.querySelector(`[data-testid="${testid}"]`);
  }

  it('selected + default: subtle fill, navy stroke, badge shown, no "Set as default" link', () => {
    const root = render({ card: { ...CARD, isDefault: true }, selected: true, selectable: true });
    const row = query(root, 'saved-card-row');

    expect(row?.className).toContain('bg-surface-subtle');
    expect(row?.className).toContain('border-brand-navy');
    expect(query(root, 'default-badge')).not.toBeNull();
    expect(query(root, 'set-default-link')).toBeNull();
  });

  it('unselected, not default: line stroke and a "Set as default" link', () => {
    const root = render({ selected: false, selectable: true });
    const row = query(root, 'saved-card-row');

    expect(row?.className).toContain('border-line');
    expect(row?.className).not.toContain('border-brand-navy');
    expect(query(root, 'default-badge')).toBeNull();
    expect(query(root, 'set-default-link')).not.toBeNull();
  });

  it('expired: danger-red semibold expiry text, dimmed brand bubble, cannot be selected', () => {
    const root = render({ expired: true, selectable: true });

    const expiry = query(root, 'card-expiry');
    expect(expiry?.textContent).toContain('Expired');
    expect(expiry?.className).toContain('text-danger-red');
    expect(expiry?.className).toContain('font-semibold');

    const bubble = query(root, 'brand-bubble');
    expect(bubble?.className).toContain('bg-surface-subtle');

    const radio = query(root, 'radio');
    expect(radio?.getAttribute('aria-disabled')).toBe('true');
  });

  it('reads "Expires MM / YYYY" with a zero-padded month on a live card', () => {
    const root = render();

    expect(query(root, 'card-expiry')?.textContent?.trim()).toBe('Expires 04 / 2028');
  });

  /** The wire sends Stripe's lowercase slug; the design shows a display label. */
  it.each([
    ['visa', 'Visa'],
    ['mastercard', 'Mastercard'],
    ['amex', 'American Express'],
    ['unknown_brand', 'Card'],
  ])('renders brand %s as "%s"', (brand, label) => {
    const root = render({ card: { ...CARD, brand } });

    expect(query(root, 'card-brand')?.textContent).toContain(`${label} ···· 4242`);
  });

  it('renders a null brand and last4 without throwing', () => {
    const root = render({ card: { ...CARD, brand: null, last4: null } });

    expect(query(root, 'card-brand')?.textContent).toContain('Card');
  });

  /** No radio at all where the row is managed rather than chosen (profile). */
  it('omits the radio when not selectable', () => {
    const root = render({ selectable: false });

    expect(query(root, 'radio')).toBeNull();
  });

  it('emits the card id on select, set-default and remove', () => {
    const root = render({ selectable: true });
    const selected: string[] = [];
    const defaulted: string[] = [];
    const removed: string[] = [];
    fixture.componentInstance.cardSelected.subscribe((id: string) => selected.push(id));
    fixture.componentInstance.setDefault.subscribe((id: string) => defaulted.push(id));
    fixture.componentInstance.remove.subscribe((id: string) => removed.push(id));

    query(root, 'radio')?.click();
    query(root, 'set-default-link')?.click();
    query(root, 'remove-button')?.click();

    expect(selected).toEqual(['pm_1']);
    expect(defaulted).toEqual(['pm_1']);
    expect(removed).toEqual(['pm_1']);
  });

  /**
   * CONTRACT: An expired row emits nothing on click. Rendering it inert
   * visually while still emitting lets the buyer select a card the
   * PaymentIntent will decline. See [[2026-09-19-stripe-payments-design]]
   */
  it('emits no selection from an expired row', () => {
    const root = render({ expired: true, selectable: true });
    const selected: string[] = [];
    fixture.componentInstance.cardSelected.subscribe((id: string) => selected.push(id));

    query(root, 'radio')?.click();

    expect(selected).toEqual([]);
  });
});
