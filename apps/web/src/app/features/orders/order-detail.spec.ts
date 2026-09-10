import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';

import { OrderDetailPage } from './order-detail';
import { SessionStore } from '../../core/auth/session-store';
import { settle, textOf, USER } from '../auth/testing';
import {
  awaitPath,
  ORDER_WITHOUT_SNAPSHOT,
  ORDER_WITH_TRACKING,
  PRODUCT,
  PRODUCT_IMAGE,
  SCREEN_TEST_PROVIDERS,
} from '../../shared/testing/fixtures';

const ORDER_URL = '/v1/orders/ord_3kLpQx8vRn';
const PRODUCTS_URL = '/v1/products';

/** ActivatedRoute stub: the page reads `orderId` from the param map. */
function routeStub(orderId: string) {
  const paramMap = convertToParamMap({ orderId });
  return { paramMap: of(paramMap), snapshot: { paramMap } };
}

describe('OrderDetailPage', () => {
  let fixture: ComponentFixture<OrderDetailPage>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ActivatedRoute, useValue: routeStub('ord_3kLpQx8vRn') },
        ...SCREEN_TEST_PROVIDERS,
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(OrderDetailPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
    history.replaceState(null, '', location.pathname);
  });

  /**
   * Rebuilds the page after seeding the navigation state the checkout redirect
   * carries. The default fixture is already built by `beforeEach`, and
   * `justPlaced` is read once at construction — so a banner test has to
   * construct its own.
   */
  function recreateWithState(state: unknown): void {
    fixture.destroy();
    // CONTRACT: Drain the first fixture's in-flight requests before building
    // the second. `awaitPath` returns the FIRST match for a URL, so leaving
    // them queued makes it flush the dead page's request and the new one hangs
    // on a load that never resolves.
    controller.match(() => true).forEach((request) => request.flush(null));
    history.replaceState(state, '', location.pathname);
    fixture = TestBed.createComponent(OrderDetailPage);
    fixture.detectChanges();
  }

  /** Answers both in-flight requests; the page loads them in parallel. */
  async function loadOrder(entry: object = ORDER_WITH_TRACKING): Promise<void> {
    (await awaitPath(fixture, controller, ORDER_URL)).flush(entry);
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([PRODUCT]);
    await settle(fixture);
  }

  it('renders a loading state before the order arrives', () => {
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[aria-busy="true"]')).toBeTruthy();

    controller.expectOne((r) => r.url === ORDER_URL).flush(ORDER_WITH_TRACKING);
    controller.expectOne(PRODUCTS_URL).flush([]);
  });

  /**
   * CONTRACT: Without `includeTracking=true` the route answers a bare Order, so
   * `entry.order` reads undefined and this page renders "Order not found" on a
   * 200. See [[openapi-specs]]
   */
  it('requests the tracking envelope for the order', async () => {
    const request = await awaitPath(fixture, controller, ORDER_URL);
    expect(request.request.params.get('includeTracking')).toBe('true');
    request.flush(ORDER_WITH_TRACKING);
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([PRODUCT]);
    await settle(fixture);
  });

  /**
   * CONTRACT: The <h1> is the FORMATTED order number, rendered verbatim — this
   * heading is the largest text on the page and the thing a customer quotes to
   * support, which is the whole reason the number exists. The page must not
   * build the displayed form itself. See [[friendly-order-number]]
   */
  it('titles the page with the formatted order number', async () => {
    await loadOrder();

    const heading = (fixture.nativeElement as HTMLElement).querySelector('h1');
    expect(heading?.textContent?.trim()).toBe('260815-8KJ4M2');
  });

  /** An order predating the backfill still needs a heading — the id. */
  it('titles the page with the id when the order has no number', async () => {
    await loadOrder({
      ...ORDER_WITH_TRACKING,
      order: { ...ORDER_WITH_TRACKING.order, orderNumber: null },
    });

    const heading = (fixture.nativeElement as HTMLElement).querySelector('h1');
    expect(heading?.textContent?.trim()).toBe('ord_3kLpQx8vRn');
  });

  it('renders every Money field as the server formatted it', async () => {
    await loadOrder();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('$128.00'); // subtotal
    expect(root.textContent).toContain('$10.24'); // tax
    expect(root.textContent).toContain('$5.00'); // shipping
    expect(root.textContent).toContain('$143.24'); // order total
    expect(root.textContent).toContain('$138.24'); // line total, no shipping
  });

  it('labels free shipping off cents while still showing server strings', async () => {
    await loadOrder({
      ...ORDER_WITH_TRACKING,
      order: {
        ...ORDER_WITH_TRACKING.order,
        shipping: { cents: 0, amount: '0.00', formatted: '$0.00', currency: 'USD' },
      },
    });

    expect(fixture.nativeElement.textContent).toContain('Free');
  });

  it('joins lines against the catalogue to name them', async () => {
    await loadOrder();
    expect(fixture.nativeElement.textContent).toContain('Field Tote 18L');
  });

  /**
   * CONTRACT: The image comes off the LINE, never the catalogue. `PRODUCT.image`
   * is null in the fixtures, so a page reading the joined product instead would
   * show the placeholder here and this assertion would fail.
   */
  it('renders the line thumbnail from the order snapshot', async () => {
    await loadOrder();
    const image = (fixture.nativeElement as HTMLElement).querySelector('img');

    expect(image?.getAttribute('src')).toBe(PRODUCT_IMAGE.uri);
    expect(image?.className).toContain('object-cover');
  });

  it('keeps the placeholder for a line placed before the snapshot', async () => {
    await loadOrder({ order: ORDER_WITHOUT_SNAPSHOT, tracking: null });
    const root = fixture.nativeElement as HTMLElement;

    expect(root.querySelector('img')).toBeNull();
    // The catalogue still names it, which is the only reason it rides along.
    expect(root.textContent).toContain('Field Tote 18L');
  });

  /**
   * CONTRACT: An order is a receipt. The snapshot on the line wins over the
   * catalogue, so a product renamed after purchase still shows its old name.
   */
  it('prefers the snapshot name over a product renamed since', async () => {
    (await awaitPath(fixture, controller, ORDER_URL)).flush(ORDER_WITH_TRACKING);
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([
      { ...PRODUCT, name: 'Field Tote 18L (2027 Edition)' },
    ]);
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('Field Tote 18L');
    expect(fixture.nativeElement.textContent).not.toContain('2027 Edition');
  });

  /**
   * Only a line with NO snapshot can reach the fallback: a snapshotted line
   * names itself even for a product long gone from the catalogue.
   */
  it('names a delisted line rather than dropping it', async () => {
    (await awaitPath(fixture, controller, ORDER_URL)).flush({
      order: ORDER_WITHOUT_SNAPSHOT,
      tracking: null,
    });
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([]);
    await settle(fixture);

    expect(fixture.nativeElement.textContent).toContain('Product no longer listed');
  });

  it('renders the tracking timeline from history', async () => {
    await loadOrder();
    expect(fixture.nativeElement.textContent).toContain('Placed');
  });

  it('reads the delivery address from the signed-in user', async () => {
    TestBed.inject(SessionStore).setUser({
      ...USER,
      fullName: 'Morgan Reyes',
      address: {
        line1: '482 Birch Hollow Lane',
        line2: null,
        city: 'Portland',
        state: 'OR',
        postalCode: '97201',
        country: 'US',
      },
    });
    await loadOrder();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Morgan Reyes');
    expect(root.textContent).toContain('482 Birch Hollow Lane');
  });

  /**
   * CONTRACT: The banner is one-shot — it rides in navigation state, so it must
   * NOT come back on a reload or a later visit to the same order. The two tests
   * below are the pair that proves it; keep them together.
   */
  it('greets the buyer with the success banner right after checkout', async () => {
    TestBed.inject(SessionStore).setUser({ ...USER, email: 'morgan@example.com' });
    recreateWithState({ justPlaced: true });
    await loadOrder();

    const banner = fixture.nativeElement.querySelector('[data-testid="order-placed-banner"]');
    expect(banner).toBeTruthy();
    expect(banner.textContent).toContain('Thank you for your order');
    expect(banner.textContent).toContain('morgan@example.com');
    expect(banner.textContent).not.toContain('jose@3mrai.com');
  });

  it('hides the success banner when the order is opened without that state', async () => {
    recreateWithState({});
    await loadOrder();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="order-placed-banner"]')).toBeNull();
    expect(root.textContent).not.toContain('Thank you for your order');
  });

  it('renders a not-found state for a 404, distinct from an error', async () => {
    (await awaitPath(fixture, controller, ORDER_URL)).flush(
      { message: 'Not Found' },
      { status: 404, statusText: 'Not Found' },
    );
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('Order not found.');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('renders an error state with a retry for a failure', async () => {
    (await awaitPath(fixture, controller, ORDER_URL)).flush(
      { message: 'Service unavailable' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    (await awaitPath(fixture, controller, PRODUCTS_URL)).flush([]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(textOf(fixture, '[role="alert"]')).toContain('We could not load this order.');

    root.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    await loadOrder();

    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.textContent).toContain('$143.24');
  });
});
