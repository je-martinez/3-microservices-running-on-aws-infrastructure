import 'fake-indexeddb/auto';

import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';

import { HomePage } from './home';
import { awaitRequest, settle, textOf } from '../auth/testing';
import { PRODUCT, SCREEN_TEST_PROVIDERS, money } from '../../shared/testing/fixtures';
import { CatalogueSearchStore } from '../../core/catalogue/catalogue-search-store';

/** The chip row's labels, in render order. */
function chipLabels(fixture: ComponentFixture<HomePage>): string[] {
  const root = fixture.nativeElement as HTMLElement;
  return [...root.querySelectorAll('button[aria-pressed]')].map((el) =>
    (el.textContent ?? '').trim(),
  );
}

/** The label of the chip currently in force. */
function pressedChip(fixture: ComponentFixture<HomePage>): string | undefined {
  const root = fixture.nativeElement as HTMLElement;
  const active = [...root.querySelectorAll('button[aria-pressed="true"]')];
  return active.length === 1 ? (active[0].textContent ?? '').trim() : undefined;
}

function clickChip(fixture: ComponentFixture<HomePage>, label: string): void {
  const root = fixture.nativeElement as HTMLElement;
  const chip = [...root.querySelectorAll('button[aria-pressed]')].find(
    (el) => (el.textContent ?? '').trim() === label,
  );
  if (!chip) throw new Error(`no chip labelled "${label}" — found: ${chipLabels(fixture).join(', ')}`);
  (chip as HTMLButtonElement).click();
  fixture.detectChanges();
}

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
    // CONTRACT: Clear the root-provided search store. It outlives a single test,
    // so a query left behind filters the NEXT test's grid and fails it while the
    // code under test is correct.
    TestBed.inject(CatalogueSearchStore).clear();
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

  /**
   * CONTRACT: The chips come from the products, never a constant. A hardcoded
   * list silently drops a category the catalogue gains — OUTERWEAR was missing
   * that way, so its product could not be reached by any chip.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  it('derives the chips from the loaded products, including a one-off category', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([
      PRODUCT,
      { ...PRODUCT, id: 'prd_boot', name: 'Wool Runner', categories: ['FOOTWEAR'] },
      { ...PRODUCT, id: 'prd_coat', name: 'Rain Shell', categories: ['OUTERWEAR'] },
    ]);
    await settle(fixture);

    const chips = chipLabels(fixture);
    expect(chips).toEqual(['All', 'Bags', 'Footwear', 'Outerwear']);
  });

  it('filters the grid to the chosen category and back with All', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([
      PRODUCT,
      { ...PRODUCT, id: 'prd_boot', name: 'Wool Runner', categories: ['FOOTWEAR'] },
    ]);
    await settle(fixture);

    clickChip(fixture, 'Footwear');
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('app-product-card')).toHaveLength(1);
    expect(root.textContent).toContain('Wool Runner');
    expect(root.textContent).not.toContain('Field Tote');
    expect(root.textContent).toContain('1 products');

    clickChip(fixture, 'All');
    await settle(fixture);
    expect(root.querySelectorAll('app-product-card')).toHaveLength(2);
    expect(root.textContent).toContain('2 products');
  });

  it('shows a product under every category it carries', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([
      { ...PRODUCT, id: 'prd_dual', name: 'Convertible Pack', categories: ['BAGS', 'OUTERWEAR'] },
    ]);
    await settle(fixture);

    expect(chipLabels(fixture)).toEqual(['All', 'Bags', 'Outerwear']);

    const root = fixture.nativeElement as HTMLElement;
    clickChip(fixture, 'Bags');
    await settle(fixture);
    expect(root.textContent).toContain('Convertible Pack');

    clickChip(fixture, 'Outerwear');
    await settle(fixture);
    expect(root.textContent).toContain('Convertible Pack');
  });

  it('marks the active chip with aria-pressed', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([PRODUCT]);
    await settle(fixture);

    expect(pressedChip(fixture)).toBe('All');
    clickChip(fixture, 'Bags');
    await settle(fixture);
    expect(pressedChip(fixture)).toBe('Bags');
  });

  /**
   * CONTRACT: Searching filters IN THE BROWSER. /v1/products takes no search
   * parameter, so a request issued while typing would be both useless and a
   * request per keystroke. `controller.verify()` in afterEach is what catches it.
   * See [[2026-09-04-web-gateway-integration-design]]
   */
  it('filters by name without issuing a request', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([
      PRODUCT,
      { ...PRODUCT, id: 'prd_boot', name: 'Wool Runner', categories: ['FOOTWEAR'] },
    ]);
    await settle(fixture);

    TestBed.inject(CatalogueSearchStore).setQuery('wool');
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('app-product-card')).toHaveLength(1);
    expect(root.textContent).toContain('Wool Runner');
    expect(root.textContent).toContain('1 products');
    controller.expectNone('/v1/products');
  });

  it('matches case-insensitively and on the description', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([
      PRODUCT,
      {
        ...PRODUCT,
        id: 'prd_shell',
        name: 'Rain Shell',
        description: 'A STORMPROOF layer.',
        categories: ['OUTERWEAR'],
      },
    ]);
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    TestBed.inject(CatalogueSearchStore).setQuery('stormproof');
    await settle(fixture);
    expect(root.textContent).toContain('Rain Shell');
    expect(root.textContent).not.toContain('Field Tote');

    TestBed.inject(CatalogueSearchStore).setQuery('RAIN');
    await settle(fixture);
    expect(root.querySelectorAll('app-product-card')).toHaveLength(1);
  });

  it('narrows by the chip AND the query together, not either', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([
      { ...PRODUCT, id: 'prd_a', name: 'Trail Bag', categories: ['BAGS'] },
      { ...PRODUCT, id: 'prd_b', name: 'Trail Boot', categories: ['FOOTWEAR'] },
    ]);
    await settle(fixture);

    TestBed.inject(CatalogueSearchStore).setQuery('trail');
    await settle(fixture);
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelectorAll('app-product-card')).toHaveLength(2);

    clickChip(fixture, 'Footwear');
    await settle(fixture);
    expect(root.querySelectorAll('app-product-card')).toHaveLength(1);
    expect(root.textContent).toContain('Trail Boot');
    expect(root.textContent).not.toContain('Trail Bag');
  });

  it('says no MATCHES, not no products, when a search finds nothing', async () => {
    (await awaitRequest(fixture, controller, '/v1/products')).flush([PRODUCT]);
    await settle(fixture);

    TestBed.inject(CatalogueSearchStore).setQuery('zzzz');
    await settle(fixture);

    const root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('No products match your search');
    expect(root.textContent).not.toContain('No products are available right now');
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
