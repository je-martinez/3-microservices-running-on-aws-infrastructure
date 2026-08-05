---
title: "Floci SQS + Lambda + DocumentDB support probe"
type: lesson
area: infra
status: active
created: 2026-08-03
updated: 2026-08-03
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/medium
related:
  - "[[floci-rds-apigw-limits]]"
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[ADR-0017-floci-local]]"
  - "[[events-pipeline-design]]"
---

# Floci SQS + Lambda + DocumentDB support probe

Empirical probe of Floci's SQS, Lambda (SQS event source mapping), and DocumentDB support, run
2026-08-03 ahead of the events-pipeline milestone, against a live **Floci v1.5.28 (community
edition)**. Recorded so the events-pipeline implementation doesn't re-discover these limits, and
so the production design is not accidentally shaped around a local-only quirk.

## Headline verdict

The events-pipeline design (SQS → single Lambda → DocumentDB, per [[events-pipeline-design]]) is
**viable on Floci as designed**. SQS, the Lambda event source mapping, and DocumentDB are all
really implemented, not stubbed.

> [!important] The organizing question for every finding below: local-only, or real AWS limit?
> **All findings in this probe are local-only.** None of them constrain the events-pipeline
> production design — they only affect how the pipeline can be tested and reached locally. See
> the summary table immediately below before reading the individual findings.

## Scope summary

| # | Finding | Scope | Constrains production design? |
|---|---|---|---|
| 1 | No multi-document transactions in DocumentDB (standalone `mongo:7.0`, no replica set) | **Local-only** | No — current flow doesn't need cross-document transactions; only limits what can be *tested* locally if a future handler needs them |
| 2 | DocumentDB endpoint is a Docker-internal IP, not host-reachable, not stable | **Local-only** | No — real AWS cluster endpoint is a stable DNS name; workaround exists (container-name DNS) |
| 3 | `update-event-source-mapping` silently drops `FunctionResponseTypes` | **Local-only** (Floci update-path bug) | No — Terraform sets it at `create` time, which works correctly; only matters if a mapping is ever field-updated in place |

## What WORKS (verified, with the evidence)

**SQS:**

- Queue creation; message attributes; `ApproximateReceiveCount` increments correctly; visibility
  timeout genuinely hides messages.
- **Automatic DLQ redrive works.** With `RedrivePolicy` `maxReceiveCount=3` and
  `VisibilityTimeout=1`, the message was received 3 times, then disappeared from the main queue
  and appeared in the DLQ on its own. This is real behavior, not just the attribute being stored.

**Lambda + SQS event source mapping (the critical link):**

- `create-event-source-mapping` produces a mapping that genuinely polls and invokes the function.
  Proven from CloudWatch logs, not inferred from the queue draining: a single invocation logged
  `records=3` with all three message bodies, i.e. real batching, and its request id differed from
  a prior direct invoke.
- Lambda runs real code (`nodejs20.x`); a direct `invoke` returned the handler's actual return
  value.
- **Partial batch response (`batchItemFailures`) is honored correctly.** Verified with a mixed
  batch: the OK message logged `recv=1`, was deleted and never retried, while the failing message
  logged `recv=1` then `recv=2` — only the failed item was retried. This matches real AWS
  semantics.

**DocumentDB:** backed by a real `mongo:7.0` container (engine reported as docdb 5.0.0), auth
works. Of the [[events-pipeline-design]] data model: unique index on `friendlyId` enforced
(duplicate rejected, error 11000); `$push` to `status_history` appends correctly; all 6 spec
indexes created (7 total incl. `_id`); aggregation pipelines work.

## Finding 1 — No multi-document transactions in DocumentDB

> [!warning] Scope: LOCAL-ONLY
> Real Amazon DocumentDB supports this. Do not design the events-pipeline around its absence.

Floci backs each docdb cluster with a **single standalone `mongo:7.0` container, no replica set**
(`hello.setName` → no replicaset). MongoDB multi-document transactions require a replica set, so
`startTransaction`/`commitTransaction` fails. The error mentions retryable writes, and it **still
fails with `retryWrites=false` in the connection string** — the standalone topology is the real
cause, not the retryWrites flag.

Floci's own docdb docs corroborate this, listing under "Out of Scope": *"Global clusters,
replicas, and read-scaling beyond a single MongoDB container per cluster."*

