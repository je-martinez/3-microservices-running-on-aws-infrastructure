import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { CartApi } from './cart-api';
import { EMPTY_CART, cart, cartLine } from '../../shared/testing/fixtures';

describe('CartApi', () => {
  let cartApi: CartApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    cartApi = TestBed.inject(CartApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('reads the cart from /v1/cart with no duplicated prefix', () => {
    cartApi.getCart().subscribe();

    const request = controller.expectOne('/v1/cart');
    expect(request.request.method).toBe('GET');
    expect(request.request.url).not.toContain('/v1/v1/');
    request.flush(EMPTY_CART);
  });

  /**
   * CONTRACT: A user with no cart gets 200 and `id: null`, never a 404. A caller
   * treating an absent cart as an error path shows a first-time buyer an error
   * screen instead of an empty cart.
   */
  it('reads an absent cart as a 200 with a null id', async () => {
    const received = new Promise((resolve) => cartApi.getCart().subscribe(resolve));

    controller.expectOne('/v1/cart').flush(EMPTY_CART);

    expect(await received).toMatchObject({ id: null, items: [] });
  });

  it('sends PUT /cart as an items array of productId and quantity', () => {
    cartApi.replaceCart([{ productId: 'prd_V1StGXR8Z5', quantity: 3 }]).subscribe();

    const request = controller.expectOne('/v1/cart');
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toEqual({
      items: [{ productId: 'prd_V1StGXR8Z5', quantity: 3 }],
    });
    request.flush(cart([cartLine({ quantity: 3 })]));
  });

  /** An empty `items` is how the server is told to delete the cart. */
  it('sends an empty items array rather than omitting the key', () => {
    cartApi.replaceCart([]).subscribe();

    const request = controller.expectOne('/v1/cart');
    expect(request.request.body).toEqual({ items: [] });
    request.flush(EMPTY_CART);
  });

  /**
   * CONTRACT: DELETE answers 204 with NO body. Flushing `null` here is what the
   * wire actually looks like; a spec that flushes an object would pass while the
   * real response broke a caller trying to parse one.
   */
  it('deletes the cart and tolerates the empty 204 body', async () => {
    let completed = false;
    cartApi.deleteCart().subscribe({ complete: () => (completed = true) });

    const request = controller.expectOne('/v1/cart');
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });

    await Promise.resolve();
    expect(completed).toBe(true);
  });
});
