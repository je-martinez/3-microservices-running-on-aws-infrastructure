---
title: "Stripe.NET has no per-client API version — the package version IS the pin"
type: lesson
area: orders
status: active
created: 2026-09-23
updated: 2026-09-23
tags:
  - type/lesson
  - area/orders
  - status/active
  - severity/high
  - milestone/stripe-payments
related:
  - "[[2026-09-19-stripe-payments-design]]"
  - "[[stripe-payments-milestone]]"
  - "[[testing]]"
---

# Stripe.NET has no per-client API version — the package version IS the pin

## Finding

[[2026-09-19-stripe-payments-design]] Decision 18 pins the Stripe API version used by this
integration to `2026-08-26.dahlia`, and expects both SDKs to honor that pin explicitly. The
Node SDK does: `new StripeClient(secretKey, { apiVersion: STRIPE_API_VERSION })` sets it per
client instance, exactly as the design assumed for both services.

Stripe.NET 52.x has **no equivalent per-client option**. `StripeClientOptions` (the options
object passed to `StripeClient`'s constructor) does not expose an `ApiVersion` property at all.
The only place an API version can be pinned in this SDK generation is a **static** property,
`StripeConfiguration.ApiVersion`, which ships already set to whatever version that package
build was generated against — and that value travels with the **NuGet package version**, not
with anything the calling code writes.

Consequence: `dotnet add package Stripe.net --version <newer>` silently changes the Stripe API
version this service talks with, with no code change and no compiler signal. A version bump
that looks like routine dependency maintenance is actually a live change to response shapes,
new fields, and behavior — exactly the kind of drift Decision 18 exists to prevent, and the
Node-side implementation actually does prevent.

## Rule

- **Pin the `Stripe.net` package version itself** (e.g. an exact version in the `.csproj`, not
  a floating range) — the package version *is* the API-version pin for this SDK, there is no
  second lever.
- **Assert the `Stripe-Version` response header in a test** against the pinned value
  (`2026-08-26.dahlia` per Decision 18) so a future package bump that silently changes the
  default is caught by CI rather than discovered against production behavior.
- **Bump the package only together with Decision 18's pinned version** — treat a Stripe.NET
  version bump as an API-version change, not a routine dependency update, and update the spec's
  pinned-version line in the same change.
- Do not assume SDK parity across languages: Node's `StripeClientOptions.apiVersion` exists;
  .NET's does not. Check each SDK's actual surface before assuming a cross-language pattern
  holds, rather than porting the Node approach and discovering the gap at review time.

## Related

- [[2026-09-19-stripe-payments-design]] — Decision 18, the pinned-version requirement this
  package-version coupling must satisfy on the Orders (.NET) side.
- [[stripe-payments-milestone]] — the milestone this fix landed in (PR #85, P1 gap backlog item
  9).
- [[testing]] — where the `Stripe-Version` header assertion belongs, alongside Orders' other
  unit/integration coverage.
