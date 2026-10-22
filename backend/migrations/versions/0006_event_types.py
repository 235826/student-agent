"""event types"""

import time
import uuid

import sqlalchemy as sa
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

SYSTEM_TYPES = (
    ("exam", "考试", "#cf1322"),
    ("meeting", "会议", "#d46b08"),
    ("other", "其他", "#8c8c8c"),
)


def upgrade() -> None:
    op.create_table(
        "event_types",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("workspace_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("color", sa.String(length=7), nullable=False),
        sa.Column("system_key", sa.String(length=20), nullable=True),
        sa.Column("archived_at", sa.BigInteger(), nullable=True),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspaces.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("workspace_id", "name"),
        sa.UniqueConstraint("workspace_id", "system_key"),
    )
    op.create_index("ix_event_types_workspace_id", "event_types", ["workspace_id"])
    op.create_index("ix_event_types_archived_at", "event_types", ["archived_at"])

    with op.batch_alter_table("events", schema=None) as batch_op:
        batch_op.add_column(sa.Column("event_type_id", sa.String(length=36), nullable=True))
        batch_op.create_foreign_key(
            "fk_events_event_type_id", "event_types", ["event_type_id"], ["id"]
        )
        batch_op.create_index("ix_events_event_type_id", ["event_type_id"])

    connection = op.get_bind()
    now = int(time.time() * 1000)
    for (workspace_id,) in connection.execute(sa.text("SELECT id FROM workspaces")):
        ids: dict[str, str] = {}
        for key, name, color in SYSTEM_TYPES:
            type_id = str(uuid.uuid4())
            ids[key] = type_id
            connection.execute(
                sa.text(
                    "INSERT INTO event_types "
                    "(id, workspace_id, created_at, updated_at, name, color, "
                    "system_key, archived_at) "
                    "VALUES (:id, :workspace_id, :now, :now, :name, :color, :key, NULL)"
                ),
                {
                    "id": type_id,
                    "workspace_id": workspace_id,
                    "now": now,
                    "name": name,
                    "color": color,
                    "key": key,
                },
            )
        for key in ("meeting", "exam"):
            connection.execute(
                sa.text(
                    "UPDATE events SET event_type_id = :type_id "
                    "WHERE workspace_id = :workspace_id AND series_id IS NULL AND kind = :key"
                ),
                {
                    "type_id": ids[key],
                    "workspace_id": workspace_id,
                    "key": key,
                },
            )
        connection.execute(
            sa.text(
                "UPDATE events SET event_type_id = :type_id "
                "WHERE workspace_id = :workspace_id AND series_id IS NULL "
                "AND kind = 'other' AND event_type_id IS NULL"
            ),
            {"type_id": ids["other"], "workspace_id": workspace_id},
        )
        connection.execute(
            sa.text(
                "UPDATE events SET kind = 'other' "
                "WHERE workspace_id = :workspace_id AND kind IN ('meeting', 'exam')"
            ),
            {"workspace_id": workspace_id},
        )


def downgrade() -> None:
    raise RuntimeError("事件类型属于用户数据，请恢复迁移前的一致性备份")
