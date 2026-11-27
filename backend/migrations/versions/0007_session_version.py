"""A Session's version: every write bumps it, and a write naming an older version is refused, so a
screen that missed another write can't drop that write's Sets by leaving them out of its post-state.

Revision ID: 0007
Revises: 0006
"""

import sqlalchemy as sa
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("session", sa.Column("version", sa.Integer(), server_default="1", nullable=False))


def downgrade() -> None:
    op.drop_column("session", "version")
