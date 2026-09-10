import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LucideMinus, LucidePlus, LucideTriangleAlert, provideLucideIcons } from '@lucide/angular';

import { CartLine } from './cart-line';
import { cartLine, money, unavailableLine } from '../testing/fixtures';

describe('CartLine', () => {
  let fixture: ComponentFixture<CartLine>;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideLucideIcons(LucideMinus, LucidePlus, LucideTriangleAlert)],
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(CartLine);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  function render(line: Parameters<typeof fixture.componentRef.setInput>[1]): HTMLElement {
    fixture.componentRef.setInput('line', line);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  /**
   * CONTRACT: The server's `formatted` string, character for character. A
   * component rebuilding it from `cents` would print "$256.00" for the ordinary
   * case, so this fixture uses a string no local arithmetic can produce.
   * See [[money-representation]]
   */
  it('renders the subtotal formatted string verbatim', () => {
    const root = render(cartLine({ subtotal: money(25600, 'USD 256.00 per line') }));

    expect(root.textContent).toContain('USD 256.00 per line');
  });

  /**
   * CONTRACT: THE render trap. `insufficient_stock` leaves name, price, subtotal
   * and image POPULATED — guarding any of them on `available` blanks the price
   * of every low-stock line while still passing a badge-only assertion.
   */
  it.each(['insufficient_stock', 'out_of_stock'] as const)(
    'keeps the price of a %s line while badging it',
    (reason) => {
      const root = render(unavailableLine(reason));

      expect(root.textContent).toContain('$256.00');
      expect(root.textContent).toContain('Field Tote 18L');
      expect(root.querySelector('svg')).toBeTruthy();
    },
  );

  /** The other branch: unknown_product nulls all four and must not throw. */
  it('renders a delisted line with no price and no crash', () => {
    const root = render(unavailableLine('unknown_product'));

    expect(root.textContent).toContain('no longer available');
    expect(root.textContent).not.toContain('$');
    expect(root.querySelector('img')).toBeNull();
  });

  it('shows the quantity coerced from its IntLike wire form', () => {
    const root = render(cartLine({ quantity: '7', unitsInStock: '50' }));

    expect(root.textContent).toContain('7');
  });

  /**
   * CONTRACT: The stepper stops at the stock the server reports. Offering a
   * quantity above it produces a PUT the server rejects.
   */
  it('cannot increment past the units in stock', () => {
    const root = render(cartLine({ quantity: 5, unitsInStock: 5 }));

    const plus = root.querySelector<HTMLButtonElement>('[aria-label="Increase quantity"]');
    expect(plus?.disabled).toBe(true);
  });

  /**
   * CONTRACT: At quantity 1 the minus button REMOVES the line — the server has
   * no per-line DELETE, so a stepper that merely floors at 1 leaves the buyer
   * unable to take an item out.
   */
  it('emits removal rather than a decrement at quantity 1', () => {
    let removed = 0;
    let decremented = 0;
    fixture.componentRef.setInput('line', cartLine({ quantity: 1 }));
    fixture.componentInstance.removed.subscribe(() => (removed += 1));
    fixture.componentInstance.decrement.subscribe(() => (decremented += 1));
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[aria-label^="Remove"]')
      ?.click();

    expect(removed).toBe(1);
    expect(decremented).toBe(0);
  });

  it('hides the stepper where the line is a receipt', () => {
    fixture.componentRef.setInput('line', cartLine());
    fixture.componentRef.setInput('readonlyQuantity', true);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('[aria-label="Increase quantity"]')).toBeNull();
    expect(root.textContent).toContain('Qty 2');
  });
});
