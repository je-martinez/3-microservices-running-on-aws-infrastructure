---
title: "Discover the DSN, do not hardcode the port"
type: lesson
area: tracking
status: active
created: 2026-09-30
updated: 2026-09-30
tags:
  - type/lesson
  - area/tracking
  - status/active
  - severity/medium
related:
  - "[[floci-rds-apigw-limits]]"
  - "[[env-files]]"
  - "[[testing]]"
  - "[[code-comments]]"
---

# Discover the DSN, do not hardcode the port

How the tracking-go `make test-db` target finds its database, and why it never hardcodes a port.

## The port is not fixed

Floci assigns RDS proxy ports from 7000-7099 by cluster **creation order**, which is not stable across applies: MySQL and Postgres have been observed to **swap**. The range itself is documented in [[floci-rds-apigw-limits]]; the instability is not. Hardcoding `7002` works until the next `make floci-up`, then fails in a way that looks like a broken test.

## Discover from the generated env file

The DSN is read from the generated `.env.local.tracking`, which `make env-file` writes from Terraform outputs (see [[env-files]]). That file is the single place the discovered port already lives; re-discovering it elsewhere would create a second source that can disagree with the first.

Two rewrites are applied to the value:

- The SQLAlchemy prefix `mysql+pymysql://` becomes `mysql://`, which is what `internal/platform/config.MySQLDSN` parses.
- The compose hostname `floci` becomes `127.0.0.1`, because `make test-db` runs on the **host**, outside the compose network, where `floci` does not resolve.

## Throwaway schemas

The server DSN drops the database segment. The count and soft-delete suites each **create their own throwaway schema** instead of touching the shared `tracking` database that the running service and the E2E suite both use. A root superuser DSN exists for that DDL; the `test` user holds only database-scoped grants.

## Related

- [[floci-rds-apigw-limits]]
- [[env-files]]
- [[testing]]
- [[2026-09-30-go-test-discards-a-passing-packages-output]]
- [[code-comments]]
