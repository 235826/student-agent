"""event notes and details"""

import sqlalchemy as sa
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("event_series", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("location", sa.String(length=500), server_default="", nullable=False)
        )
        batch_op.add_column(
            sa.Column("note", sa.String(length=120), server_default="", nullable=False)
        )
        batch_op.add_column(
            sa.Column("details", sa.String(length=5000), server_default="", nullable=False)
        )

    with op.batch_alter_table("events", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column("note", sa.String(length=120), server_default="", nullable=False)
        )
        batch_op.add_column(
            sa.Column("details", sa.String(length=5000), server_default="", nullable=False)
        )

    with op.batch_alter_table("event_overrides", schema=None) as batch_op:
        batch_op.add_column(sa.Column("note", sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column("details", sa.String(length=5000), nullable=True))

    op.execute(
        """
        UPDATE event_series
        SET location = COALESCE(
            (
                SELECT events.location
                FROM events
                WHERE events.series_id = event_series.id
                ORDER BY events.start_at
                LIMIT 1
            ),
            ''
        )
        """
    )


def downgrade() -> None:
    raise RuntimeError("事件备注和详情属于用户数据，请恢复迁移前的一致性备份")
