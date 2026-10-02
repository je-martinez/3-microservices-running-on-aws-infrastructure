import { describe, expect, it } from "vitest";
import * as grpc from "@grpc/grpc-js";
import { context, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { extractParentContext } from "#shared/grpc/api-key-interceptor";

// Relies on the provider tests/setup.ts registers, which installs the W3C
// trace-context propagator the SDK uses in production.
const INBOUND_TRACE_ID = "1234567890abcdef1234567890abcdef";
const INBOUND_SPAN_ID = "3250e3c0f6fbb7ab";
const INBOUND_TRACEPARENT = `00-${INBOUND_TRACE_ID}-${INBOUND_SPAN_ID}-01`;

describe("extractParentContext", () => {
  it("extracts the inbound traceparent into a remote parent span context", () => {
    const md = new grpc.Metadata();
    md.set("traceparent", INBOUND_TRACEPARENT);

    const parent = trace.getSpanContext(extractParentContext(md));

    expect(parent).toMatchObject({
      traceId: INBOUND_TRACE_ID,
      spanId: INBOUND_SPAN_ID,
      isRemote: true,
    });
  });

  it("carries tracestate alongside traceparent", () => {
    const md = new grpc.Metadata();
    md.set("traceparent", INBOUND_TRACEPARENT);
    md.set("tracestate", "vendor=abc");

    const parent = trace.getSpanContext(extractParentContext(md));

    expect(parent?.traceState?.get("vendor")).toBe("abc");
  });

  it("returns a context with no span when no traceparent arrives", () => {
    const md = new grpc.Metadata();
    md.set("x-api-key", "secret-key");

    // A direct call must not fabricate a parent — the handler span starts its
    // own root legitimately.
    expect(trace.getSpanContext(extractParentContext(md))).toBeUndefined();
  });

  it("returns the active context unchanged when no traceparent arrives", () => {
    const md = new grpc.Metadata();

    const extracted = context.with(ROOT_CONTEXT, () => extractParentContext(md));

    expect(extracted).toBe(ROOT_CONTEXT);
  });
});
