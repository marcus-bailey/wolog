"""Skips: a dated pass of the suggested Turn on a Routine.

A Skip pins its Routine and Day for good (RESTRICT: neither can be destroyed while pinned), and the
Day must belong to the Routine. Its Turn pin may dangle: when the Turn is removed, turn_id is set to
null and the Skip holds no Turn. The Turn, while it exists, names the Skip's Day.

Revision ID: 0005
Revises: 0004
"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint("turn_id_day_key", "turn", ["id", "day_id"])
    op.create_table(
        "skip",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("routine_id", sa.Integer(), sa.ForeignKey("routine.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("day_id", sa.Integer(), nullable=False),
        sa.Column("turn_id", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(
            ["day_id", "routine_id"], ["day.id", "day.routine_id"], name="skip_day_of_routine", ondelete="RESTRICT"
        ),
        # A removed Turn leaves the Skip holding no Turn: SET NULL on turn_id alone (Postgres 15+).
        sa.ForeignKeyConstraint(
            ["turn_id", "day_id"], ["turn.id", "turn.day_id"], name="skip_turn_of_day", ondelete="SET NULL (turn_id)"
        ),
    )
    op.create_index("skip_routine_date", "skip", ["routine_id", "date", "id"])
    op.create_index("skip_turn", "skip", ["turn_id"])


def downgrade() -> None:
    op.drop_table("skip")
    op.drop_constraint("turn_id_day_key", "turn")
