import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { APP_CONFIG } from '../config/app-config';
import { TRACE_ID_BY_RESPONSE } from '../http/api-client';
import { getActivePageSpan, initRum, notifyPageChanged } from './rum';
import { rumPropagationInterceptor } from './rum-propagation-interceptor';

// WORKAROUND(vitest): trace.getTracer() falls back to the OTel API's no-op
// tracer, whose spans carry an all-zero SpanContext that the propagator
// correctly refuses to encode, until a TracerProvider is registered globally
// — main.ts does this via rum.ts's initRum(), which never runs in an
// isolated spec. No exporter is wired: this only needs startSpan() to
// produce a valid SpanContext, not to deliver anything anywhere.
beforeAll(() => {
  new WebTracerProvider().register();
});

// WHY: Mirrors rum.spec.ts — real dynamic import() past vitest's 5000ms
// default, needed to make getActivePageSpan()/notifyPageChanged() live for
// the parenting specs below.
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

describe('rumPropagationInterceptor', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.resetTestingModule();
  });

  it('sets traceparent on a gateway request', async () => {
    const { http, controller } = configure();

    http.get('/v1/products').subscribe();
    const req = controller.expectOne('/v1/products');

    expect(req.request.headers.has('traceparent')).toBe(true);
    req.flush({});
  });

  it('does not set traceparent on the /otlp export itself', async () => {
    const { http, controller } = configure();

    http.post('/otlp/v1/traces', {}).subscribe();
    const req = controller.expectOne('/otlp/v1/traces');

    expect(req.request.headers.has('traceparent')).toBe(false);
    req.flush({});
  });

  it('records the span traceId against a failed gateway response for ApiClient to pick up', async () => {
    const { http, controller } = configure();
    let capturedError: unknown;

    http.get('/v1/products').subscribe({ error: (err: unknown) => (capturedError = err) });
    const req = controller.expectOne('/v1/products');
    req.flush({ message: 'boom' }, { status: 500, statusText: 'Internal Server Error' });

    expect(capturedError).toBeInstanceOf(HttpErrorResponse);
    const traceId = TRACE_ID_BY_RESPONSE.get(capturedError as HttpErrorResponse);
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  describe('with a page span active', () => {
    afterEach(() => {
      setRumEnabled(false);
      vi.clearAllMocks();
    });

    it(
      'shares the page span trace with the CLIENT span it starts',
      async () => {
        setRumEnabled(true);
        initRum();
        await vi.waitFor(() => expect(getActivePageSpan()).toBeDefined(), {
          timeout: DYNAMIC_IMPORT_TIMEOUT,
        });
        notifyPageChanged('/orders');
        const pageTraceId = getActivePageSpan()?.spanContext().traceId;

        const { http, controller } = configure();
        http.get('/v1/products').subscribe();
        const req = controller.expectOne('/v1/products');
        req.flush({});

        // WHY: The propagator writes traceparent as
        // `00-<traceId>-<spanId>-<flags>` — the second segment is the CLIENT
        // span's trace id, which equals the page span's only when the page
        // span was its parent.
        const traceparent = req.request.headers.get('traceparent');
        expect(traceparent?.split('-')[1]).toBe(pageTraceId);
      },
      DYNAMIC_IMPORT_TIMEOUT,
    );
  });
});
