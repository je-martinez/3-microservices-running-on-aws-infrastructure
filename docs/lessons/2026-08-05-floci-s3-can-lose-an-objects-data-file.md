---
title: "Floci S3 can lose an object's data file while keeping its index entry"
type: lesson
area: infra
status: active
created: 2026-08-05
updated: 2026-08-05
tags:
  - type/lesson
  - area/infra
  - status/active
  - severity/high
related:
  - "[[floci-storage-modes-and-tmp-corruption]]"
  - "[[floci-recreate-destroys-backing-containers]]"
  - "[[floci-rds-apigw-limits]]"
---

# Floci S3 can lose an object's data file while keeping its index entry

Floci's emulated S3 can lose an object's data file while the index entry survives. The Terraform state bucket then lists the state file but cannot serve it.

## Symptom (seen 2026-08-05)

`aws s3 ls s3://3mrai-local-tfstate-state/local/phase1/` listed `terraform.tfstate` at 147790 bytes, but every `GetObject` returned **500 Internal Server Error**. The Floci container logs named the real cause:

```
java.nio.file.NoSuchFileException:
  /app/data/s3/3mrai-local-tfstate-state/local/phase1/terraform.tfstate.s3data
  at io.github.hectorvent.floci.services.s3.S3Service.openObjectStream(S3Service.java:522)
```

## Diagnosis shortcut

`ls` working while `cp` / `get-object` returns 500 means the index and the data file have diverged.

- Do NOT chase Terraform backend config, credentials, or `-reconfigure`.
- Check `docker logs 3mrai-floci-1` early: the Java stack trace names the missing path outright.

## Consequence

The state is unreadable, so `terraform init`, `destroy` and `apply` all fail at the refresh step. `make infra-down` cannot run, because Terraform cannot read what it would destroy.

The only route back is discarding the volume (`docker compose down -v`, then `make bootstrap`). That wipes **all** local volumes, not just the tfstate bucket, so it needs explicit user confirmation beyond a plain "destroy the infra" approval.

## Related

- [[floci-storage-modes-and-tmp-corruption]]
- [[floci-recreate-destroys-backing-containers]]
- [[floci-rds-apigw-limits]]
