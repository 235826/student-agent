"""task recurrence"""

import sqlalchemy as sa
from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column("recurrence", sa.String(length=20), nullable=True),
    )
    op.execute("ALTER TABLE tasks ADD COLUMN recurrence_parent_id VARCHAR(36) REFERENCES tasks(id)")
    op.create_index(
        "ix_tasks_recurrence_parent_id",
        "tasks",
        ["recurrence_parent_id"],
        unique=False,
    )


def downgrade() -> None:
    raise RuntimeError("任务重复规则属于用户数据，请恢复迁移前的一致性备份")
