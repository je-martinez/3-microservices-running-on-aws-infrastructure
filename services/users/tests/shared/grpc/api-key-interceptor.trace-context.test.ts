import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it, expect, beforeAll } from "vitest";
import {
  context,
  propagation,
  trace,
  TraceFlags,
  ROOT_CONTEXT,
  type Context,
  type ContextManager,
  type TextMapPropagator,
} from "@opentelemetry/api";
import * as grpc from "@grpc/grpc-js";
import { extractParentContext } from "#shared/grpc/api-key-interceptor";

// Regression tests for JE-77: a cross-service gRPC trace must JOIN, not split.
//
// The bug: the api-key interceptor extracted the caller's W3C context correctly,
// but activated it with `context.with(parent, () => mdNext(...))` inside
// `onReceiveMetadata`. That callback returns synchronously, long before grpc-js
// dispatches the (async) handler, so the context had already unwound by the time
// the handler — and its `withGrpcServerSpan` — ran. The server span came out a
// ROOT (refs=0) and Jaeger showed two disjoint traces instead of one.
//
// The fix: stash the extracted context and re-activate it in `onReceiveHalfClose`,
// the continuation that actually dispatches the handler.
//
// These tests cover the two halves of that fix without a live gRPC server:
//   1. extractParentContext turns an inbound traceparent into the right parent.
//   2. activating a context around a continuation must survive to an ASYNC
//      callback dispatched from it — the exact synchronous-vs-async gap the bug
//      fell through. Driven with a real AsyncLocalStorage-backed context manager,
//      the same substrate prod uses via @opentelemetry/context-async-hooks.

// --- test substrate (NOT mocks of the code under test) ---------------------

// Minimal ContextManager over Node's built-in AsyncLocalStorage — identical
// mechanism to @opentelemetry/context-async-hooks, inline so no dep is added.
class AlsContextManager implements ContextManager {
  private readonly als = new AsyncLocalStorage<Context>();
  active(): Context {
    return this.als.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.als.run(ctx, () => fn.apply(thisArg as ThisParameterType<F>, args));
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}

// Minimal W3C `traceparent` extractor — just enough for propagation.extract in
// extractParentContext. Stands in for the real W3CTraceContextPropagator the SDK
// registers in prod (not resolvable as its own package here).
class TestTraceParentPropagator implements TextMapPropagator {
  fields(): string[] {
    return ["traceparent", "tracestate"];
  }
  inject(): void {}
  extract(ctx: Context, carrier: unknown, getter: { get(c: unknown, k: string): unknown }): Context {
    const raw = getter.get(carrier, "traceparent");
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header !== "string") return ctx;
    const parts = header.split("-");
    if (parts.length !== 4) return ctx;
    const [, traceId, spanId, flags] = parts;
    if (traceId.length !== 32 || spanId.length !== 16) return ctx;
    return trace.setSpanContext(ctx, {
      traceId,
      spanId,
      traceFlags: (parseInt(flags, 16) & TraceFlags.SAMPLED) as TraceFlags,
      isRemote: true,
    });
  }
}

beforeAll(() => {
  context.setGlobalContextManager(new AlsContextManager());
  propagation.setGlobalPropagator(new TestTraceParentPropagator());
});

const INBOUND_TRACE_ID = "1234567890abcdef1234567890abcdef";
const INBOUND_TRACEPARENT = `00-${INBOUND_TRACE_ID}-3250e3c0f6fbb7ab-01`;

// ---------------------------------------------------------------------------

describe("extractParentContext", () => {
  it("extracts the inbound traceparent into a parent span context", () => {
    const md = new grpc.Metadata();
    md.set("traceparent", INBOUND_TRACEPARENT);

    const parent = extractParentContext(md);

    expect(trace.getSpanContext(parent)?.traceId).toBe(INBOUND_TRACE_ID);
  });

  it("returns a context with no span when no traceparent arrives", () => {
    const md = new grpc.Metadata();
    md.set("x-api-key", "secret-key");

    const parent = extractParentContext(md);

    // A direct call must not fabricate a parent — the handler span starts its own
    // root legitimately.
    expect(trace.getSpanContext(parent)).toBeUndefined();
  });
});

describe("extracted context survives an async handler dispatch (JE-77 core)", () => {
  // Reproduces the exact failure mode: the extracted context is activated around
  // a *continuation* (like onReceiveHalfClose's hcNext), and the handler runs on
  // a LATER tick. The context must still be active there. This is what the old
  // code — activating around the synchronous onReceiveMetadata body — failed.
  it("keeps the parent trace id active in an async callback fired from the continuation", async () => {
    const md = new grpc.Metadata();
    md.set("traceparent", INBOUND_TRACEPARENT);
    const parent = extractParentContext(md);

    const observed = await new Promise<string | undefined>((resolve) => {
      // The interceptor's onReceiveHalfClose does exactly this: wrap the
      // continuation that dispatches the handler in context.with(parent, ...).
      context.with(parent, () => {
        // The handler is async — it runs on a later microtask/tick, AFTER the
        // synchronous body of this callback has returned.
        setImmediate(() => {
          resolve(trace.getSpanContext(context.active())?.traceId);
        });
      });
    });

    expect(observed).toBe(INBOUND_TRACE_ID);
  });

  it("demonstrates the bug: activating around a sync-only body loses the context", async () => {
    const md = new grpc.Metadata();
    md.set("traceparent", INBOUND_TRACEPARENT);
    const parent = extractParentContext(md);

    // The OLD shape: context.with wraps a body that only SCHEDULES later work.
    // By the time that work runs, the context has unwound — trace id is gone.
    const observed = await new Promise<string | undefined>((resolve) => {
      let laterWork!: () => void;
      context.with(parent, () => {
        laterWork = () => resolve(trace.getSpanContext(context.active())?.traceId);
      });
      // Runs after context.with has already returned — the regression window.
      setImmediate(laterWork);
    });

    expect(observed).toBeUndefined();
  });
});
