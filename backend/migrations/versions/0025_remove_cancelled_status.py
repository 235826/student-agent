"""remove cancelled task status and move those tasks to trash"""

from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op


def now_ms() -> int:
    return int(datetime.now(UTC).timestamp() * 1000)


revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None


def tasks_table() -> sa.Table:
    return sa.Table(
        "tasks",
        sa.MetaData(),
        sa.Column("id", sa.String(length=36), primary_key=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column(
            "workspace_id",
            sa.String(length=36),
            sa.ForeignKey("workspaces.id"),
            nullable=False,
        ),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("description", sa.String(), nullable=False),
        sa.Column(
            "links",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'[]'"),
        ),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("priority", sa.Integer(), nullable=False),
        sa.Column(
            "flagged",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "sort_order",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column(
            "list_id",
            sa.String(length=36),
            sa.ForeignKey("task_lists.id"),
            nullable=True,
        ),
        sa.Column("deadline_at", sa.BigInteger(), nullable=True),
        sa.Column(
            "deadline_all_day",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("remind_at", sa.BigInteger(), nullable=True),
        sa.Column("estimate_minutes", sa.Integer(), nullable=True),
        sa.Column("task_type", sa.String(), nullable=True),
        sa.Column("recurrence", sa.String(length=20), nullable=True),
        sa.Column(
            "recurrence_interval",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column(
            "recurrence_from_completion",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("recurrence_until", sa.BigInteger(), nullable=True),
        sa.Column("recurrence_remaining", sa.Integer(), nullable=True),
        sa.Column(
            "recurrence_parent_id",
            sa.String(length=36),
            sa.ForeignKey("tasks.id"),
            nullable=True,
        ),
        sa.Column(
            "subtask_order",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.Column("completed_at", sa.BigInteger(), nullable=True),
        sa.Column("archived_at", sa.BigInteger(), nullable=True),
        sa.Column("trashed_at", sa.BigInteger(), nullable=True),
        sa.Column(
            "parent_id",
            sa.String(length=36),
            sa.ForeignKey("tasks.id"),
            nullable=True,
        ),
        sa.Column("parallel_policy", sa.String(), nullable=True),
        sa.Column(
            "policy_revision",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
        sa.CheckConstraint("status IN ('todo','in_progress','done')"),
        sa.CheckConstraint("priority BETWEEN 1 AND 4"),
        sa.CheckConstraint("estimate_minutes IS NULL OR estimate_minutes > 0"),
        sa.Index("ix_tasks_workspace_id", "workspace_id"),
        sa.Index("ix_tasks_status", "status"),
        sa.Index("ix_tasks_trashed_at", "trashed_at"),
        sa.Index("ix_tasks_deadline_at", "deadline_at"),
        sa.Index("ix_tasks_completed_at", "completed_at"),
        sa.Index("ix_tasks_list_id", "list_id"),
        sa.Index("ix_tasks_parent_id", "parent_id"),
        sa.Index("ix_tasks_recurrence_parent_id", "recurrence_parent_id"),
        sa.Index("ix_tasks_remind_at", "remind_at"),
        sa.Index("ix_tasks_archived_at", "archived_at"),
    )


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE tasks SET trashed_at = COALESCE(trashed_at, :now), status = 'todo' "
            "WHERE status = 'cancelled'"
        ).bindparams(now=now_ms())
    )
    op.execute(
        sa.text(
            "UPDATE saved_filters SET payload = json_set(payload, '$.status', NULL) "
            "WHERE json_extract(payload, '$.status') = 'cancelled'"
        )
    )
    with op.batch_alter_table("tasks", copy_from=tasks_table(), recreate="always"):
        pass


def downgrade() -> None:
    raise RuntimeError("移除已取消状态属于用户数据变更，请恢复迁移前的一致性备份")
