"""task lists"""

import sqlalchemy as sa
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "task_lists",
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("color", sa.String(length=7), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "name"),
    )
    op.create_index("ix_task_lists_workspace_id", "task_lists", ["workspace_id"], unique=False)

    op.execute("ALTER TABLE tasks ADD COLUMN list_id VARCHAR(36) REFERENCES task_lists(id)")
    op.create_index("ix_tasks_list_id", "tasks", ["list_id"], unique=False)


def downgrade() -> None:
    raise RuntimeError("任务清单属于用户数据，请恢复迁移前的一致性备份")
