"""create tracking and tracking_history

The Tracking service's initial schema (JE-88). Both tables carry the standard
audit columns and soft-delete; `tracking_history` uses the composite primary key
`(tracking_id, status)` and deliberately has no surrogate id and no
`shipping_address` — the address is fixed per tracking, not per transition.

## The id columns are VARCHAR(28), and this revision was EDITED to say so

They were VARCHAR(26), sized for the old `xxx_` + 21-char nano ID. The id format
now uses a 24-char random portion over a letters-and-digits alphabet, so a full
id is 28 characters and a 26-wide column would TRUNCATE every one of them —
silently, because that is what MySQL does with an over-long string.

This revision was amended in place rather than followed by an `alter_column`
migration, unlike `b17f4c2e9a30` which explains at length why it did the
opposite. The difference is the situation, not the principle: this change was
made while the only environment that had ever applied these revisions was a
local, disposable one, and the user authorised rebuilding it. Editing an applied
revision in a shared environment would leave a schema Alembic believes is current
and that is missing the change — if this repository ever grows an environment
whose data outlives a rebuild, the next width change must be a new revision.

Revision ID: da01eaebb060
Revises:
Create Date: 2026-07-29

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'da01eaebb060'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Width of every id-bearing column: prefix (4) + random portion (24). The same
# number `NanoIdConfig.TOTAL_LENGTH` derives in `src/shared/db/nano_id.py`, and
# the number Users and Orders size their id columns for.
#
# Written out here rather than imported from the model: a migration describes the
# schema AT ITS REVISION and must keep producing that schema after the models
# move on. Importing the live constant would make this file silently re-describe
# itself the next time the format changes, which is the one thing a migration
# history must not do.
ID_LENGTH = 28


def upgrade() -> None:
    op.create_table('tracking',
    sa.Column('id', sa.String(length=ID_LENGTH), nullable=False),
    sa.Column('user_id', sa.String(length=ID_LENGTH), nullable=False),
    sa.Column('order_id', sa.String(length=ID_LENGTH), nullable=False),
    sa.Column('status', sa.String(length=50), nullable=False),
    sa.Column('shipping_address', sa.JSON(), nullable=True),
    sa.Column('datetime', sa.DateTime(), nullable=False),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_by', sa.String(length=64), nullable=True),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.Column('deleted_by', sa.String(length=64), nullable=True),
    sa.Column('deleted_at', sa.DateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('order_id', name='uq_tracking_order_id')
    )
    op.create_index('idx_tracking_deleted_at', 'tracking', ['deleted_at'], unique=False)
    op.create_index('idx_tracking_order_id_user_id', 'tracking', ['order_id', 'user_id'], unique=False)
    op.create_index('idx_tracking_user_id', 'tracking', ['user_id'], unique=False)
    op.create_table('tracking_history',
    sa.Column('tracking_id', sa.String(length=ID_LENGTH), nullable=False),
    sa.Column('status', sa.String(length=50), nullable=False),
    sa.Column('user_id', sa.String(length=ID_LENGTH), nullable=False),
    sa.Column('order_id', sa.String(length=ID_LENGTH), nullable=False),
    sa.Column('datetime', sa.DateTime(), nullable=False),
    sa.Column('created_by', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(), nullable=False),
    sa.Column('updated_by', sa.String(length=64), nullable=True),
    sa.Column('updated_at', sa.DateTime(), nullable=False),
    sa.Column('deleted_by', sa.String(length=64), nullable=True),
    sa.Column('deleted_at', sa.DateTime(), nullable=True),
    sa.ForeignKeyConstraint(['tracking_id'], ['tracking.id'], name='fk_tracking_history_tracking_id'),
    sa.PrimaryKeyConstraint('tracking_id', 'status')
    )
    op.create_index('idx_tracking_history_deleted_at', 'tracking_history', ['deleted_at'], unique=False)
    op.create_index('idx_tracking_history_order_id_user_id', 'tracking_history', ['order_id', 'user_id'], unique=False)


def downgrade() -> None:
    op.drop_index('idx_tracking_history_order_id_user_id', table_name='tracking_history')
    op.drop_index('idx_tracking_history_deleted_at', table_name='tracking_history')
    op.drop_table('tracking_history')
    op.drop_index('idx_tracking_user_id', table_name='tracking')
    op.drop_index('idx_tracking_order_id_user_id', table_name='tracking')
    op.drop_index('idx_tracking_deleted_at', table_name='tracking')
    op.drop_table('tracking')
