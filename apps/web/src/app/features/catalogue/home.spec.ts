import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { HomePage } from './home';
import { awaitRequest, settle, textOf } from '../auth/testing';
import { PRODUCT, SCREEN_TEST_PROVIDERS, money } from '../../shared/testing/fixtures';

describe('HomePage', () => {
  let fixture: ComponentFixture<HomePage>;
  let controller: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        ...SCREEN_TEST_PROVIDERS,
      ],
    });
    await TestBed.compileComponents();
    controller = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(HomePage);
    fixture.detectChanges();
  });

  afterEach(() => {
    controller.verify({ ignoreCancelled: true });
    TestBed.resetTestingModule();
  });

  it('renders a loading state before the catalogue arrives', () => {
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(root.textContent).toContain('Loading products…');
    expect(root.querySelector('app-product-card')).toBeNull();

    controller.expectOne('/v1/products').flush([]);
  });

  it('reads the catalogue from /v1/products with no duplicated prefix', async () => {
    const request = await awaitRequest(fixture, controller, '/v1/products');
    expect(request.request.method).toBe('GET');
    expect(request.request.url).not.toContain('/v1/v1/');
    request.flush([]);
    await settle(fixture);
  });

  it('renders a card per product once loaded', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([
      PRODUCT,
      { ...PRODUCT, id: 'prd_second', name: 'Trail Cap', unitPrice: money(3200, '$32.00') },
    ]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('app-product-card')).toHaveLength(2);
    expect(root.querySelector('[aria-busy="true"]')).toBeNull();
    expect(root.textContent).toContain('2 products');
  });

  /**
   * CONTRACT: The rendered price is the server's `formatted` string CHARACTER
   * FOR CHARACTER. A component that rebuilt it from `cents` would still print
   * "$128.00" here, so the second case uses a `formatted` that no local
   * arithmetic on `cents` could produce. See [[money-representation]]
   */
  it('renders Money.formatted verbatim, never a recomputed price', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([
      PRODUCT,
      {
        ...PRODUCT,
        id: 'prd_thousands',
        name: 'Expedition Trunk',
        unitPrice: { cents: 100000, amount: '1000.00', formatted: '$1,000.00', currency: 'USD' },
      },
    ]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('$128.00');
    // A client dividing cents by 100 renders "$1000.00" — no thousands separator.
    expect(root.textContent).toContain('$1,000.00');
  });

  it('renders an error state with a retry that refetches', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush(
      { message: 'Service unavailable' },
      { status: 503, statusText: 'Service Unavailable' },
    );
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(textOf(fixture, '[role="alert"]')).toContain('We could not load the catalogue.');
    expect(root.querySelector('app-product-card')).toBeNull();

    root.querySelector<HTMLButtonElement>('[role="alert"] button')?.click();
    (await awaitRequest(fixture, controller, '/v1/products')).flush([PRODUCT]);
    await settle(fixture);

    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelectorAll('app-product-card')).toHaveLength(1);
  });

  it('renders an empty state rather than an error for an empty catalogue', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('No products are available right now.');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });
});
