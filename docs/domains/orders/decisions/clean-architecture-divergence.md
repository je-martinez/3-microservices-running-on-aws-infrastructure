---
title: Orders diverges from screaming architecture — Clean Architecture with class libraries
type: adr
area: orders
status: accepted
id: orders-clean-architecture-divergence
deciders: ["Jose E. Martinez"]
supersedes: null
superseded-by: null
created: 2026-07-28
updated: 2026-07-28
tags: [type/adr, area/orders, status/accepted]
related:
  - "[[orders-service-design]]"
  - "[[ADR-0008-screaming-arch-di]]"
  - "[[cqrs]]"
  - "[[2026-07-14-orders-service-milestone-design]]"
  - "[[2026-07-14-orders-service-milestone]]"
---

# Orders diverges from screaming architecture — Clean Architecture with class libraries

## Context

[[ADR-0008-screaming-arch-di]] establishes the shared convention: services organize
top-level folders by domain use case, not by framework role, with dependencies
injected through constructors or DI containers. Users follows this directly. For the
Orders Service milestone design (2026-07-14), the .NET/EF Core stack made a
project-boundary-enforced layering more valuable than a screaming-architecture folder
tree, and the milestone spec explicitly diverges — without superseding the ADR for
other services.

## Decision

Orders is a `.sln` with five Clean Architecture projects, dependencies enforced by
project references (not just convention):

| Project | Responsibility | References |
|---|---|---|
| `Orders.Domain` | Entities (`Order`, `OrderDetail`, `Product`), `OrderPricing`, invariants | none |
| `Orders.Application` | Ports (interfaces), DTOs, commands, exceptions — no EF Core | Domain |
| `Orders.Infrastructure` | EF Core DbContexts/configs/migrations, the gRPC client, `NoopEventPublisher`, and the concrete read/write services (`OrderReadService`, `ProductReadService`, `CreateOrderService`) | Application, Domain |
| `Orders.Api` | Composition root — Minimal API endpoints, DI wiring, `CallerContextMiddleware` | Application, Infrastructure |
| `Orders.Tests` | xUnit — Domain unit tests + Testcontainers-MySQL integration + `WebApplicationFactory` endpoint tests | all |

**Dependency-direction rule:** `Orders.Application` must never reference EF Core or
Infrastructure. Any class touching a `DbContext` or the gRPC client lives in
Infrastructure — this is why `OrderReadService`, `ProductReadService`, and
`CreateOrderService` sit under `Orders.Infrastructure.Orders` even though the
milestone plan first drafted the read services in Application (corrected during
implementation).

This is a service-local divergence, recorded here and in
[[orders-service-design]] / `services/orders/CLAUDE.md`; it does **not** supersede
[[ADR-0008-screaming-arch-di]], which still governs Users and future services unless
they make the same explicit tradeoff.

## Consequences

- The dependency direction is compiler-enforced (a stray `Infrastructure` reference
  from `Application` fails the build), not just a folder-naming convention.
- Orders reads differently from Users at the top level; a reader must know this ADR
  exists before assuming all services share one folder shape.
- [[cqrs]] maps cleanly onto this layering: `OrdersReadDbContext` /
  `OrdersWriteDbContext` both live in Infrastructure, Application only sees ports.

## Related

- [[orders-service-design]]
- [[ADR-0008-screaming-arch-di]]
- [[cqrs]]
- [[2026-07-14-orders-service-milestone-design]]
- [[2026-07-14-orders-service-milestone]]
