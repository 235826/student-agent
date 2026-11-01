"""task completion timestamp and all-day deadlines"""

import sqlalchemy as sa
from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("completed_at", sa.BigInteger(), nullable=True))
    op.add_column(
        "tasks",
        sa.Column(
            "deadline_all_day",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.create_index("ix_tasks_completed_at", "tasks", ["completed_at"], unique=False)
    op.execute(
        "UPDATE tasks SET completed_at = updated_at WHERE status = 'done' AND completed_at IS NULL"
    )


def downgrade() -> None:
    raise RuntimeError("任务完成时间属于用户数据，请恢复迁移前的一致性备份")
