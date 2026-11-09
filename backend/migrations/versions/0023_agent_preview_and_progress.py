"""agent action preview and run progress"""

import sqlalchemy as sa
from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "agent_actions",
        sa.Column("preview", sa.JSON(), nullable=False, server_default=sa.text("'{}'")),
    )
    op.add_column(
        "agent_runs",
        sa.Column("surface", sa.String(length=20), nullable=False, server_default="agent"),
    )
    op.add_column(
        "agent_runs",
        sa.Column("phase", sa.String(length=200), nullable=False, server_default=""),
    )
    op.add_column(
        "agent_runs",
        sa.Column("partial_content", sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column("agent_runs", "partial_content")
    op.drop_column("agent_runs", "phase")
    op.drop_column("agent_runs", "surface")
    op.drop_column("agent_actions", "preview")
