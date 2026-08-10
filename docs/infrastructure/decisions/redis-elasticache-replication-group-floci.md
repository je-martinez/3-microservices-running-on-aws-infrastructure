---
title: "redis module: aws_elasticache_replication_group, awscli fallback for Floci, and the two-ports trap"
type: adr
area: infra
status: accepted
created: 2026-08-09
updated: 2026-08-09
tags:
  - type/adr
  - area/infra
  - status/accepted
related:
  - "[[ADR-0017-floci-local]]"
  - "[[awscli-fallback-for-floci]]"
  - "[[terraform-modules]]"
  - "[[self-owned-password-reset-codes-in-redis]]"
  - "[[floci-elasticache-two-ports-and-provider-panic]]"
  - "[[env-files]]"
  - "[[users-service-design]]"
---

# redis module: aws_elasticache_replication_group, awscli fallback for Floci, and the two-ports trap

## Decision

`infra/modules/redis/` provisions the ElastiCache instance backing Users' password-reset codes
([[self-owned-password-reset-codes-in-redis]]) as an `aws_elasticache_replication_group` — **never**
`aws_elasticache_cluster`. Locally (Floci) the group is created through the established
[[awscli-fallback-for-floci]] pattern (`terraform_data` + an idempotent boto3 script), because the
pinned AWS provider (`= 5.31.0`) panics against Floci's response shape. Production keeps the
native Terraform resource (`var.manage_via_provider = true`, the default).

## Why `aws_elasticache_replication_group`, not `aws_elasticache_cluster`

Verified directly against Floci: `aws elasticache create-cache-cluster --engine redis` is
rejected outright — *"Engine must be 'memcached'. For Redis/Valkey use CreateReplicationGroup."*
Real AWS points the same direction (standalone Redis/Valkey cache clusters are the deprecated
shape); `aws_elasticache_cluster` is a memcached-only resource for this repo's purposes. The
module therefore only ever creates a replication group, with `num_cache_clusters = 1` (a single
node, no replica) — this cache holds password-reset codes with a 10-minute TTL, regenerable state
rather than a system of record, so the cost of losing it is one "resend code" click, not data
loss. Raise `num_cache_clusters` (and `automatic_failover_enabled` with it) only if the cache ever
holds something whose loss is *not* self-healing.

## Why the awscli fallback locally, following [[awscli-fallback-for-floci]]

The pinned AWS provider **panics** creating the replication group against Floci: `index out of
range [0] with length 0` reading `NodeGroups[0]`, which Floci's `CreateReplicationGroup` response
does not populate. This happens **after** the group is actually created on Floci's side, so
nothing lands in Terraform state — a retry then hits `ReplicationGroupAlreadyExistsFault` and
wedges the root, the same failure shape [[awscli-fallback-for-floci]] documents for the Cognito
App Client (a post-Create SDK consistency check failing on a Floci response gap, not a pre-apply
plan difference `lifecycle.ignore_changes` could suppress).

This is the pattern's **third** verified case in this repo — alongside the Cognito App Client and
the Pre-Token-Generation V2 trigger wiring — following the same shape: idempotent lookup-then-create
(`scripts/create_replication_group.py` treats `ReplicationGroupAlreadyExistsFault` as success,
since `make bootstrap` rebuilds this stack routinely and `terraform_data` re-runs the provisioner
whenever its `input` changes), and a JSON descriptor written under the **root** module's working
directory (`var.local_state_dir`, never `path.module`) that a paired `data.local_file` reads back
into Terraform outputs.

## No subnet-group fallback either — there is nothing to fall back to

Floci implements no ElastiCache subnet-group API at all: both `create-cache-subnet-group` and
`describe-cache-subnet-groups` answer `UnsupportedOperation` (verified 2026-08-09). This differs
from `rds-aurora`/`docdb`, which set `create_subnet_group = false` and point at Floci's
pre-existing `"default"` group — here there is no group to point at, because Floci cannot even
list one. Locally the replication group is created with **no** subnet group at all
(`var.create_subnet_group = false`), which it does not need: Floci attaches the backing container
to the compose network directly, the same way it attaches DocumentDB's.

