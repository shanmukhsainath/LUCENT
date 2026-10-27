from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class TopicCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=5000)
    is_important: bool = False
    is_published: bool = False


class TopicUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=5000)
    is_important: bool | None = None
    is_published: bool | None = None


class TopicResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    meeting_id: UUID
    created_by_id: UUID
    title: str
    description: str | None
    is_important: bool
    is_published: bool
    published_at: datetime | None
    created_at: datetime
    updated_at: datetime
