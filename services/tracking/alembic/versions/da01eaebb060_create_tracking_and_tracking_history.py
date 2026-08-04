"""create tracking and tracking_history

The Tracking service's initial schema (JE-88). Both tables carry the standard
audit columns and soft-delete; `tracking_history` uses the composite primary key
`(tracking_id, status)` and deliberately has no surrogate id and no
`shipping_address` — the address is fixed per tracking, not per transition.

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


def upgrade() -> None:
    op.create_table('tracking',
    sa.Column('id', sa.String(length=26), nullable=False),
    sa.Column('user_id', sa.String(length=26), nullable=False),
    sa.Column('order_id', sa.String(length=26), nullable=False),
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
    sa.Column('tracking_id', sa.String(length=26), nullable=False),
    sa.Column('status', sa.String(length=50), nullable=False),
    sa.Column('user_id', sa.String(length=26), nullable=False),
    sa.Column('order_id', sa.String(length=26), nullable=False),
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
