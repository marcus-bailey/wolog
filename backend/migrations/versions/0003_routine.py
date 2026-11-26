"""Routines and the Engaged Routine: names unique case-insensitively; once any Routine exists,
exactly one is engaged.

At most one: a unique index over the engaged row. At least one: a deferred constraint trigger,
checked at commit, so a switch may clear the old engagement before setting the new one.

Revision ID: 0003
Revises: 0002
"""

import sqlalchemy as sa
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "routine",
        sa.Column("id", sa.Integer(), sa.Identity(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("engaged", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.CheckConstraint("name <> ''", name="routine_name_not_empty"),
    )
    op.create_index("routine_name_key", "routine", [sa.text("lower(name)")], unique=True)
    op.create_index("routine_one_engaged", "routine", ["engaged"], unique=True, postgresql_where=sa.text("engaged"))
    op.execute(
        """
        create function routine_check_engaged() returns trigger language plpgsql as $$
        begin
            if exists (select from routine) and not exists (select from routine where engaged) then
                raise exception 'Once any Routine exists, exactly one is engaged'
                    using errcode = 'check_violation', constraint = 'routine_one_engaged';
            end if;
            return null;
        end
        $$
        """
    )
    op.execute(
        """
        create constraint trigger routine_engaged_exists
            after insert or update of engaged or delete on routine
            deferrable initially deferred
            for each row execute function routine_check_engaged()
        """
    )


def downgrade() -> None:
    op.drop_table("routine")
    op.execute("drop function routine_check_engaged()")
