import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { PaymentMethodsApi } from './payment-methods-api';
import type { PaymentMethodView } from './types';

const SAVED: PaymentMethodView = {
  id: 'pm_1',
  type: 'card',
  brand: 'visa',
  last4: '4242',
  expMonth: 4,
  expYear: 2028,
  isDefault: true,
};

describe('PaymentMethodsApi', () => {
  let api: PaymentMethodsApi;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(PaymentMethodsApi);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('creates a SetupIntent and reads back its clientSecret', async () => {
    const received = new Promise((resolve) => api.createSetupIntent().subscribe(resolve));

    const request = controller.expectOne('/v1/users/me/payment-methods/setup-intent');
    expect(request.request.method).toBe('POST');
    expect(request.request.url).not.toContain('/v1/v1/');
    request.flush({ clientSecret: 'seti_1_secret_abc' });

    expect(await received).toEqual({ clientSecret: 'seti_1_secret_abc' });
  });

  it('lists the caller’s saved cards', async () => {
    const received = new Promise((resolve) => api.list().subscribe(resolve));

    const request = controller.expectOne('/v1/users/me/payment-methods');
    expect(request.request.method).toBe('GET');
    request.flush([SAVED]);

    expect(await received).toEqual([SAVED]);
  });

  it('attaches by posting paymentMethodId in the body', () => {
    api.attach('pm_new').subscribe();

    const request = controller.expectOne('/v1/users/me/payment-methods');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({ paymentMethodId: 'pm_new' });
    request.flush({ id: 'pm_new' });
  });

  it('detaches by id', () => {
    api.remove('pm_1').subscribe();

    const request = controller.expectOne('/v1/users/me/payment-methods/pm_1');
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('sets a default with PUT on the /default sub-path', () => {
    api.setDefault('pm_1').subscribe();

    const request = controller.expectOne('/v1/users/me/payment-methods/pm_1/default');
    expect(request.request.method).toBe('PUT');
    request.flush(null, { status: 204, statusText: 'No Content' });
  });

  /**
   * CONTRACT: A Stripe id is interpolated into the path, so it is encoded. An id
   * carrying a slash would otherwise change the route the gateway matches and
   * answer 404 from the gateway rather than from Users.
   */
  it('encodes the id in the path', () => {
    api.remove('pm_a/b').subscribe();

    const request = controller.expectOne('/v1/users/me/payment-methods/pm_a%2Fb');
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
  });
});
