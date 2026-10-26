from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.database.config import settings


engine = create_engine(
    settings.database_url,
    echo=settings.echo_sql,
    pool_pre_ping=settings.pool_pre_ping,
    # Fail fast when the database is unreachable instead of hanging the request,
    # so the frontend can show a real error rather than spinning indefinitely.
    connect_args={"connect_timeout": 10},
)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, expire_on_commit=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
