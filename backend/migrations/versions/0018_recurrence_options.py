"""recurrence options"""

import sqlalchemy as sa
from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tasks",
        sa.Column(
            "recurrence_interval",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("1"),
        ),
    )
    op.add_column(
        "tasks",
        sa.Column(
            "recurrence_from_completion",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )
    op.add_column(
        "tasks",
        sa.Column("recurrence_until", sa.BigInteger(), nullable=True),
    )
    op.add_column(
        "tasks",
        sa.Column("recurrence_remaining", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    raise RuntimeError("重复规则属于用户数据，请恢复迁移前的一致性备份")
