---
title: "test.skip inside test.step aborts the whole test, not the step"
type: lesson
area: shared
status: active
created: 2026-10-06
updated: 2026-10-06
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[testing]]"
  - "[[2026-09-19-stripe-payments-design]]"
---

# test.skip inside test.step aborts the whole test, not the step

For an **optional** step in a Playwright test (for example "assert against Stripe only if keys are configured"), never call `test.skip(...)` inside `test.step`. Use a conditional `return` from the step and push an annotation so the skip is visible in the report:

```ts
test.info().annotations.push({ type: 'stripe-unchecked', description });
return;
```

## Symptom

`test.skip` throws and ends the **test body**, not the step. Every step after it silently never runs, and the test reports as SKIPPED instead of PASSED. The later assertions look covered but are not.

## Evidence

Found 2026-10-06 while adding first-card-is-default coverage to `e2e/tests/payment-methods.spec.ts` and `e2e/tests/gateway/payment-methods.spec.ts`. The Stripe check was made optional with the return-plus-annotation form, and the JSON reporter's `annotations=[]` on a keyed run confirmed the step ran. Without keys the annotation appears in the report, so the unchecked part is visible rather than silent.

## Related

- [[testing]]
- [[2026-09-19-stripe-payments-design]]
