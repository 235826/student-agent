"""remember the task list selected when an agent request is sent"""

import sqlalchemy as sa
from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("agent_runs", sa.Column("task_list_id", sa.String(36), nullable=True))


def downgrade() -> None:
    op.drop_column("agent_runs", "task_list_id")
