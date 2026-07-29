"""Declarative base and the shared audit/soft-delete column mixin.

Column naming is `snake_case` per the db-naming convention; Python attributes are
`snake_case` too (the idiomatic mapping for SQLAlchemy — the convention's
"PascalCase domain attribute" wording reflects the .NET/TS services, and its
actual requirement is that ORM aliasing bridges storage naming to the language's
own idiom, which this does).
"""

from datetime import datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Declarative base for every Tracking table."""


class AuditMixin:
    """Standard audit fields + soft-delete.

    Per the audit-fields / soft-delete conventions.

    `created_by` / `updated_by` / `deleted_by` hold a semantic **actor** string
    (`tracking_api:<action>`), not a bare user id — the same shape Orders uses in
    `AuditActor`. See `shared/audit/audit_actor.py`.

    There are no hard deletes anywhere: deleting stamps `deleted_at` / `deleted_by`.
    `is_deleted` is computed from `deleted_at`, never stored.
    """

    # 26 chars matches Orders' audit column width and comfortably holds a
    # `tracking_api:<action>` actor value.
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    deleted_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    @property
    def is_deleted(self) -> bool:
        """Computed, never persisted — true once `deleted_at` is stamped."""
        return self.deleted_at is not None
