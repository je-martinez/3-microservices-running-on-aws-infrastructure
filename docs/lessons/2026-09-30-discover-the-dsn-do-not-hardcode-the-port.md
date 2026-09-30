---
title: "Discover the DSN, do not hardcode the port"
type: lesson
area: shared
status: active
created: 2026-09-30
updated: 2026-09-30
tags:
  - type/lesson
  - area/shared
  - status/active
  - severity/medium
related:
  - "[[floci-rds-apigw-limits]]"
  - "[[env-files]]"
  - "[[testing]]"
  - "[[code-comments]]"
---

# Discover the DSN, do not hardcode the port

Never assume which port a Floci RDS engine listens on. This is a repo-wide rule for every script, env file, compose entry and Terraform provider. The concrete example here is the tracking-go `make test-db` target, which finds its database by discovery instead of a literal port.

## The port is not fixed

Floci assigns RDS proxy ports from 7000-7099 by cluster **creation order**. [[floci-rds-apigw-limits]] already records that the port is assigned per run inside that range. What it does not record, and what this lesson adds, is that with more than one cluster the **assignment reorders across applies**.

Verified on 2026-07-15 with two clusters (Users Postgres and Orders MySQL). Both orderings were observed on different from-scratch applies:

| Apply | Postgres | MySQL |
| --- | --- | --- |
| One | 7001 | 7002 |
| Another | 7002 | 7001 |

Hardcoding either assignment works until the next from-scratch apply, then fails in a way that looks like a broken test or a dead database.

## It broke something real

`make migrate` hardcoded `floci:7001` as "the Postgres port". After a flip, Prisma connected to 7001, reached the **MySQL** cluster instead, and failed with "Can't reach database server".

The failure names the wrong thing: it reads as a database being down, not as a port pointing at the wrong engine. Nothing in the message hints that the port is reachable but owned by another engine, so the natural debugging path (is the database up?) goes nowhere.

## Discover the port per engine

`describe-db-clusters` exposes `Engine` for every cluster, so the port can be discovered per engine:

```bash
aws --endpoint-url http://localhost:4566 rds describe-db-clusters \
  --query "DBClusters[?Engine=='postgres'].Port" --output text

aws --endpoint-url http://localhost:4566 rds describe-db-clusters \
  --query "DBClusters[?Engine=='mysql'].Port" --output text
```

Feed the discovered ports into `make migrate`, the env-file generation, compose, and the two-phase post-effect providers rather than literal `7001` / `7002`.

Related mitigation: docker-compose publishes Floci's ports as a **range** (7000-7010), precisely so host-side reachability survives whichever port gets assigned. Discovery decides which port to use; the published range is what makes that port reachable from the host.

## Discover from the generated env file

For tracking-go, the DSN is read from the generated `.env.local.tracking`, which `make env-file` writes from Terraform outputs (see [[env-files]]). That file is the single place the discovered port already lives; re-discovering it elsewhere would create a second source that can disagree with the first.

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
