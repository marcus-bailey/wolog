"""Days, their Lines, and the rotation's Turns.

A Day belongs to one Routine for good; its name is unique within the Routine. A Day Line names an
Exercise (ON DELETE RESTRICT: an Exercise on a Line can't be deleted). A Turn names a Day of the same
Routine, enforced by a composite foreign key. Positions are unique per Day / per Routine, checked at
commit so a reorder can swap them.

Revision ID: 0004
Revises: 0003
"""

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "day",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("routine_id", sa.Integer(), sa.ForeignKey("routine.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(), nullable=False),
        sa.CheckConstraint("name <> ''", name="day_name_not_empty"),
        sa.UniqueConstraint("id", "routine_id", name="day_id_routine_key"),
    )
    op.create_index("day_name_key", "day", ["routine_id", sa.text("lower(name)")], unique=True)

    op.create_table(
        "day_line",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("day_id", sa.Integer(), sa.ForeignKey("day.id", ondelete="CASCADE"), nullable=False),
        sa.Column("exercise_id", sa.Integer(), sa.ForeignKey("exercise.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.CheckConstraint("position >= 0", name="day_line_position_not_negative"),
        sa.UniqueConstraint("day_id", "position", name="day_line_position_key", deferrable=True, initially="DEFERRED"),
    )
    op.create_index("day_line_exercise", "day_line", ["exercise_id"])

    op.create_table(
        "turn",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("routine_id", sa.Integer(), sa.ForeignKey("routine.id", ondelete="CASCADE"), nullable=False),
        sa.Column("day_id", sa.Integer(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.CheckConstraint("position >= 0", name="turn_position_not_negative"),
        sa.ForeignKeyConstraint(
            ["day_id", "routine_id"], ["day.id", "day.routine_id"], name="turn_day_of_routine", ondelete="CASCADE"
        ),
        sa.UniqueConstraint("routine_id", "position", name="turn_position_key", deferrable=True, initially="DEFERRED"),
    )
    op.create_index("turn_day", "turn", ["day_id"])


def downgrade() -> None:
    op.drop_table("turn")
    op.drop_table("day_line")
    op.drop_table("day")
