import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';

import { ApiClient, ApiError } from './api-client';

describe('ApiClient', () => {
  let api: ApiClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(ApiClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
    TestBed.resetTestingModule();
  });

  it('prefixes the path with the configured gateway base', async () => {
    const response = firstValueFrom(api.get<{ ok: boolean }>('/users/health'));

    const request = controller.expectOne('/v1/users/health');
    expect(request.request.method).toBe('GET');
    request.flush({ ok: true });

    await expect(response).resolves.toEqual({ ok: true });
  });

  it('sends each verb to the prefixed URL, with the body for those that carry one', () => {
    api.post('/cart', { items: ['a'] }).subscribe();
    const post = controller.expectOne((r) => r.method === 'POST');
    expect(post.request.url).toBe('/v1/cart');
    expect(post.request.body).toEqual({ items: ['a'] });
    post.flush({});

    api.put('/cart', { items: ['b'] }).subscribe();
    const put = controller.expectOne((r) => r.method === 'PUT');
    expect(put.request.url).toBe('/v1/cart');
    expect(put.request.body).toEqual({ items: ['b'] });
    put.flush({});

    api.patch('/users/me', { fullName: 'x' }).subscribe();
    const patch = controller.expectOne((r) => r.method === 'PATCH');
    expect(patch.request.url).toBe('/v1/users/me');
    expect(patch.request.body).toEqual({ fullName: 'x' });
    patch.flush({});

    api.delete('/cart').subscribe();
    const del = controller.expectOne((r) => r.method === 'DELETE');
    expect(del.request.url).toBe('/v1/cart');
    del.flush({});
  });

  // The gateway's own 401 body — the request never reached a service.
  it('rejects with an ApiError carrying the status and the parsed gateway body', async () => {
    const response = firstValueFrom(api.get('/products'));

    controller
      .expectOne('/v1/products')
      .flush({ message: 'Unauthorized' }, { status: 401, statusText: 'Unauthorized' });

    const error = (await response.catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.body).toEqual({ message: 'Unauthorized' });
    expect(error.detail).toBe('Unauthorized');
  });

  // services/users/openapi.yaml Error: {error: string}.
  it("reads the Users service's `error` field as the detail", async () => {
    const response = firstValueFrom(api.post('/users/login', {}));

    controller
      .expectOne('/v1/users/login')
      .flush({ error: 'Invalid credentials' }, { status: 401, statusText: 'Unauthorized' });

    const error = (await response.catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(401);
    expect(error.detail).toBe('Invalid credentials');
  });

  it("prefers `message` over `error` on a Fastify validation body", async () => {
    const response = firstValueFrom(api.post('/users/login', {}));

    // The real body from POST /v1/users/login with a malformed email, captured
    // live. `error` holds the status label; only `message` names the field.
    controller.expectOne('/v1/users/login').flush(
      {
        statusCode: 400,
        code: 'FST_ERR_VALIDATION',
        error: 'Bad Request',
        message: 'body/email Invalid email address',
      },
      { status: 400, statusText: 'Bad Request' },
    );

    const error = (await response.catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(400);
    expect(error.detail).toBe('body/email Invalid email address');
  });

  it("reads Tracking's `detail` field as the detail", async () => {
    const response = firstValueFrom(api.get('/trackings/t1'));

    controller
      .expectOne('/v1/trackings/t1')
      .flush({ detail: 'Not found', reason: 'unknown' }, { status: 404, statusText: 'Not Found' });

    const error = (await response.catch((e: unknown) => e)) as ApiError;
    expect(error.status).toBe(404);
    expect(error.body?.reason).toBe('unknown');
    expect(error.detail).toBe('Not found');
  });

  it('reports a transport failure as status 0 with a null body', async () => {
    const response = firstValueFrom(api.get('/products'));

    controller.expectOne('/v1/products').error(new ProgressEvent('error'));

    const error = (await response.catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(0);
    expect(error.body).toBeNull();
  });
});
