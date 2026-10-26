from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class NoteCreateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    content: str = ""


class NoteUpdateRequest(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    content: str = ""


class NoteResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    meeting_id: UUID
    author_id: UUID
    title: str | None
    content: str
    created_at: datetime
    updated_at: datetime
