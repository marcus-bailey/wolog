from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine

import wolog.exercises  # noqa: F401  (registers the tables on Base.metadata for autogenerate)
import wolog.routines  # noqa: F401
from wolog.db import Base, database_url

config = context.config
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name)

# Tests pass the URL in config.attributes; otherwise DATABASE_URL.
url: str = config.attributes.get("url") or database_url()

with create_engine(url).connect() as connection:
    context.configure(connection=connection, target_metadata=Base.metadata)
    with context.begin_transaction():
        context.run_migrations()
    connection.commit()
