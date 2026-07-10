---
title: "Floci storage modes & the truncated-.tmp corruption"
type: lesson
area: infra
status: active
created: 2026-07-09
updated: 2026-07-09
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/medium
related:
  - "[[floci-vs-ministack-spike-findings]]"
  - "[[ADR-0017-floci-local]]"
  - "[[local-dev]]"
  - "[[floci-rds-apigw-limits]]"
---

# Floci storage modes & the truncated-.tmp corruption

Empirical findings on `floci/floci:latest` persistence/storage modes, verified 2026-07-09 by
running Floci containers in isolation. Two independent findings: (1) the official Floci README's
mode recommendation is wrong for how 3MRAI is already configured, and (2) a real but rare and
non-mode-specific state-file corruption pattern to watch for operationally.

## Finding 1 — the README's `hybrid` recommendation is wrong for 3MRAI

Floci's [README](https://github.com/floci-io/floci#persistence-and-storage-modes) documents four
storage modes and recommends: *"Use `hybrid` when you want state preserved across container
restarts without much overhead."* It describes `hybrid` as offering "in-memory performance with
periodic async flushing every 5 seconds," and `persistent` as "flushed to disk immediately on
every write operation."

### Test performed

Measured actual durability rather than trusting the description: start Floci on a fresh volume →
`sqs create-queue` → wait 0.5s → `docker kill -s KILL` (no graceful shutdown, simulating a crash)
→ restart Floci on the **same** volume → `sqs list-queues`.

| Mode | Survives SIGKILL 0.5s after write? |
|---|---|
| `persistent` | yes |
| `hybrid` | **no — data lost** |
| `wal` | yes |

`hybrid`'s 5-second async flush window is wide enough to lose a write that a hard kill catches
before the flush.

### Implication for 3MRAI

> [!warning] Do not "optimize" the compose file to `hybrid`
> 3MRAI's `docker-compose.yml` already sets `FLOCI_STORAGE_MODE=persistent`, which is the
> **correct** choice per this test — it survived every SIGKILL trial. Following the README's
> `hybrid` recommendation would have **reduced** durability for local dev (e.g. losing
> Terraform-applied state on an unclean container stop). No compose change was made as a result
> of this finding; it is recorded so the setting isn't "optimized" to `hybrid` later based on the
> README alone.

Also note, correcting an earlier misreading: `persistent` genuinely does flush immediately (the
SIGKILL test proves it). The 89 files under `data/floci/` sharing an identical `Jul 4 00:15`
mtime are simply the timestamp of the last `terraform apply` that touched them — not evidence of
a deferred single dump, as was initially assumed.

## Finding 2 — truncated `.tmp` corruption (real, rare, NOT mode-specific)

`data/floci/` contained an orphaned `ecs-task-definitions.json.tmp` (656 bytes) with no
corresponding `.json` file. Floci writes state via a write-to-`.tmp`-then-rename pattern.

### Verified consequences

- The `.tmp` file is **truncated mid-serialization** — cut off inside `portMappings`. It is not
  valid JSON; `json.load()` fails on it.
- On boot, Floci **silently ignores** the orphaned `.tmp` — `ecs list-task-definitions` returned
  `[]`. No error, warning, or log line calls out the orphaned file.
- Promoting the `.tmp` to `.json` (renaming it) does **not** recover the data — the result is
  still `[]`, because the content itself is truncated, not just misnamed. The data is
  unrecoverable.
- `ecs-services.json` referenced task-definition revision `:3`, meaning at least 3 revisions had
  been written and none reached a final, valid `.json` — leaving ECS services pointing at task
  definitions that no longer existed.

### What was and was NOT established

> [!important] Root cause is unknown — do not treat the hypothesis below as fact
> This is **not** a deterministic failure of `persistent` mode. On a clean Floci container, all
> three modes (`persistent`, `hybrid`, `wal`) wrote `ecs-task-definitions.json` correctly with no
> orphaned `.tmp`. The corruption could **not** be reproduced — not even by sending SIGKILL during
> 60 concurrent `register-task-definition` calls. The corruption window is milliseconds wide.
>
> **The root cause of the original corruption is unknown.** The plausible-but-unproven hypothesis
> is that Floci died mid-`terraform apply` roughly 5 days prior to discovery — a
> `floci-ecs-...-nginx` container was found still running, orphaned from a Floci instance that no
> longer existed, which is consistent with (but does not prove) an ungraceful Floci death during
> that apply. Treat this as a hypothesis, not an established cause.

### Remediation applied (2026-07-09)

- Deleted the truncated `data/floci/ecs-task-definitions.json.tmp` (safe — the data was
  unrecoverable; nothing was lost that wasn't already lost).
- Removed the 5-day-old orphaned `floci-ecs-*` container.
- ECS state regenerates cleanly via `terraform apply` against the now-clean volume.

### Operational guidance

If Floci starts with ECS (or other) resources unexpectedly missing, check `ls data/floci/*.tmp`
for orphaned temp files before assuming the resource was never created — Floci ignores orphaned
`.tmp` files silently rather than erroring, so the symptom is "state vanished" with no
corresponding log line. If stronger crash durability is ever needed beyond what `persistent`
already provides, `wal` is the mode to evaluate next — it also survived the SIGKILL test in
Finding 1.

## Related

- [[floci-vs-ministack-spike-findings]]
- [[ADR-0017-floci-local]]
- [[local-dev]]
- [[floci-rds-apigw-limits]]