## The two-ports trap — the finding most likely to bite next

Conflating these two values is the trap this module's outputs are built to prevent:

- **`REDIS_PORT` (the value services actually dial) is the BACKING CONTAINER's own port, 6379** —
  what a service on `3mrai-network` reaches at `floci-valkey-<replication-group-id>:6379`.
  Verified from inside the `users` container: `nc -z <container> 6379` succeeded.
- **The ElastiCache API reports a different, HOST-SIDE PROXY port instead** — taken from
  `FLOCI_SERVICES_ELASTICACHE_PROXY_BASE_PORT`/`_MAX_PORT`. This repo moved that proxy range off
  Floci's `6379-6399` default to **`6479-6499`**, because `6379` collides with any Redis a
  developer already runs locally — whoever binds first wins, and the loser either refuses to
  start or, worse, silently reaches the wrong Redis. Verified with the proxy range at
  `6479-6499`: `nc -z <container> 6479` did not answer at all from inside the Docker network —
  the proxy port is a **host-side** concept only, useless (and actively misleading) to a service
  inside the network.

Overriding the proxy range needs **both** the published compose ports **and**
`FLOCI_SERVICES_ELASTICACHE_PROXY_BASE_PORT`/`_MAX_PORT` set together — one without the other
leaves the compose file and Floci's own port assignment disagreeing.

The module resolves this by exposing **three** separate outputs rather than one ambiguous `port`:
`redis_port` (what a service dials — the container port, 6379, locally; the real ElastiCache port
in production), `redis_proxy_port` (the host-side proxy port, for `redis-cli`/GUI sessions from
the **host** only — equals `redis_port` in production), and `endpoint` (the raw ElastiCache API
value, exposed for debugging/parity only — literally the string `"localhost"` locally, which is
**not** connectable from inside the Docker network and must never be what a service reads).

`redis_host` has the same shape for the hostname: locally it is the deterministic
`floci-valkey-<replication_group_id>` container name (Docker DNS resolves it on the network,
known at plan time since the replication group id is chosen by this module, not discovered), never
the API's reported `"localhost"`. This differs from Floci's RDS proxy ports, which are assigned
by cluster creation order and must be **discovered** per-engine at runtime — the Redis hostname
needs no such discovery script.

`REDIS_HOST`/`REDIS_PORT` reach Users through the standard [[env-files]] pipeline (Terraform
outputs → `generate_env_files.py` → `.env.local.users`), so no consumer ever hand-derives either
value.

## Consequences

- `infra/modules/redis/` joins the module inventory in [[terraform-modules]].
- A fourth data store now backs the local stack (Postgres, DocumentDB, DynamoDB, Redis), each with
  its own Floci-specific hostname quirk documented in its own module's outputs — this one is the
  first to also need a *port* quirk on top of the *hostname* quirk.
- Detailed empirical findings (the panic's exact error text, the port measurements, the proxy-range
  collision) are additionally recorded as a lesson — see
  [[floci-elasticache-two-ports-and-provider-panic]] — since a future engineer hitting the same
  provider panic or `ECONNREFUSED` needs the debugging trail, not just the resulting design.

## Related

- [[ADR-0017-floci-local]] — the base Floci-as-local-AWS-emulator decision this module works
  within.
- [[awscli-fallback-for-floci]] — the pattern this module's local path follows; this is its third
  verified case.
- [[terraform-modules]] — the module inventory `redis` is added to.
- [[self-owned-password-reset-codes-in-redis]] — why Users needs Redis at all.
- [[floci-elasticache-two-ports-and-provider-panic]] — the lesson recording the raw empirical
  findings behind this decision.
- [[env-files]] — how `REDIS_HOST`/`REDIS_PORT` reach `.env.local.users`.
- [[users-service-design]] — the consuming service.
