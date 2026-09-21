import { HttpClient, HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { trace } from '@opentelemetry/api';
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

    async function withPageSpanOn(route: string): Promise<string> {
      setRumEnabled(true);
      initRum();
      await vi.waitFor(() => expect(getActivePageSpan()).toBeDefined(), {
        timeout: DYNAMIC_IMPORT_TIMEOUT,
      });
      notifyPageChanged(route);
      return getActivePageSpan()!.spanContext().traceId;
    }

    it(
      'gives the CLIENT span its own trace rather than the page span\'s',
      async () => {
        const pageTraceId = await withPageSpanOn('/orders');

        const { http, controller } = configure();
        http.get('/v1/products').subscribe();
        const req = controller.expectOne('/v1/products');
        req.flush({});

        // WHY: The propagator writes traceparent as
        // `00-<traceId>-<spanId>-<flags>` — the second segment is the CLIENT
        // span's trace id, and it differing from the page span's is what
        // makes the call its own trace instead of one row in the screen's.
        const traceparent = req.request.headers.get('traceparent');
        expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
        expect(traceparent?.split('-')[1]).not.toBe(pageTraceId);
      },
      DYNAMIC_IMPORT_TIMEOUT,
    );

    it(
      'links the CLIENT span to the page span and tags it with the page route',
      async () => {
        const pageSpanContext = { traceId: '', spanId: '' };
        // WORKAROUND(vitest): The link and attributes are only readable off
        // the startSpan() call — OTel's SDK Span exposes attributes but keeps
        // links private, and the interceptor's tracer is module-scoped.
        // getTracer() returns the same instance for the same name, so
        // spying here intercepts the interceptor's own calls.
        const started = vi.spyOn(trace.getTracer('3mrai-web'), 'startSpan');

        const pageTraceId = await withPageSpanOn('/orders/:orderId');
        pageSpanContext.traceId = pageTraceId;
        pageSpanContext.spanId = getActivePageSpan()!.spanContext().spanId;

        const { http, controller } = configure();
        http.get('/v1/products').subscribe();
        controller.expectOne('/v1/products').flush({});

        const options = started.mock.calls.at(-1)?.[1];
        expect(options?.links?.[0].context.traceId).toBe(pageSpanContext.traceId);
        expect(options?.links?.[0].context.spanId).toBe(pageSpanContext.spanId);
        expect(options?.attributes?.['page.route']).toBe('/orders/:orderId');
        started.mockRestore();
      },
      DYNAMIC_IMPORT_TIMEOUT,
    );
  });
});
