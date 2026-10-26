from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.entities import DocumentStatus, MeetingStatus, TaskPriority, TaskStatus


class ORMModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class UserCreate(BaseModel):
    email: str
    display_name: str = Field(min_length=1, max_length=120)
    preferred_language: str = "en"
    timezone: str = "UTC"


class UserRead(ORMModel):
    id: UUID
    email: str
    display_name: str
    preferred_language: str
    timezone: str
    is_active: bool
    created_at: datetime
    updated_at: datetime


class MeetingCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    scheduled_at: datetime | None = None
    privacy_mode: str = "private"


class MeetingRead(ORMModel):
    id: UUID
    created_by: UUID = Field(validation_alias="created_by_id", serialization_alias="created_by")
    title: str
    description: str | None
    start_time: datetime | None
    end_time: datetime | None
    language: str
    meeting_type: str
    status: MeetingStatus
    scheduled_at: datetime | None
    started_at: datetime | None
    ended_at: datetime | None
    privacy_mode: str
    created_at: datetime
    updated_at: datetime


class TranscriptCreate(BaseModel):
    content: str = Field(min_length=1)
    language: str = "en"
    sequence_number: int = Field(ge=0)
    speaker_id: UUID | None = None
    started_at: datetime | None = None
    ended_at: datetime | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)


class NoteCreate(BaseModel):
    title: str | None = None
    content: str = ""
    canvas_data: dict | None = None


class DocumentRead(ORMModel):
    id: UUID
    meeting_id: UUID
    uploaded_by_id: UUID
    filename: str
    content_type: str
    storage_key: str
    status: DocumentStatus
    extracted_text: str | None
    page_count: int | None
    created_at: datetime
    updated_at: datetime


class TaskCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    assignee_id: UUID | None = None
    priority: TaskPriority = TaskPriority.medium
    due_at: datetime | None = None
    source_transcript_id: UUID | None = None


class TaskRead(ORMModel):
    id: UUID
    meeting_id: UUID
    assignee_id: UUID | None
    title: str
    description: str | None
    status: TaskStatus
    priority: TaskPriority
    due_at: datetime | None
    source_transcript_id: UUID | None
    created_at: datetime
    updated_at: datetime


class SummaryRead(ORMModel):
    id: UUID
    meeting_id: UUID
    content: str
    language: str
    key_points: list | None
    decisions: list | None
    action_items: list | None
    generated_at: datetime


class QuestionCreate(BaseModel):
    question: str = Field(min_length=1)
    asked_by_id: UUID | None = None


class TranslationRead(ORMModel):
    id: UUID
    transcript_id: UUID
    target_language: str
    translated_text: str
    provider: str | None
    created_at: datetime
