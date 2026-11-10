from alembic import context

from app.config import Settings
from app.db.models import Base
from app.db.session import build_engine

config = context.config
url = config.attributes.get("database_url", Settings().database_url)
if context.is_offline_mode():
    context.configure(url=url, target_metadata=Base.metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    engine = build_engine(url)
    with engine.connect() as connection:
        # SQLite cannot drop a referenced table while foreign keys are enforced.
        # Migrations run with enforcement off; application connections still enable it.
        if connection.dialect.name == "sqlite":
            connection.connection.driver_connection.execute("PRAGMA foreign_keys=OFF")
        context.configure(
            connection=connection,
            target_metadata=Base.metadata,
            render_as_batch=True,
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()
        if connection.dialect.name == "sqlite":
            connection.connection.driver_connection.execute("PRAGMA foreign_keys=ON")
    engine.dispose()
