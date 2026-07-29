"""add cognito_sub to tracking and tracking_history

Fixes the identity mismatch that made every user-scoped REST read return 404.

`tracking.user_id` holds the INTERNAL `usr_` id that Orders resolves through Users
and sends over gRPC. But an end user's request reaches this service carrying the
gateway-injected `x-user-id` header, which holds the Cognito `sub` — nginx sets it
as `proxy_set_header x-user-id $jwt_sub`. Scoping the Phase D reads by `user_id`
therefore compared a sub against a `usr_` id, matched nothing, and answered 404 for
every caller including the tracking's rightful owner. Orders solved the identical
problem by persisting BOTH identities on its `order` table and filtering reads by
`cognito_sub`; this migration brings Tracking to the same shape.

A SEPARATE migration rather than an edit to `da01eaebb060`: that revision is
committed and may already be applied, so rewriting it would leave any environment
that ran it with a schema Alembic believes is current and that is missing these
columns.

Both columns are **nullable**, matching the optional wire field. A row created
before this field existed keeps NULL, which matches no caller's sub — invisible to
the user-scoped reads rather than attributed to the wrong person — while remaining
fully readable over the unscoped gRPC reads. `tracking_history` carries the column
too, alongside the `user_id`/`order_id` it already denormalizes, exactly as Orders'
`order_details` does.

Revision ID: b17f4c2e9a30
Revises: da01eaebb060
Create Date: 2026-07-29

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'b17f4c2e9a30'
down_revision: str | None = 'da01eaebb060'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Matches Orders' `order.cognito_sub` (varchar(255)) — the two MySQL services
# storing the same value under the same name must not disagree on its width.
COGNITO_SUB_LENGTH = 255


def upgrade() -> None:
    op.add_column(
        'tracking',
        sa.Column('cognito_sub', sa.String(length=COGNITO_SUB_LENGTH), nullable=True),
    )
    op.add_column(
        'tracking_history',
        sa.Column('cognito_sub', sa.String(length=COGNITO_SUB_LENGTH), nullable=True),
    )
    # The composite that actually serves the user-scoped reads: they filter on
    # (order_id, cognito_sub). The pre-existing (order_id, user_id) index is kept —
    # user_id remains a real reporting/join key even though no read scopes by it.
    op.create_index(
        'idx_tracking_order_id_cognito_sub',
        'tracking',
        ['order_id', 'cognito_sub'],
        unique=False,
    )
    op.create_index(
        'idx_tracking_cognito_sub', 'tracking', ['cognito_sub'], unique=False
    )
    op.create_index(
        'idx_tracking_history_order_id_cognito_sub',
        'tracking_history',
        ['order_id', 'cognito_sub'],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        'idx_tracking_history_order_id_cognito_sub', table_name='tracking_history'
    )
    op.drop_index('idx_tracking_cognito_sub', table_name='tracking')
    op.drop_index('idx_tracking_order_id_cognito_sub', table_name='tracking')
    op.drop_column('tracking_history', 'cognito_sub')
    op.drop_column('tracking', 'cognito_sub')
