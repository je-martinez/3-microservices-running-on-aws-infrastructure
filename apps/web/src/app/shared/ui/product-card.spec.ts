import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ProductCard } from './product-card';
import { CartStore } from '../../core/cart/cart-store';
import { awaitRequest, settle } from '../../features/auth/testing';
import { PRODUCT, SCREEN_TEST_PROVIDERS, cart, cartLine } from '../testing/fixtures';

/** The gateway path both the cart read and the cart write land on. */
const CART_URL = '/v1/cart';

/** Comfortably past CartStore's 350ms quantity debounce. */
const DEBOUNCE_ADVANCE_MS = 500;

/**
 * CONTRACT: Restore real timers before pumping. `settle()` awaits a `setTimeout`
 * of its own, and under fake timers nothing advances it — the helper hangs until
 * the test times out, reporting a stall rather than the missing PUT the
 * assertion is about. See [[2026-09-04-angular-http-testing-traps]]
 */
async function flushDebounce(fixture: ComponentFixture<unknown>): Promise<void> {
  vi.advanceTimersByTime(DEBOUNCE_ADVANCE_MS);
  vi.useRealTimers();
  await settle(fixture);
}

describe('ProductCard', () => {
  let fixture: ComponentFixture<ProductCard>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), ...SCREEN_TEST_PROVIDERS],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(ProductCard);
  });

  afterEach(() => {
    TestBed.inject(CartStore).forgetAfterCheckout();
    TestBed.resetTestingModule();
  });

  function root(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function render(product = PRODUCT): HTMLElement {
    fixture.componentRef.setInput('product', product);
    fixture.detectChanges();
    return root();
  }

  /** Seeds the store so the card sees a cart holding `quantity` of PRODUCT. */
  async function seedCart(quantity: number): Promise<void> {
    const store = TestBed.inject(CartStore);
    const loading = store.load();
    const request = await awaitRequest(fixture, controller, CART_URL);
    request.flush(
      cart([cartLine({ productId: PRODUCT.id, quantity, unitsInStock: PRODUCT.unitsInStock })]),
    );
    await loading;
    fixture.detectChanges();
  }

  it('shows the Add button and no chip when the cart does not hold it', () => {
    render();

    expect(root().querySelector('[data-testid="product-card-add"]')).toBeTruthy();
    expect(root().querySelector('.in-cart-chip.is-shown')).toBeNull();
    expect(root().querySelector('.qty-morph.in-cart')).toBeNull();
  });

  it('shows the stepper and the chip once the cart holds it', async () => {
    render();
    await seedCart(1);

    expect(root().querySelector('.qty-morph.in-cart')).toBeTruthy();
    expect(root().querySelector('.in-cart-chip.is-shown')).toBeTruthy();
    expect(root().querySelector('[data-testid="cart-line-quantity"]')?.textContent?.trim()).toBe(
      '1',
    );
  });

  /**
   * CONTRACT: The card reads the STORE, not a local counter. A buyer who
   * increments in the drawer and comes back must see the drawer's number.
   */
  it('follows a quantity changed from another surface', async () => {
    render();
    await seedCart(1);

    TestBed.inject(CartStore).adjustQuantity(PRODUCT.id, 5);
    fixture.detectChanges();

    expect(root().querySelector('[data-testid="cart-line-quantity"]')?.textContent?.trim()).toBe(
      '5',
    );
  });

  /**
   * CONTRACT: Out of stock while held still renders the stepper. Hiding it
   * leaves the buyer no way to remove the item they can no longer buy more of.
   */
  it('keeps the stepper for a held product that ran out of stock', async () => {
    render({ ...PRODUCT, unitsInStock: 0 });
    const store = TestBed.inject(CartStore);
    const loading = store.load();
    const request = await awaitRequest(fixture, controller, CART_URL);
    request.flush(cart([cartLine({ productId: PRODUCT.id, quantity: 2, unitsInStock: 0 })]));
    await loading;
    fixture.detectChanges();

    expect(root().querySelector('.qty-morph.in-cart')).toBeTruthy();
    expect(root().querySelector<HTMLButtonElement>('[data-testid="qty-increase"]')?.disabled).toBe(
      true,
    );
    expect(root().querySelector('[data-testid="qty-decrease"]')).toBeTruthy();
  });

  it('shows Out of stock instead of the control when not held', () => {
    render({ ...PRODUCT, unitsInStock: 0 });

    expect(root().textContent).toContain('Out of stock');
    expect(root().querySelector('.qty-morph')).toBeNull();
  });

  /**
   * CONTRACT: A failed PUT must morph the control BACK. The store drops its
   * optimistic overlay on failure, so a card holding its own `inCart` flag
   * would strand an empty stepper over a product the cart does not hold.
   */
  it('morphs back to Add when the add fails', async () => {
    render();
    vi.useFakeTimers();
    void TestBed.inject(CartStore).add(PRODUCT.id);
    await flushDebounce(fixture);
    const write = await awaitRequest(fixture, controller, CART_URL);
    expect(write.request.method).toBe('PUT');
    write.flush({ message: 'nope' }, { status: 500, statusText: 'Server Error' });
    await settle(fixture);

    expect(root().querySelector('.qty-morph.in-cart')).toBeNull();
    expect(root().querySelector('[data-testid="product-card-add"]')).toBeTruthy();
  });
});
