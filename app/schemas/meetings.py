from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.entities import MeetingStatus, ParticipantRole


class MeetingCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=5000)
    start_time: datetime | None = None
    end_time: datetime | None = None
    language: str = Field(default="en", min_length=2, max_length=10)
    meeting_type: str = Field(default="online", min_length=2, max_length=32)
    privacy_mode: str = Field(default="private", min_length=2, max_length=32)


class MeetingUpdateRequest(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=5000)
    start_time: datetime | None = None
    end_time: datetime | None = None
    privacy_mode: str | None = Field(default=None, min_length=2, max_length=32)


class ParticipantRoleUpdateRequest(BaseModel):
    role: ParticipantRole


class JoinMeetingRequest(BaseModel):
    role: ParticipantRole = ParticipantRole.participant


class ParticipantResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    user_id: UUID
    role: ParticipantRole
    joined_at: datetime | None
    left_at: datetime | None
    name: str | None = None


class MeetingSettingsResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    camera_required: bool
    microphone_required: bool
    allow_camera_toggle: bool
    allow_microphone_toggle: bool


class MeetingSettingsUpdateRequest(BaseModel):
    camera_required: bool | None = None
    microphone_required: bool | None = None
    allow_camera_toggle: bool | None = None
    allow_microphone_toggle: bool | None = None


class ChatMessageResponse(BaseModel):
    id: UUID
    meeting_id: UUID
    sender_id: UUID
    sender_name: str
    content: str
    created_at: datetime


class TranscriptResponse(BaseModel):
    id: UUID
    sequence_number: int
    speaker_id: UUID | None
    speaker_name: str | None
    text: str
    language: str
    started_at: datetime | None
    ended_at: datetime | None
    timestamp: datetime
    confidence: float | None


class MeetingResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_by: UUID = Field(validation_alias="created_by_id", serialization_alias="created_by")
    host_user_id: UUID
    title: str
    description: str | None
    start_time: datetime | None
    end_time: datetime | None
    language: str
    meeting_type: str
    privacy_mode: str
    status: MeetingStatus
    created_at: datetime
    participants: list[ParticipantResponse] = Field(default_factory=list)
    settings: MeetingSettingsResponse
