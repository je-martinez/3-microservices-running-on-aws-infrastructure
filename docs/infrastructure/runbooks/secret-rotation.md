---
title: Secret Rotation
type: runbook
area: infra
status: active
created: 2026-06-26
updated: 2026-06-26
integration-status: n/a
verified-on: null
verified-by: null
tags: [type/runbook, area/infra, status/active]
related:
  - ADR-0007-secrets-parameter-store
  - soft-delete
---

# Secret Rotation

## When to run this

Run this runbook when:

- A new database user must be created for a service (initial setup or new environment).
- A periodic credential rotation is due (recommended every 90 days).
- A potential credential compromise is suspected.

> [!warning] Privilege constraint
> DB users in 3MRAI are created **without** `DELETE` privilege. Row removal is handled
> exclusively via soft-delete flags; see [[soft-delete]] and [[ADR-0004-soft-delete-only]].
> Never grant `DELETE` when creating or rotating a user.

See [[ADR-0007-secrets-parameter-store]] for the decision on using Secret Manager for
credentials versus Parameter Store for non-sensitive config.

## Steps

### 1. Create the database user (writer)

Connect to the Aurora writer endpoint with an admin account and create the service user:

```sql
-- PostgreSQL (users-service, orders-service)
CREATE USER <service>_writer WITH PASSWORD '<strong-random-password>';
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO <service>_writer;
-- No DELETE granted intentionally

-- MySQL (tracking-service)
CREATE USER '<service>_writer'@'%' IDENTIFIED BY '<strong-random-password>';
GRANT SELECT, INSERT, UPDATE ON <db_name>.* TO '<service>_writer'@'%';
-- No DELETE granted intentionally
```

### 2. Create the database user (reader)

```sql
-- PostgreSQL
CREATE USER <service>_reader WITH PASSWORD '<strong-random-password>';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO <service>_reader;

-- MySQL
CREATE USER '<service>_reader'@'%' IDENTIFIED BY '<strong-random-password>';
GRANT SELECT ON <db_name>.* TO '<service>_reader'@'%';
```

### 3. Store credentials in Secret Manager

```bash
aws secretsmanager create-secret \
  --name "3mrai/<env>/<service>/db-writer" \
  --description "Writer DB credentials for <service> in <env>" \
  --secret-string '{
    "username": "<service>_writer",
    "password": "<strong-random-password>",
    "host": "<aurora-writer-endpoint>",
    "port": 5432,
    "dbname": "<db_name>"
  }'

aws secretsmanager create-secret \
  --name "3mrai/<env>/<service>/db-reader" \
  --description "Reader DB credentials for <service> in <env>" \
  --secret-string '{
    "username": "<service>_reader",
    "password": "<strong-random-password>",
    "host": "<aurora-reader-endpoint>",
    "port": 5432,
    "dbname": "<db_name>"
  }'
```

Secret naming follows the `cloudposse/label/null` convention; see [[terraform-modules]].

### 4. Update ECS task definition

Reference the new secret ARNs in the task definition `secrets` block so the updated
credentials are injected at next container start:

```json
{
  "secrets": [
    {
      "name": "DB_WRITER_URL",
      "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:3mrai/<env>/<service>/db-writer"
    },
    {
      "name": "DB_READER_URL",
      "valueFrom": "arn:aws:secretsmanager:<region>:<account>:secret:3mrai/<env>/<service>/db-reader"
    }
  ]
}
```

### 5. Deploy the updated task definition

```bash
aws ecs update-service \
  --cluster 3mrai-<env> \
  --service <service> \
  --force-new-deployment
```

### 6. Revoke old credentials

Once the new deployment is healthy, drop the old DB user:

```sql
-- PostgreSQL
DROP USER IF EXISTS <old_user>;

-- MySQL
DROP USER IF EXISTS '<old_user>'@'%';
```

Also delete the old Secret Manager secret:

```bash
aws secretsmanager delete-secret \
  --secret-id "3mrai/<env>/<service>/db-writer-old" \
  --force-delete-without-recovery
```

## Verification

- `aws secretsmanager describe-secret --secret-id "3mrai/<env>/<service>/db-writer"` returns
  the new secret without error.
- ECS service shows `runningCount` matching `desiredCount` in `aws ecs describe-services`.
- Service health check responds HTTP 200 (see [[local-dev-ministack]] for local verification).
- No `DELETE` privilege exists on any 3MRAI DB user:
  ```sql
  -- PostgreSQL
  SELECT grantee, privilege_type FROM information_schema.role_table_grants
  WHERE privilege_type = 'DELETE';
  -- Expected: 0 rows for service users
  ```

## Related

- [[ADR-0007-secrets-parameter-store]]
- [[ADR-0004-soft-delete-only]]
- [[soft-delete]]
- [[aws-resources]]
- [[terraform-modules]]
- [[local-dev-ministack]]
