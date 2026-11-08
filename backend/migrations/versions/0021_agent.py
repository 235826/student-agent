"""global agent conversations, runs and actions"""

import sqlalchemy as sa
from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_conversations",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("title", sa.String(length=120), nullable=False),
        sa.Column("consent_at", sa.BigInteger(), nullable=True),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_agent_conversations_user_id", "agent_conversations", ["user_id"], unique=False
    )
    op.create_index(
        "ix_agent_conversations_workspace_id",
        "agent_conversations",
        ["workspace_id"],
        unique=False,
    )

    op.create_table(
        "agent_runs",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("conversation_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("next_run_at", sa.BigInteger(), nullable=False),
        sa.Column("lease_until", sa.BigInteger(), nullable=False),
        sa.Column("lease_token", sa.String(length=36), nullable=False),
        sa.Column("error", sa.String(length=2000), nullable=False),
        sa.Column("transcript", sa.JSON(), nullable=False),
        sa.Column("step_count", sa.Integer(), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["conversation_id"], ["agent_conversations.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_agent_runs_user_id", "agent_runs", ["user_id"], unique=False)
    op.create_index(
        "ix_agent_runs_conversation_id", "agent_runs", ["conversation_id"], unique=False
    )
    op.create_index("ix_agent_runs_workspace_id", "agent_runs", ["workspace_id"], unique=False)
    op.create_index("ix_agent_runs_status", "agent_runs", ["status"], unique=False)

    op.create_table(
        "agent_actions",
        sa.Column("run_id", sa.String(length=36), nullable=False),
        sa.Column("conversation_id", sa.String(length=36), nullable=False),
        sa.Column("action_key", sa.String(length=64), nullable=False),
        sa.Column("operation", sa.String(length=80), nullable=False),
        sa.Column("payload", sa.JSON(), nullable=False),
        sa.Column("summary", sa.String(length=1000), nullable=False),
        sa.Column("risk", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=20), nullable=False),
        sa.Column("depends_on", sa.JSON(), nullable=False),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("error", sa.String(length=2000), nullable=False),
        sa.Column("expires_at", sa.BigInteger(), nullable=False),
        sa.Column("executed_at", sa.BigInteger(), nullable=True),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["agent_runs.id"]),
        sa.ForeignKeyConstraint(["conversation_id"], ["agent_conversations.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id", "action_key"),
    )
    op.create_index("ix_agent_actions_run_id", "agent_actions", ["run_id"], unique=False)
    op.create_index(
        "ix_agent_actions_conversation_id",
        "agent_actions",
        ["conversation_id"],
        unique=False,
    )
    op.create_index(
        "ix_agent_actions_workspace_id", "agent_actions", ["workspace_id"], unique=False
    )
    op.create_index("ix_agent_actions_status", "agent_actions", ["status"], unique=False)

    op.create_table(
        "agent_messages",
        sa.Column("conversation_id", sa.String(length=36), nullable=False),
        sa.Column("run_id", sa.String(length=36), nullable=True),
        sa.Column("role", sa.String(length=20), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["agent_conversations.id"]),
        sa.ForeignKeyConstraint(["run_id"], ["agent_runs.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_agent_messages_conversation_id",
        "agent_messages",
        ["conversation_id"],
        unique=False,
    )
    op.create_index("ix_agent_messages_run_id", "agent_messages", ["run_id"], unique=False)
    op.create_index(
        "ix_agent_messages_workspace_id", "agent_messages", ["workspace_id"], unique=False
    )


def downgrade() -> None:
    raise RuntimeError("Agent 会话属于用户数据，请恢复迁移前的一致性备份")
