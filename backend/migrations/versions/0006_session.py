"""Sessions, their Lines, and Sets.

A Session pins its Routine and Day for good (RESTRICT), the Day belonging to the Routine; its Turn
pin may dangle (SET NULL on turn_id alone), like a Skip's. At most one Session per civil date across
all Routines. A Session Line names an Exercise (RESTRICT: an Exercise on any Line can't be deleted);
it is the Session's own copy, not linked to a Day Line. A Set has positive Reps and a non-negative
Weight stored as typed (unconstrained numeric keeps the typed scale). Positions are unique per
Session / per Line, checked at commit so a reorder can swap them.

Revision ID: 0006
Revises: 0005
"""

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "session",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("routine_id", sa.Integer(), sa.ForeignKey("routine.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("day_id", sa.Integer(), nullable=False),
        sa.Column("turn_id", sa.Integer(), nullable=True),
        sa.UniqueConstraint("date", name="session_one_per_date"),
        sa.ForeignKeyConstraint(
            ["day_id", "routine_id"], ["day.id", "day.routine_id"], name="session_day_of_routine", ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["turn_id", "day_id"],
            ["turn.id", "turn.day_id"],
            name="session_turn_of_day",
            ondelete="SET NULL (turn_id)",
        ),
    )
    op.create_index("session_routine_date", "session", ["routine_id", "date"])
    op.create_index("session_turn", "session", ["turn_id"])

    op.create_table(
        "session_line",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("session.id", ondelete="CASCADE"), nullable=False),
        sa.Column("exercise_id", sa.Integer(), sa.ForeignKey("exercise.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.CheckConstraint("position >= 0", name="session_line_position_not_negative"),
        sa.UniqueConstraint(
            "session_id", "position", name="session_line_position_key", deferrable=True, initially="DEFERRED"
        ),
    )
    op.create_index("session_line_exercise", "session_line", ["exercise_id"])

    op.create_table(
        "session_set",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("line_id", sa.Integer(), sa.ForeignKey("session_line.id", ondelete="CASCADE"), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("reps", sa.Integer(), nullable=False),
        sa.Column("weight", sa.Numeric(), nullable=False),
        sa.Column("warmup", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("note", sa.String(), nullable=True),
        sa.CheckConstraint("position >= 0", name="session_set_position_not_negative"),
        sa.CheckConstraint("reps > 0", name="session_set_reps_positive"),
        sa.CheckConstraint("weight >= 0", name="session_set_weight_not_negative"),
        sa.CheckConstraint("note <> ''", name="session_set_note_not_empty"),
        sa.UniqueConstraint(
            "line_id", "position", name="session_set_position_key", deferrable=True, initially="DEFERRED"
        ),
    )


def downgrade() -> None:
    op.drop_table("session_set")
    op.drop_table("session_line")
    op.drop_table("session")
