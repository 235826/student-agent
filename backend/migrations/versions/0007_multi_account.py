"""allow multiple accounts"""

from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Sessions are disposable login state; clearing them lets SQLite recreate users safely.
    op.execute("DELETE FROM sessions")
    with op.batch_alter_table("users", schema=None) as batch_op:
        batch_op.drop_column("singleton")


def downgrade() -> None:
    raise RuntimeError("多账号属于用户数据，请恢复迁移前的一致性备份")
