"""task reminders"""

import sqlalchemy as sa
from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("remind_at", sa.BigInteger(), nullable=True))
    op.create_index("ix_tasks_remind_at", "tasks", ["remind_at"], unique=False)


def downgrade() -> None:
    raise RuntimeError("提醒时间属于用户数据，请恢复迁移前的一致性备份")
