---
title: "Execution log for provisioning scripts"
type: pattern
area: shared
status: active
created: 2026-07-31
updated: 2026-07-31
tags:
  - type/pattern
  - area/shared
  - status/active
related:
  - "[[awscli-fallback-for-floci]]"
  - "[[two-phase-terraform-apply]]"
  - "[[local-dev-floci]]"
---

# Execution log for provisioning scripts

## Pattern

When one or more scripts run as `local-exec` provisioners outside Terraform's own resource
lifecycle — the [[awscli-fallback-for-floci]] pattern, or any other `terraform_data` +
`local-exec` wrapper — record **that** each ran, against what resource, and whether it
succeeded, in a durable log external to the terminal. Wrap the script's existing body in a
context manager (`lib3mrai.execution_log.record_execution(...)` in this repo) that writes a
before/after entry to a DynamoDB table (`infra.modules.tf-backend`-declared `execution_log`;
partition key `script_name`, sort key `run_key = <resource_id>#<start timestamp, ISO 8601>`).

The sort key folds the resource's identity into itself specifically so that a resource
recreated by `make clean` starts a fresh, distinguishable history instead of colliding with
its predecessor's run under the same key.

## Why a log and not a cache

Two rules make this a log rather than a cache, and both are load-bearing — relaxing either
turns the log into a source of silent failures:

- **Record, never skip.** The wrapped scripts are already idempotent on their own terms
  (`CREATE ... IF NOT EXISTS`, lookup-then-reuse, a declarative `UpdateUserPool`), and
  `make clean` routinely destroys and recreates the underlying resources. A design that used
  the record to *skip* re-running a script would read stale history after a `make clean`,
  conclude "already done," and leave the newly recreated resource unprovisioned while
  looking ready — strictly worse than not logging at all. So the wrapper **always** runs the
  wrapped body; it only records the outcome, before and after.
- **Fail-open.** If the log's own backing store (DynamoDB, here) is unreachable, the wrapper
  warns to stderr and lets the wrapped script run anyway. A traceability aid must not make
  provisioning newly fragile because its own logging dependency is down.

## Verified case: the log demonstrating its own design

In [[two-phase-terraform-apply]] (`infra/environments/local/post/`), after fixing a grants
script, `make post-infra` failed again with the same error. The log explained why: there was
**one** recorded run of `grant_mysql_provider_privileges.py` where two were expected.
`terraform_data` keys off its `input`, which hadn't changed, so Terraform treated the
provisioner as up to date and never re-ran it despite the script change —
`terraform apply -replace` was needed to force it.

This is exactly the scenario "record, never skip" exists for: the log made a non-run
**visible**. Had the design instead let recorded history skip re-execution, it would have
**hidden** this exact case rather than exposing it.

## When to use it

Use this pattern for any local-exec-provisioned script whose success or absence is otherwise
invisible once the terminal scrolls past it — particularly when several such scripts chain
together (as the four, now five, phase-1/phase-2 provisioning scripts in
[[two-phase-terraform-apply]] do) and a failure needs to be traced to a specific script,
resource, and attempt rather than inferred from a downstream symptom.

Do not reach for it as a substitute for Terraform state tracking on resources Terraform
*can* manage natively — it exists only for the [[awscli-fallback-for-floci]] gap, not as a
general auditing layer.

## Related

- [[awscli-fallback-for-floci]] — the pattern this log wraps: `local-exec` scripts standing
  in for resources Terraform cannot apply natively against Floci.
- [[two-phase-terraform-apply]] — the ADR whose phase-2 update introduced this log and the
  live verification of both design rules.
- [[local-dev-floci]] — the local bootstrap runbook whose provisioning chain these scripts
  are part of.
