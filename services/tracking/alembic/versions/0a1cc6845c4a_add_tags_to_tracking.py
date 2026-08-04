"""add tags to tracking

The row-level label the E2E teardown selects on. `DELETE
/v1/trackings/e2e-cleanup` used to soft-delete the CALLING USER's trackings, which
its only caller can never invoke: the harness's teardown runs once, globally, with
no user session and therefore no `x-user-id`. Deleting by tag moves the decision to
creation, where an identity does exist, and leaves the teardown one unscoped
predicate. Users already works exactly this way (`user.tags` contains
`"E2E Source"`).

## JSON, not an array column

Users stores its tags as a Postgres `text[]`. MySQL has no array type, so the
portable equivalent is a JSON array, queried with `JSON_CONTAINS` (verified on
MySQL 8.0.46). A child `tracking_tag` table would be the right shape for tags that
are joined and indexed; these are neither — one harness label, one query.

## NOT NULL with a server-side `JSON_ARRAY()` default

"No tags" gets exactly one spelling. It also matters for the predicate:
`JSON_CONTAINS(NULL, ...)` evaluates to NULL rather than false, so a NULL row would
be excluded from the cleanup for a reason that reads like an accident rather than a
rule. The default is declared server-side so a row inserted by anything that does
not go through the ORM is still `[]`.

Existing rows are backfilled to `[]` by that default, which is the correct value
for every one of them: they predate the tag, so none is an E2E fixture and none
should be swept up by the first teardown that runs after this migration.

## `tracking_history` deliberately does NOT get this column

Its rows are reached through their parent's `tracking_id`, so "the children of
every tagged tracking" is expressible without copying the tag down. Copying it
would give the tag two sources of truth that a partial update could put out of
step, and a tagged history row under an untagged tracking has no meaning — a
transition is not independently an E2E fixture, its shipment is. This is why the
column differs from `cognito_sub`, which that table DOES denormalize: the sub is
ownership context the reads scope by, so a transition row has to carry it to be
self-describing.

A SEPARATE migration rather than an edit to `b17f4c2e9a30`, for the same reason
that one was separate from `da01eaebb060`: the earlier revisions are committed and
may already be applied, so rewriting one would leave an environment that ran it
with a schema Alembic believes is current and that is missing this column.

Revision ID: 0a1cc6845c4a
Revises: b17f4c2e9a30
Create Date: 2026-08-03

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0a1cc6845c4a'
down_revision: str | None = 'b17f4c2e9a30'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'tracking',
        sa.Column(
            'tags',
            sa.JSON(),
            nullable=False,
            # Parenthesized because MySQL requires a DEFAULT on a JSON column to be
            # an expression — a bare literal default is not permitted for
            # JSON/BLOB/TEXT at all. Matches `Tracking.tags`'s `server_default`, so
            # `alembic check` sees no drift.
            server_default=sa.text('(JSON_ARRAY())'),
        ),
    )


def downgrade() -> None:
    op.drop_column('tracking', 'tags')
