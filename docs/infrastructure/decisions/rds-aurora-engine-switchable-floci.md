---
title: "rds-aurora module: switchable engine for Floci (postgres/mysql, not aurora-*)"
type: adr
area: infra
status: accepted
created: 2026-07-28
updated: 2026-07-28
tags:
  - type/adr
  - area/infra
  - status/accepted
related:
  - "[[ADR-0006-read-write-replicas]]"
  - "[[ADR-0001-terraform-cloudposse-naming]]"
  - "[[ADR-0004-soft-delete-only]]"
  - "[[soft-delete]]"
  - "[[2026-07-04-je36-local-env-compose-design]]"
  - "[[2026-07-15-orders-rds-mysql-design]]"
  - "[[2026-07-15-orders-rds-mysql]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[aws-resources]]"
  - "[[terraform-modules]]"
---

# rds-aurora module: switchable engine for Floci (postgres/mysql, not aurora-*)

## Decision

`infra/modules/rds-aurora` exposes a `var.engine` (default `"aurora-postgresql"`, preserving
production behavior) instead of a hardcoded engine string. `aws_rds_cluster_instance` writer/
reader resources are gated `count = startswith(var.engine, "aurora") ? 1 : 0`. The local
environment instantiates the module **twice** — `engine = "postgres"` for Users,
`engine = "mysql"` for Orders — while production continues to pass `"aurora-postgresql"` /
`"aurora-mysql"` unchanged.

## Why

Floci does not emulate Aurora; it runs **real single-instance `postgres`/`mysql`/`mariadb`
containers** behind a proxy port in the `7000-7099` range (confirmed against Floci's own RDS
documentation), with no Aurora cluster-instance concept. The original module hardcoded
`engine = "aurora-postgresql"`, which Floci cannot create at all
(`aws_db_subnet_group ... DBInstanceNotFound`). Because Aurora-only engines require
`aws_rds_cluster_instance` resources that reject non-Aurora engine strings, those instances had
to become conditional, not just the engine string.

The change is additive and backward-compatible: the module's `writer_endpoint`/`reader_endpoint`
outputs already read from `aws_rds_cluster.this`, not the instances, so neither production nor
the output contract changed.

## Consequences

- **Endpoint discovery differs from the module output locally.** The module's
  `writer_endpoint` is an AWS-format hostname; the real connectable host:port on Floci is only
  known after apply, discovered via `aws rds describe-db-instances` (or, per-engine, via
  `describe-db-clusters` — see [[floci-rds-apigw-limits]] for why the port is not deterministic
  across engines/creation order). Any Makefile/script step that builds a `DATABASE_URL` locally
  must use the discovered value, never a hardcoded port.
- **No read replica locally.** Consistent with [[ADR-0006-read-write-replicas]]: writer and
  reader point at the same Floci endpoint, since Floci does not emulate Aurora read replicas.
- **Naming:** each engine instantiation gets its own `cloudposse/label` instance and a
  letter-led context id (e.g. `aurora-${label}`, `mysql-${label}`) because cluster identifiers
  must start with a letter — extends [[ADR-0001-terraform-cloudposse-naming]]'s convention, not
  a new naming scheme.
- **Least-privilege app users still respect [[ADR-0004-soft-delete-only]] / [[soft-delete]]**
  regardless of engine: `users_app` (Postgres) and `orders_app` (MySQL) both get
  `SELECT, INSERT, UPDATE` and never `DELETE`. MySQL's `GRANT ... ON orders.*` covers future
  tables automatically, unlike Postgres's need for `ALTER DEFAULT PRIVILEGES` — a simplification
  noted at implementation, not a design difference.
- **Second RDS cluster is more Floci RDS/APIGW surface**, an area already documented as fragile
  in [[floci-rds-apigw-limits]] — adding a second cluster does not reintroduce the second-apply
  problem (rebuild-from-scratch is unaffected), but any new apply failure on the MySQL branch is
  a candidate addition to that lesson.

## Related

- [[ADR-0006-read-write-replicas]]
- [[ADR-0001-terraform-cloudposse-naming]]
- [[ADR-0004-soft-delete-only]]
- [[soft-delete]]
- [[2026-07-04-je36-local-env-compose-design]]
- [[2026-07-15-orders-rds-mysql-design]]
- [[2026-07-15-orders-rds-mysql]]
- [[floci-rds-apigw-limits]]
- [[aws-resources]]
- [[terraform-modules]]
