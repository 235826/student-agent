"""task tags"""

import sqlalchemy as sa
from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "tags",
        sa.Column("name", sa.String(length=50), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "name"),
    )
    op.create_index("ix_tags_workspace_id", "tags", ["workspace_id"], unique=False)

    op.create_table(
        "task_tags",
        sa.Column("task_id", sa.String(length=36), nullable=False),
        sa.Column("tag_id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["task_id"], ["tasks.id"]),
        sa.ForeignKeyConstraint(["tag_id"], ["tags.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("task_id", "tag_id"),
    )
    op.create_index("ix_task_tags_task_id", "task_tags", ["task_id"], unique=False)
    op.create_index("ix_task_tags_tag_id", "task_tags", ["tag_id"], unique=False)
    op.create_index("ix_task_tags_workspace_id", "task_tags", ["workspace_id"], unique=False)


def downgrade() -> None:
    raise RuntimeError("任务标签属于用户数据，请恢复迁移前的一致性备份")