**Scope: local-only.** Real Amazon DocumentDB **does** support multi-document ACID transactions
across documents, statements, collections and databases, from **engine 4.0 and later** (source:
https://docs.aws.amazon.com/documentdb/latest/developerguide/transactions.html).

**Impact:** none on the current design — its flow is one insert plus single-document updates,
which are atomic in MongoDB anyway. The risk is only if a future handler needs to write atomically
across collections: that would work in AWS but **could not be tested locally**.

Worth recording, since AWS's transaction support carries its own real caveats if we ever rely on
it (these ARE real AWS limits, listed here only for completeness — they are not part of this
probe's local-only findings): no cursors inside a transaction; cannot create collections inside a
transaction; transactions have a 1-minute execution limit and sessions a 30-minute timeout;
transaction log must be under 32MB; retryable writes/commit/abort are not supported and are
disabled by default.

## Finding 2 — DocumentDB endpoint is not host-reachable and its IP is not stable

> [!warning] Scope: LOCAL-ONLY
> Real AWS gives a stable DNS cluster endpoint. This only affects how tests/tools reach the local
> emulator.

`describe-db-clusters` returns the backing container's **Docker network IP** (e.g.
`192.168.148.9`) on port 27017. Floci's own docs
(https://floci.io/floci/services/docdb/) describe **three** deployment modes, and the port
behavior is a property of *which mode is running*, not a flat Floci limitation:

1. **Real mode, Floci on the host (their default):** the container's 27017 is published on a
   **dynamically assigned host port**, and `DescribeDBClusters.Port` returns that mapped port.
2. **Real mode, Floci in a container on a shared Docker network (our mode):** the endpoint
   becomes the container host on **27017 itself**, reachable within the Docker network — no host
   port is published.
3. **Mock mode** (`FLOCI_SERVICES_DOCDB_MOCK=true`): no container is started; the cluster reports
   `localhost:27017`.

**3MRAI runs mode 2** — Floci is the `floci` service in the root `docker-compose.yml`, with
`/var/run/docker.sock` mounted (compose line 46) so it can launch MongoDB containers itself. So
port 27017 genuinely is not host-published *for us*, but that is a consequence of **how we run
Floci** (containerized), not an absolute Floci property. The container also has **no network
alias** (`aliases=[]`), and per the established Floci pattern (see [[floci-rds-apigw-limits]] on
ECS task recreation) IPs must not be pinned.

**Re-verified empirically today (2026-08-03) against the live stack:**

- `aws docdb describe-db-clusters` → `Endpoint: 192.168.148.6`, `Port: 27017` — a Docker-internal
  IP with a fixed port, not a dynamically assigned host port.
- `docker ps` → `floci-docdb-<id>   27017/tcp` with no `->` mapping, i.e. genuinely unpublished.
- **Worth stating explicitly, because it's what makes this confusing: RDS in the same Floci DOES
  publish** host ports 7000-7010 on the `3mrai-floci-1` container, while DocumentDB does not. Same
  emulator, different behavior per service — because RDS's proxy-port model is unrelated to
  docdb's host-vs-containerized mode split.

**Portability caveat (not a bug):** Floci's own docs recommend *"Always read the host and port
from `DescribeDBClusters` rather than assuming a fixed port."* Our Lambda client hardcodes 27017,
which is correct for mode 2 and works today — but it would break if Floci were ever run
host-based (mode 1), where the port is dynamic. Worth a comment near that hardcode if we ever
change how Floci is launched.

**Scope: local-only.** In AWS the cluster endpoint is a stable DNS name.

**Workaround (verified):** the backing container is named
**`floci-docdb-<db-cluster-identifier>`** — derived from the Terraform cluster identifier, not
random — and resolves via Docker DNS on the `3mrai_3mrai-network` network. So connect by that
container name rather than by IP; no `docker inspect` and no stable-alias step is needed. Anything
running on the host (e.g. tests) must reach it from inside the Docker network.

Cross-reference the related-but-distinct RDS quirk: Floci assigns RDS proxy ports 7000-7099 by
cluster creation order, so they are not deterministic and must be discovered via
`describe-db-clusters` (see [[floci-rds-apigw-limits]]).

## Finding 3 — `update-event-source-mapping` silently drops `FunctionResponseTypes`

> [!warning] Scope: LOCAL-ONLY
> A Floci update-path bug; real AWS honors the field on update. Low practical impact since
> Terraform creates the mapping with the field set.

Calling `update-event-source-mapping --function-response-types ReportBatchItemFailures` returns
`FunctionResponseTypes: []` and does not persist it (confirmed by re-reading with
`get-event-source-mapping`). Passing the same flag to **`create-event-source-mapping` works
correctly** and the value persists.

**Scope: local-only** — a Floci update-path bug; real AWS honors it.

**Impact: low in practice**, because Terraform declares `function_response_types` when creating
`aws_lambda_event_source_mapping`. But if the field is ever added to an existing mapping, the
mapping must be **recreated, not updated** — otherwise partial batch responses silently stop
being honored, which would look like "every failure retries the whole batch."

## Probe hygiene

All probe resources (queues, Lambda, mappings, docdb clusters, IAM role) were deleted afterwards;
the existing local stack was untouched.

## Related

- [[floci-rds-apigw-limits]]
- [[floci-vs-ministack-spike-findings]]
- [[floci-storage-modes-and-tmp-corruption]]
- [[ADR-0017-floci-local]]
- [[events-pipeline-design]]
