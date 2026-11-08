"""agent chat images"""

import sqlalchemy as sa
from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "agent_images",
        sa.Column("conversation_id", sa.String(length=36), nullable=False),
        sa.Column("message_id", sa.String(length=36), nullable=True),
        sa.Column("media_type", sa.String(length=200), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(["conversation_id"], ["agent_conversations.id"]),
        sa.ForeignKeyConstraint(["message_id"], ["agent_messages.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_agent_images_conversation_id", "agent_images", ["conversation_id"], unique=False
    )
    op.create_index("ix_agent_images_message_id", "agent_images", ["message_id"], unique=False)
    op.create_index("ix_agent_images_workspace_id", "agent_images", ["workspace_id"], unique=False)


def downgrade() -> None:
    raise RuntimeError("Agent 图片属于用户数据，请恢复迁移前的一致性备份")
