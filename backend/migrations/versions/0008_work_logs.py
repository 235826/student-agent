"""work logs"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "work_logs",
        sa.Column("task_id", sa.String(length=36), nullable=False),
        sa.Column("actual_minutes", sa.Integer(), nullable=False),
        sa.Column("cause", sa.String(length=40), nullable=False),
        sa.Column("note", sa.String(length=2000), nullable=False),
        sa.Column("reflection", sa.String(length=5000), nullable=False),
        sa.Column("started_at", sa.BigInteger(), nullable=True),
        sa.Column("ended_at", sa.BigInteger(), nullable=True),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_work_logs_task_id", "work_logs", ["task_id"])
    op.create_index("ix_work_logs_workspace_id", "work_logs", ["workspace_id"])


def downgrade() -> None:
    raise RuntimeError("工作日志属于用户数据，请恢复迁移前的一致性备份")
