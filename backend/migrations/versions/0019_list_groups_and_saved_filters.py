"""list groups and saved filters"""

import sqlalchemy as sa
from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "task_list_groups",
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "name"),
    )
    op.create_index(
        "ix_task_list_groups_workspace_id",
        "task_list_groups",
        ["workspace_id"],
        unique=False,
    )
    op.execute(
        "ALTER TABLE task_lists ADD COLUMN group_id VARCHAR(36) REFERENCES task_list_groups(id)"
    )
    op.create_index("ix_task_lists_group_id", "task_lists", ["group_id"], unique=False)

    op.create_table(
        "saved_filters",
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "name"),
    )
    op.create_index(
        "ix_saved_filters_workspace_id",
        "saved_filters",
        ["workspace_id"],
        unique=False,
    )


def downgrade() -> None:
    raise RuntimeError("清单文件夹和保存筛选属于用户数据，请恢复迁移前的一致性备份")
