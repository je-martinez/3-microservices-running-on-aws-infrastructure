---
trigger: manual
---

# Local AWS emulator (Floci) — state must die with its containers

The repo runs a local AWS emulator (Floci) on a single endpoint (`:4566`) as the
`floci` compose service. Terraform's local environment and the service SDKs
target it through `AWS_ENDPOINT_URL`. Lambda and ECS execute as real Docker
containers joined to the compose network.

## State lives in a named volume, on purpose

Emulator state persists in the **`floci-state` named volume** (with
`FLOCI_STORAGE_MODE=persistent`), **not** in a `./data` bind mount.

This is not cosmetic. `docker compose down -v` removes named volumes and
**cannot** remove a bind mount, so under the old layout no teardown command
cleared emulator state — it outlived every `down`.

## Why a stale state is dangerous rather than merely untidy

If the backing containers are removed while the state survives, the emulator
boots, reloads that state, and reports resources as `available` for clusters
whose containers no longer exist. `terraform apply` then asks whether the
resource exists, is told yes, and **creates nothing — while reporting success.**

Nothing fails at that point. The failure surfaces much later and far from its
cause, when a service dials the resource and gets a DNS resolution error for a
container that was never created.

The behavior is **selective**, which is what makes it look intermittent: the
emulator relaunches RDS containers from persisted state at boot, but has no
equivalent reconciler for DocumentDB or ElastiCache. A single teardown can
therefore leave the relational databases healthy and the other two phantom.

## Rules

- **`make clean` runs `docker compose down -v` unconditionally.** It is
  destructive and does **not** prompt. That absence of a prompt is deliberate:
  the old prompt defaulted to *keeping* the state, which is precisely what made
  from-scratch rebuilds non-deterministic. Do not reintroduce a confirmation
  step, and do not offer a "keep the data" option.
- **Never trust a reported `available` status after touching the emulator
  container.** Check `docker ps` for the backing container.
- **`make doctor` cross-checks** every declared DocumentDB/ElastiCache resource
  against `docker ps` and exits non-zero when state and reality disagree. Run it
  when the local stack behaves oddly, before debugging the service that failed.
- **`make bootstrap` is the single supported entry point** for bringing the
  local stack up; a full rebuild is `make clean && make bootstrap`.
- Runtime **state** belongs in named volumes. Files a container merely reads
  (for example a collector config mounted read-only) are **source**, not state,
  and stay bind mounts.

## Recovering a phantom without a full rebuild

Delete the resource through its own API (for example
`aws docdb delete-db-cluster --skip-final-snapshot`, or
`aws elasticache delete-replication-group`), then `terraform taint` the module's
`terraform_data.*_via_cli` resource and re-apply that target.

A plain `-target` apply does **nothing** on its own — the awscli-fallback
resources only re-run when their trigger changes.

## Do not list DocumentDB clusters with `aws docdb describe-db-clusters`

Against this emulator that call returns the **RDS** clusters and omits the
DocumentDB one entirely, so it yields both false phantoms and a missed real
cluster. The generated `DOCDB_HOST` **is** the container name — check that
instead.