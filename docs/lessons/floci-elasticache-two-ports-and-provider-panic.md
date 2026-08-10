---
title: "Floci ElastiCache: real Valkey container, provider NodeGroups[0] panic, two disagreeing ports"
type: lesson
area: infra
status: active
created: 2026-08-09
updated: 2026-08-09
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/medium
related:
  - "[[redis-elasticache-replication-group-floci]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[ADR-0017-floci-local]]"
  - "[[floci-rds-apigw-limits]]"
  - "[[self-owned-password-reset-codes-in-redis]]"
---

# Floci ElastiCache: real Valkey container, provider NodeGroups[0] panic, two disagreeing ports

Empirical findings from provisioning `infra/modules/redis/` for Users' password-reset codes
(2026-08-09). Recorded so the next module that reaches for ElastiCache on Floci does not
re-discover these — the same way [[floci-rds-apigw-limits]] exists for RDS/API Gateway.

## What Floci actually runs

Floci backs an ElastiCache replication group with a **real** `valkey/valkey:8` container, named
`floci-valkey-<replication-group-id>`, attached to the compose network with **no host port
published**. Native TTL (`EX`) works against it — this was the property the whole feature needed,
and it was verified working end to end, not assumed from Valkey/Redis's documented behavior.

## `aws_elasticache_cluster` is rejected outright

`aws elasticache create-cache-cluster --engine redis` against Floci returns: *"Engine must be
'memcached'. For Redis/Valkey use CreateReplicationGroup."* Redis/Valkey must go through
`CreateReplicationGroup` (`aws_elasticache_replication_group` in Terraform) — `aws_elasticache_cluster`
only works for memcached on this emulator. See [[redis-elasticache-replication-group-floci]] for
the module decision this produced.

## The pinned AWS provider (5.31.0) panics creating the group

The **exact** failure: `index out of range [0] with length 0`, from the provider reading
`NodeGroups[0]` on the `CreateReplicationGroup` response — a field Floci's response does not
populate. Critically, this happens **after** Floci has already created the group server-side, so:

1. Nothing lands in Terraform state (the panic happens mid-apply, before state is written).
2. A retry of `terraform apply` then hits `ReplicationGroupAlreadyExistsFault`, because the group
   genuinely exists on Floci's side — and the root is now wedged: neither "just retry" nor "just
   destroy and reapply" resolves it without manual intervention (destroying the orphaned Floci
   group out-of-band).

This is the same failure family as the Cognito App Client case in [[awscli-fallback-for-floci]]
— a provider-side post-Create consistency check reading a response field Floci's emulation
leaves empty — and was resolved the same way: an awscli-fallback script
(`scripts/create_replication_group.py`) that creates the group with a plain boto3 call outside
Terraform's managed resource lifecycle, so the provider's `NodeGroups[0]` read never happens.

## No ElastiCache subnet-group API at all

Both calls answer `UnsupportedOperation` (verified 2026-08-09):

```
aws elasticache create-cache-subnet-group    -> UnsupportedOperation
aws elasticache describe-cache-subnet-groups -> UnsupportedOperation
```

Unlike `rds-aurora`/`docdb`, there is no pre-existing `"default"` subnet group to fall back to —
Floci does not implement the surface **at all**, not even read-only. The replication group is
created locally with no subnet group; Floci does not need one, since it attaches the container to
the compose network directly.

## Two different ports, and conflating them is the trap

This is the finding most likely to bite someone who has not read it:

- **The backing container's own port is `6379`** — what a service inside `3mrai-network` actually
  dials, at `floci-valkey-<replication-group-id>:6379`. Verified from inside the `users`
  container: `nc -z <container> 6379` succeeded.
- **The ElastiCache API reports the HOST-SIDE PROXY port instead** — a different number, sourced
  from `FLOCI_SERVICES_ELASTICACHE_PROXY_BASE_PORT`/`_MAX_PORT` in `docker-compose.yml`. This repo
  moved that range off Floci's `6379-6399` default to **`6479-6499`**, because `6379` collides
  with a developer's own locally-running Redis — whoever binds the port first wins, and the loser
  either fails to start or, worse, silently connects to the wrong Redis instance with no error at
  all. With the range at `6479-6499`, `nc -z <container> 6479` from inside the Docker network did
  not answer — the proxy port is host-side only, and is not reachable (and must not be dialed)
  from a service on the compose network.

**Whoever consumes the ElastiCache API's reported endpoint/port directly, instead of a purpose-built
Terraform output, will get `ECONNREFUSED` from inside the network** (the API's `endpoint` also
literally reports the string `"localhost"`, which resolves to the calling container itself, not
to Redis). `infra/modules/redis/outputs.tf` resolves this by exposing `redis_host`/`redis_port`
(what a service dials), `redis_proxy_port` (the host-side value, for `redis-cli`/GUI sessions from
the host only), and `endpoint` (the raw API value, debugging/parity only) as three separate,
clearly-documented outputs rather than one ambiguous pair — see
[[redis-elasticache-replication-group-floci]] for the resulting design.

Overriding the proxy range requires setting **both** the compose-published ports **and**
`FLOCI_SERVICES_ELASTICACHE_PROXY_BASE_PORT`/`_MAX_PORT` together — setting only one leaves
compose and Floci's own port assignment disagreeing with each other, silently.

## Why this matters beyond Redis

Every data store this repo has added to Floci so far has had exactly **one** quirk to document
(DocumentDB's non-stable endpoint, RDS's non-deterministic proxy ports by creation order — see
[[floci-rds-apigw-limits]]). ElastiCache is the first with **two independent** quirks stacked on
top of each other (a hostname quirk *and* a port quirk, where the wrong hostname AND the wrong
port are both plausible-looking but wrong). Treat "the API's own reported endpoint" as suspect by
default for any future Floci-backed data store, and verify both the hostname and the port
separately from inside the Docker network before wiring a consumer to either.

## Related

- [[redis-elasticache-replication-group-floci]] — the infra decision (module shape, awscli
  fallback, output design) these findings produced.
- [[awscli-fallback-for-floci]] — the pattern applied to work around the provider panic; this is
  its third verified case in this repo.
- [[ADR-0017-floci-local]] — the base Floci-as-local-AWS-emulator decision.
- [[floci-rds-apigw-limits]] — the earlier lesson with the same shape (empirical Floci limits
  found while composing a new data store into `environments/local`), for RDS/API Gateway instead
  of ElastiCache.
- [[self-owned-password-reset-codes-in-redis]] — the feature this Redis instance backs.
