from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class ActionItem(BaseModel):
    text: str = Field(min_length=1)
    owner: str | None = None
    deadline: str | None = None
    source_timestamp: str | None = None


class Deadline(BaseModel):
    text: str = Field(min_length=1)
    due_at: str | None = None
    source_timestamp: str | None = None


class ImportantMoment(BaseModel):
    text: str = Field(min_length=1)
    timestamp: str | None = None


class MeetingSummaryResult(BaseModel):
    summary: str = ""
    topics: list[str] = Field(default_factory=list)
    key_points: list[str] = Field(default_factory=list)
    decisions: list[str] = Field(default_factory=list)
    questions: list[str] = Field(default_factory=list)
    action_items: list[ActionItem] = Field(default_factory=list)
    deadlines: list[Deadline] = Field(default_factory=list)
    important_moments: list[ImportantMoment] = Field(default_factory=list)


class SummaryResponse(MeetingSummaryResult):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    meeting_id: UUID
    language: str
    generated_at: datetime
