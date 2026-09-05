import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { CatalogueApi } from './catalogue-api';
import { ApiError } from '../http/api-client';
import type { Product } from './types';

describe('CatalogueApi', () => {
  let catalogueApi: CatalogueApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    catalogueApi = TestBed.inject(CatalogueApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('reads the catalogue from the prefixed /products path', () => {
    catalogueApi.listProducts().subscribe();

    const request = controller.expectOne('/v1/products');
    expect(request.request.method).toBe('GET');
    expect(request.request.url).not.toContain('/v1/v1/');
    request.flush([]);
  });

  it('passes the wire shape through with unitPrice as Money', () => {
    let received: Product[] | undefined;
    catalogueApi.listProducts().subscribe((products) => (received = products));

    controller.expectOne('/v1/products').flush([
      {
        id: 'prd_V1StGXR8Z5',
        name: 'Field Tote 18L',
        description: 'A tote.',
        unitPrice: { cents: 12800, amount: '128.00', formatted: '$128.00', currency: 'USD' },
        unitsInStock: 50,
        categories: ['BAGS'],
        image: null,
      },
    ]);

    expect(received?.[0].unitPrice.formatted).toBe('$128.00');
  });

  it('rejects with an ApiError the caller can branch on', async () => {
    const promise = new Promise<unknown>((resolve) => {
      catalogueApi.listProducts().subscribe({ error: resolve });
    });

    controller
      .expectOne('/v1/products')
      .flush({ message: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });

    const error = await promise;
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
  });
});
