"""add tracking_number to tracking

The customer-facing shipment number the notification emails quote —
`3MRAI-XXXX-XXXX-XXXX`, minted by `src/shared/db/tracking_number.py` at creation.
See `docs/superpowers/specs/2026-08-05-email-payload-enrichment-design.md`: the
rebranded templates render a tracking number the envelope did not carry and the
schema did not hold, and since a tracking row is created at `PLACED` — long
before a carrier is involved — the value is OURS to mint rather than one to
receive.

## Three steps, because the column is NOT NULL and UNIQUE

`ADD COLUMN ... NOT NULL` on a populated table fills existing rows with the type's
implicit default (`''` for VARCHAR), which the unique index would then reject the
moment there is more than one row — the migration would fail on exactly the
environments that have data, and only on those. So the column arrives nullable,
every existing row is backfilled with a value of its own, and only then are the
NOT NULL and the unique constraint applied:

1. `ADD COLUMN tracking_number VARCHAR(20) NULL`
2. backfill — see below
3. `ALTER ... NOT NULL` + `ADD CONSTRAINT uq_tracking_tracking_number UNIQUE`

Step 3 is what verifies step 2: if the backfill had produced duplicates (or left
a NULL), the ALTER fails and the transaction rolls back, rather than the table
ending up in a shape the models disagree with.

## The backfill generates values, it does not fake them

Rows predating this column are real shipments belonging to real users, and the
next status transition on any of them emails its owner a number. Deleting them,
or filling them all with one placeholder, would either destroy data or hand
several customers the same identifier — so each row gets its own freshly minted
number, from the same generator the application uses.

The generation happens in **Python, row by row**, not in SQL. MySQL has no
CSPRNG: `RAND()` is a fast PRNG explicitly documented as unsuitable for anything
where predictability matters, and the whole point of `secrets` in the generator
is that a tracking number quoted in an email must not be guessable. Reusing the
application's function also means backfilled rows are indistinguishable in shape
from rows created afterwards — one format, one alphabet, one place to change it.

The backfill loops on collisions rather than assuming uniqueness. With 60 bits of
entropy a repeat is not a practical concern, but the ALTER in step 3 would fail
on one, and a migration that can fail on a coin flip is worse than a loop that
cannot.

## Downgrade

Drops the constraint before the column — MySQL will not drop a column an index
still covers. The numbers are not recoverable afterwards, which is inherent to
dropping the column that holds them.

Revision ID: c93b7d1f52ae
Revises: 0a1cc6845c4a
Create Date: 2026-08-05

"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from src.shared.db.tracking_number import (
    TRACKING_NUMBER_LENGTH,
    new_tracking_number,
)

revision: str = 'c93b7d1f52ae'
down_revision: str | None = '0a1cc6845c4a'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UNIQUE_CONSTRAINT = 'uq_tracking_tracking_number'


def _backfill(connection) -> None:
    """Give every existing row its own generated number.

    Soft-deleted rows are backfilled too: they are still rows in a NOT NULL
    column, and excluding them would leave NULLs that step 3 then rejects.
    """
    ids = [
        row[0]
        for row in connection.execute(sa.text('SELECT id FROM tracking')).fetchall()
    ]
    if not ids:
        return

    # Track what has been handed out inside this run as well as what the table
    # already holds, so the uniqueness the next ALTER demands is established
    # before it is asserted.
    used: set[str] = set()
    for tracking_id in ids:
        number = new_tracking_number()
        while number in used:
            number = new_tracking_number()
        used.add(number)
        connection.execute(
            sa.text(
                'UPDATE tracking SET tracking_number = :number WHERE id = :id'
            ),
            {'number': number, 'id': tracking_id},
        )


def upgrade() -> None:
    # Step 1 — nullable, so existing rows are not filled with one shared ''.
    op.add_column(
        'tracking',
        sa.Column(
            'tracking_number',
            sa.String(length=TRACKING_NUMBER_LENGTH),
            nullable=True,
        ),
    )

    # Step 2 — one distinct value per existing row.
    _backfill(op.get_bind())

    # Step 3 — the shape the models declare. Fails loudly if step 2 left a NULL
    # or a duplicate, instead of drifting from `Tracking.tracking_number`.
    op.alter_column(
        'tracking',
        'tracking_number',
        existing_type=sa.String(length=TRACKING_NUMBER_LENGTH),
        nullable=False,
    )
    op.create_unique_constraint(UNIQUE_CONSTRAINT, 'tracking', ['tracking_number'])


def downgrade() -> None:
    # The constraint first: MySQL refuses to drop a column an index still covers.
    op.drop_constraint(UNIQUE_CONSTRAINT, 'tracking', type_='unique')
    op.drop_column('tracking', 'tracking_number')
