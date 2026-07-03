---
title: Dependency injection
type: pattern
area: shared
status: active
created: 2026-06-26
updated: 2026-07-02
tags: [type/pattern, area/shared, status/active, area/users]
related: ["[[cqrs]]"]
---

# Dependency injection

## Pattern

All services use dependency injection (DI) to wire their components together. Collaborators — handlers, repositories, clients — are provided to consumers rather than constructed inline.

## How we apply it

- Handlers receive their repositories and clients via DI instead of instantiating them.
- The same approach wires the [[cqrs]] command/query/event handlers across every service.
- This keeps use-cases (see [[screaming-architecture]]) decoupled from concrete infrastructure, making them easy to test and swap.

## How the Users service applies it (Awilix)

The Users service ([issue JE-39](https://linear.app/issue/JE-39)) implements the DI pattern above with **`@fastify/awilix`** (built on `awilix`), replacing an earlier hand-rolled container — free functions plus an `AppDeps` bag typed with `unknown`.

- **Registration primitives.** Collaborators are registered with `asClass`, `asValue`, or `asFunction`. `Lifetime.SINGLETON` is used for infrastructure-level collaborators shared across the app — Prisma `writer`/`reader` clients, the Cognito client, `AuthProvider`, `EventPublisher`, `env`. `Lifetime.SCOPED` is used for use-cases (the [[cqrs]] commands and queries), so each request gets its own instances.
- **Two registration points.** App-scoped registration happens once against the global `diContainer` (`registerSingletons()` followed by `registerServices()`). Per-request registration happens via `request.diScope.register(...)` inside an `onRequest` hook — used for `currentActor`, the acting identity for audit purposes, taken from the `x-user-id` header set by the API Gateway authorizer.
- **Resolution in handlers.** Fastify route handlers resolve their dependencies from `request.diScope.cradle` instead of receiving an explicit `deps` bag. The old `AppDeps`-with-`unknown` interface and the `as any` casts in the wiring code are gone.
- **Type safety.** A module augmentation declares the shape of the container: `declare module "@fastify/awilix" { interface Cradle {...}; interface RequestCradle {...} }`, so `cradle` and `diScope.cradle` resolve to fully-typed collaborators instead of `unknown`.
- **Test pattern.** Each test builds an isolated Awilix container (`createContainer({ injectionMode: "PROXY" })`) and registers mocks with `asValue`, then passes that container into `buildApp(container)` — instead of mocking a plain `deps` object. This means tests never touch the global `diContainer`.

## Related

- [[cqrs]] — the handlers wired through DI.
- [[screaming-architecture]] — DI connects use-case folders to infrastructure at the edges.
