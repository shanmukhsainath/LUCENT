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
