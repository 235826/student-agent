"""work contexts, activity feedback, archives and account deletion"""

import sqlalchemy as sa
from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("deletion_requested_at", sa.BigInteger(), nullable=True))
    op.add_column("users", sa.Column("deletion_due_at", sa.BigInteger(), nullable=True))
    op.add_column("tasks", sa.Column("archived_at", sa.BigInteger(), nullable=True))
    op.create_index("ix_tasks_archived_at", "tasks", ["archived_at"])

    op.create_table(
        "work_log_contexts",
        sa.Column("work_log_id", sa.String(length=36), nullable=False),
        sa.Column("object_kind", sa.String(length=10), nullable=False),
        sa.Column("object_id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.CheckConstraint("object_kind IN ('event','task')"),
        sa.ForeignKeyConstraint(["work_log_id"], ["work_logs.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("work_log_id", "object_kind", "object_id"),
    )
    op.create_index("ix_work_log_contexts_work_log_id", "work_log_contexts", ["work_log_id"])
    op.create_index("ix_work_log_contexts_object_id", "work_log_contexts", ["object_id"])
    op.create_index("ix_work_log_contexts_workspace_id", "work_log_contexts", ["workspace_id"])

    op.create_table(
        "activity_feedback",
        sa.Column("event_id", sa.String(length=36), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("tags", sa.JSON(), nullable=False),
        sa.Column("reflection", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.CheckConstraint("rating BETWEEN 1 AND 5"),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "event_id"),
    )
    op.create_index("ix_activity_feedback_event_id", "activity_feedback", ["event_id"])
    op.create_index("ix_activity_feedback_workspace_id", "activity_feedback", ["workspace_id"])

    op.create_table(
        "deleted_workspace_audits",
        sa.Column("deleted_at", sa.BigInteger(), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
        sa.Column("actions", sa.JSON(), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_deleted_workspace_audits_expires_at", "deleted_workspace_audits", ["expires_at"]
    )


def downgrade() -> None:
    raise RuntimeError("用户执行记录与注销状态属于用户数据，请恢复迁移前的一致性备份")
