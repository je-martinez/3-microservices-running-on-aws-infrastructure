# Tracking Go migrations (golang-migrate)

`000001_baseline.up.sql` is a SQUASH of the four Alembic revisions the Python
service arrived at, in order:

| Alembic revision | What it added |
|---|---|
| `da01eaebb060` | `tracking` + `tracking_history`, base indexes |
| `b17f4c2e9a30` | `cognito_sub` on both tables + its two indexes |
| `0a1cc6845c4a` | `tracking.tags` (JSON, NOT NULL, `(JSON_ARRAY())` default) |
| `c93b7d1f52ae` | `tracking.tracking_number` + its UNIQUE constraint |

The Go service does not replay that history. It declares the schema the history
produced.

## The two version tables are mutually blind

golang-migrate stores state in `schema_migrations (version BIGINT, dirty BOOLEAN)`.
Alembic stores it in `alembic_version (version_num VARCHAR(32))`. Neither tool
reads the other's table, and neither will warn you about the other.

### Applying to an EXISTING (already-Alembic-migrated) database

The tables already exist. Running the baseline would fail on `CREATE TABLE`.
Stamp instead of migrate:

    migrate -path ./migrations \
            -database "mysql://$USER:$PASS@tcp($HOST:$PORT)/$DB" \
            force 1

`force 1` writes `(version=1, dirty=0)` into `schema_migrations` WITHOUT running
any SQL — it asserts "the schema is already at version 1".

### What happens to `alembic_version`

**Decision: while both services run, `alembic_version` STAYS, untouched.** The
Python service is still live during coexistence and Alembic must keep believing
it is current.

**On Python deletion, `alembic_version` is DROPPED** in the same change that
removes `services/tracking/`:

    DROP TABLE alembic_version;

Leaving both tables behind permanently is a silent trap: a stray
`alembic upgrade head` against a database whose schema has since moved on under
golang-migrate would believe it is current and do nothing, or would apply a
revision that conflicts with what golang-migrate has since written. One tool
owns the schema; the other's bookkeeping goes away with it.

### Applying to a FRESH database

    migrate -path ./migrations \
            -database "mysql://$USER:$PASS@tcp($HOST:$PORT)/$DB" \
            up

## `dirty` state

If a migration fails midway, golang-migrate marks the version dirty and refuses
to run again. Fix the schema by hand, then `force <version>` to clear the flag.
