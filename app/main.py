from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.api.auth import router as auth_router
from app.api.meetings import router as meetings_router
from app.api.notes import router as notes_router
from app.api.questions import router as questions_router
from app.api.summaries import router as summaries_router
from app.api.tasks import router as tasks_router
from app.api.websocket import websocket_router
from app.database.config import settings
from app.database.session import engine

app = FastAPI(title="MeetMind AI API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)
app.include_router(auth_router)
app.include_router(meetings_router)
app.include_router(notes_router)
app.include_router(questions_router)
app.include_router(summaries_router)
app.include_router(tasks_router)
app.include_router(websocket_router)

FRONTEND_ROOT = Path(__file__).resolve().parents[1]


class PublicStaticFiles(StaticFiles):
    """Serve the browser app without exposing backend or deployment files."""

    async def get_response(self, path: str, scope: dict):
        request_path = scope.get("path", f"/{path}")
        first_segment = request_path.lstrip("/").split("/", 1)[0]
        if (
            first_segment.startswith(".")
            or first_segment in {"app", "alembic", "docs", ".venv"}
            or path in {".env", ".env.example", "requirements.txt", "alembic.ini"}
        ):
            from starlette.responses import Response

            return Response(status_code=404)
        return await super().get_response(path, scope)


@app.get("/health", tags=["system"])
def health_check() -> dict[str, str]:
    """Report API and database status so a failed signup is easy to diagnose."""
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        return {"status": "ok", "database": "connected"}
    except SQLAlchemyError:
        return {"status": "degraded", "database": "unreachable"}


@app.get("/", include_in_schema=False)
def frontend_root() -> FileResponse:
    return FileResponse(FRONTEND_ROOT / "index.html")


app.mount("/", PublicStaticFiles(directory=FRONTEND_ROOT, html=True), name="frontend")
