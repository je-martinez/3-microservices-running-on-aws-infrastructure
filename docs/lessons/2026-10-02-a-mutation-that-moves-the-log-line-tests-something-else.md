---
title: A mutation that moves the log line tests something else
type: lesson
area: shared
status: active
created: 2026-10-02
updated: 2026-10-02
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/low
related:
  - "[[count-only-assertions-hide-cause]]"
  - "[[logging-context]]"
  - "[[testing]]"
---

# A mutation that moves the log line tests something else

## What happened

While mutation-testing that a failure log line carries the publish span's `span_id`, the first mutation deferred the line with `setImmediate`. The test failed, but for "line missing": the deferred line fell outside `captureAppLogs`' window. That failure says nothing about span stamping.

## The mutation that tests the property

Keep the line synchronous and emit it with the span deactivated:

```ts
context.with(trace.deleteSpan(context.active()), () => log.error(...))
```

The line is still captured, so the test now fails on the wrong (or absent) `span_id`, which is the property under test.

## Rule

A mutation breaks exactly the property under test and nothing else. Read the failure message, not just the red status: "line missing" and "wrong span_id" are different findings. See [[count-only-assertions-hide-cause]] for the same failure mode in assertions.

## Related

- [[count-only-assertions-hide-cause]]
- [[logging-context]]
- [[testing]]
