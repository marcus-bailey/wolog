"""The Exercise library: names unique case-insensitively.

Revision ID: 0001
Revises:
"""

import sqlalchemy as sa
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "exercise",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.CheckConstraint("name <> ''", name="exercise_name_not_empty"),
    )
    op.create_index("exercise_name_key", "exercise", [sa.text("lower(name)")], unique=True)


def downgrade() -> None:
    op.drop_table("exercise")
