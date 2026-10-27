from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class QuestionCreateRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)


class QuestionAnswerRequest(BaseModel):
    answer: str = Field(min_length=1, max_length=5000)
    answer_source: str = Field(default="manual", min_length=1, max_length=32)


class QuestionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    meeting_id: UUID
    asked_by_id: UUID | None
    question: str
    answer: str | None
    answer_source: str | None
    answered_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ScheduledQuestionCreateRequest(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    scheduled_offset_seconds: int | None = Field(default=None, ge=0, le=86_400)
    answer_duration_seconds: int | None = Field(default=120, ge=10, le=3600)
    show_before_active: bool = False


class ScheduledQuestionUpdateRequest(BaseModel):
    question: str | None = Field(default=None, min_length=1, max_length=2000)
    scheduled_offset_seconds: int | None = Field(default=None, ge=0, le=86_400)
    answer_duration_seconds: int | None = Field(default=None, ge=10, le=3600)
    show_before_active: bool | None = None
    is_enabled: bool | None = None


class ScheduledQuestionReorderRequest(BaseModel):
    question_ids: list[UUID] = Field(min_length=1)


class ScheduledQuestionAnswerRequest(BaseModel):
    answer: str = Field(min_length=1, max_length=5000)


class ParticipantQuestionAnswerResponse(BaseModel):
    participant_id: UUID
    display_name: str
    answer: str
    answered_at: datetime


class ScheduledQuestionResponse(BaseModel):
    id: UUID
    question: str
    position: int
    scheduled_offset_seconds: int | None
    answer_duration_seconds: int | None
    show_before_active: bool
    is_enabled: bool
    status: str
    active_at: datetime | None
    expires_at: datetime | None
    my_answer: str | None
    answers: list[ParticipantQuestionAnswerResponse] = Field(default_factory=list)
