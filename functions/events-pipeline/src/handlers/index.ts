import type { HandlerMap } from "#pipeline/process-record";

// The CQRS dispatch table: event `type` → handler. Adding a type is ONE entry
// here, with no change to src/handler.ts — see the milestone design spec's
// "Implementation order": USER_CREATED lands in Task 10 and ORDER_CREATED in
// Task 11, which is what proves that claim rather than assuming it.
export const handlers: HandlerMap = {};
