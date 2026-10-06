import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { trace } from '@opentelemetry/api';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { APP_CONFIG } from '../config/app-config';
import { TRACE_ID_BY_RESPONSE } from '../http/api-client';
import { getActivePageSpan, initRum, isRumStarted, notifyPageChanged } from './rum';
import { rumPropagationInterceptor } from './rum-propagation-interceptor';

// WHY: initRum()'s real `import('./rum-sdk')` runs here past vitest's 5000ms
// default — the Angular unit-test harness rejects vi.mock on relative imports.
const DYNAMIC_IMPORT_TIMEOUT = 15000;

function setRumEnabled(value: boolean): void {
  Object.defineProperty(APP_CONFIG, 'rumEnabled', { value, configurable: true });
}

function configure(): { http: HttpClient; controller: HttpTestingController } {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([rumPropagationInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  return {
    http: TestBed.inject(HttpClient),
    controller: TestBed.inject(HttpTestingController),
  };
}

afterEach(() => {
  TestBed.inject(HttpTestingController).verify();
  TestBed.resetTestingModule();
});

// WARNING: Must stay before the SDK-loaded block — the SDK is a module-level
// singleton for this file's lifetime and never unloads once started.
describe('rumPropagationInterceptor before the SDK has loaded', () => {
  it('passes a gateway request through without traceparent', () => {
    const { http, controller } = configure();

    http.get('/v1/products').subscribe();
    const req = controller.expectOne('/v1/products');

    expect(isRumStarted()).toBe(false);
    expect(req.request.headers.has('traceparent')).toBe(false);
    req.flush({});
  });

  it('records no trace id against a failed gateway response', () => {
    const { http, controller } = configure();
    let capturedError: unknown;

    http.get('/v1/products').subscribe({ error: (err: unknown) => (capturedError = err) });
    controller
      .expectOne('/v1/products')
      .flush({ message: 'boom' }, { status: 500, statusText: 'Internal Server Error' });

    expect(capturedError).toBeInstanceOf(HttpErrorResponse);
    expect(TRACE_ID_BY_RESPONSE.has(capturedError as HttpErrorResponse)).toBe(false);
  });
});

describe('rumPropagationInterceptor with the SDK loaded', () => {
  beforeAll(async () => {
    setRumEnabled(true);
    initRum();
    await vi.waitFor(() => expect(isRumStarted()).toBe(true), {
      timeout: DYNAMIC_IMPORT_TIMEOUT,
    });
  }, DYNAMIC_IMPORT_TIMEOUT);

  afterAll(() => {
    setRumEnabled(false);
  });

  it('sets traceparent on a gateway request', () => {
    const { http, controller } = configure();

    http.get('/v1/products').subscribe();
    const req = controller.expectOne('/v1/products');

    expect(req.request.headers.get('traceparent')).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/,
    );
    req.flush({});
  });

  it('does not set traceparent on the /otlp export itself', () => {
    const { http, controller } = configure();

    http.post('/otlp/v1/traces', {}).subscribe();
    const req = controller.expectOne('/otlp/v1/traces');

    expect(req.request.headers.has('traceparent')).toBe(false);
    req.flush({});
  });

  it('records the span traceId against a failed gateway response for ApiClient to pick up', () => {
    const { http, controller } = configure();
    let capturedError: unknown;

    http.get('/v1/products').subscribe({ error: (err: unknown) => (capturedError = err) });
    const req = controller.expectOne('/v1/products');
    const traceparentTraceId = req.request.headers.get('traceparent')?.split('-')[1];
    req.flush({ message: 'boom' }, { status: 500, statusText: 'Internal Server Error' });

    expect(capturedError).toBeInstanceOf(HttpErrorResponse);
    const traceId = TRACE_ID_BY_RESPONSE.get(capturedError as HttpErrorResponse);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(traceId).toBe(traceparentTraceId);
  });

  it('gives the CLIENT span its own trace rather than the page span\'s', () => {
    notifyPageChanged('/orders');
    const pageTraceId = getActivePageSpan()!.spanContext().traceId;

    const { http, controller } = configure();
    http.get('/v1/products').subscribe();
    const req = controller.expectOne('/v1/products');
    req.flush({});

    // WHY: The propagator writes traceparent as
    // `00-<traceId>-<spanId>-<flags>` — the second segment is the CLIENT
    // span's trace id, and it differing from the page span's is what makes
    // the call its own trace instead of one row in the screen's.
    expect(req.request.headers.get('traceparent')?.split('-')[1]).not.toBe(pageTraceId);
  });

  it('links the CLIENT span to the page span and tags it with the page route', () => {
    // WORKAROUND(vitest): The link and attributes are only readable off the
    // startSpan() call — OTel's SDK Span exposes attributes but keeps links
    // private. getTracer() returns the same instance for the same name, so
    // spying here intercepts rum-sdk.ts's own calls.
    const started = vi.spyOn(trace.getTracer('3mrai-web'), 'startSpan');
    notifyPageChanged('/orders/:orderId');
    const page = getActivePageSpan()!.spanContext();

    const { http, controller } = configure();
    http.get('/v1/products').subscribe();
    controller.expectOne('/v1/products').flush({});

    const options = started.mock.calls.at(-1)?.[1];
    expect(options?.links?.[0].context.traceId).toBe(page.traceId);
    expect(options?.links?.[0].context.spanId).toBe(page.spanId);
    expect(options?.attributes?.['page.route']).toBe('/orders/:orderId');
    started.mockRestore();
  });
});
