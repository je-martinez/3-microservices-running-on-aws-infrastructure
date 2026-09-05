---
title: "instanceof Across a Structured-Clone Realm"
type: lesson
area: shared
status: active
created: 2026-09-04
updated: 2026-09-04
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[2026-09-04-web-gateway-integration-design]]"
  - "[[testing]]"
---

# instanceof Across a Structured-Clone Realm

## What happened

While implementing the web app's encrypted token store
(`apps/web/src/app/core/auth/token-store.ts`, JE-239), the round-trip test failed while every
corruption test passed — `write()` worked, `read()` returned null for the record it had just
written.

The store keeps an `EncryptedRecord` in IndexedDB holding a non-extractable `CryptoKey`, a
`Uint8Array` IV and an `ArrayBuffer` ciphertext. Its type guard validated the binary fields with
`instanceof`. For a value that had just come back out of IndexedDB, `ct instanceof ArrayBuffer`
was **false** for a genuine ArrayBuffer, so the guard rejected every valid record.

## The measurement, including where it does NOT reproduce

This matters because the obvious explanation — "structured clone always crosses a realm" — is
too broad and testing it in the wrong place clears it wrongly:

- Under **jsdom** (the app's Vitest environment), swapping the tag check back to `instanceof`
  turns the round-trip test **red**. Verified by mutation.
- In **plain Node** with the same `fake-indexeddb` package, a round-tripped `ArrayBuffer` and
  `Uint8Array` both report `instanceof === true` and `constructor.name` as expected. Verified
  with a standalone probe.

So the realm split belongs to the **environment**, not to structured clone in general. A green
run in one runtime does not clear the hazard in another.

## The rule

Identify binary values that have crossed a structured clone by **constructor tag**, not
`instanceof`:

```ts
Object.getPrototypeOf(value)?.constructor?.name === 'ArrayBuffer'
```

`instanceof` compares against the constructor of the *current* realm. A value built in another
realm — iframe, worker, or a test environment's separate global — has a different constructor
identity while being a perfectly genuine ArrayBuffer.

## Why it is worth a note

The failure mode is unusually deceptive: `write()` succeeds, so nothing looks broken at the
point of the bug. Only the *next* `read()` fails, and it fails by returning a legitimate-looking
"no session" rather than an error. In production this would present as **the user being logged
out on every page reload** while sign-in itself works perfectly — a symptom that points away
from the actual cause.

It also generalizes beyond this store: any code that validates structured-clone output
(IndexedDB, `postMessage`, workers) with `instanceof` has the same latent bug.

## Related

- [[2026-09-04-web-gateway-integration-design]]
- [[testing]]
