import base64
import hashlib
import hmac
import time
from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import exists, or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.dependencies import get_current_user
from app.database.session import get_db
from app.database.config import settings
from app.models import Meeting, MeetingSettings, MeetingStatus, Participant, ParticipantRole, User
from app.realtime.manager import manager
from app.schemas.meetings import (
    JoinMeetingRequest,
    MeetingCreateRequest,
    MeetingResponse,
    MeetingUpdateRequest,
    MeetingSettingsResponse,
    MeetingSettingsUpdateRequest,
    ParticipantRoleUpdateRequest,
    ParticipantResponse,
)

router = APIRouter(prefix="/api/meetings", tags=["meetings"])
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def authorized_meeting_query(user_id: UUID):
    participant_access = exists(
        select(Participant.id).where(
            Participant.meeting_id == Meeting.id,
            Participant.user_id == user_id,
            Participant.left_at.is_(None),
        )
    )
    return select(Meeting).where(
        or_(Meeting.created_by_id == user_id, participant_access)
    ).options(
        selectinload(Meeting.participants).selectinload(Participant.user),
        selectinload(Meeting.settings),
    )


def get_authorized_meeting(meeting_id: UUID, user: User, db: Session) -> Meeting:
    meeting = db.scalar(authorized_meeting_query(user.id).where(Meeting.id == meeting_id))
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")
    return meeting


def get_or_create_settings(meeting: Meeting, db: Session) -> MeetingSettings:
    if meeting.settings is None:
        meeting.settings = MeetingSettings()
        db.add(meeting.settings)
        db.flush()
    return meeting.settings


def settings_response(settings: MeetingSettings) -> MeetingSettingsResponse:
    return MeetingSettingsResponse(
        camera_required=bool(settings.camera_required),
        microphone_required=bool(settings.microphone_required),
        allow_camera_toggle=True if settings.allow_camera_toggle is None else settings.allow_camera_toggle,
        allow_microphone_toggle=(
            True if settings.allow_microphone_toggle is None else settings.allow_microphone_toggle
        ),
    )


def serialize_meeting(meeting: Meeting) -> MeetingResponse:
    settings = meeting.settings or MeetingSettings(
        camera_required=False,
        microphone_required=False,
        allow_camera_toggle=True,
        allow_microphone_toggle=True,
    )
    participants = [
        ParticipantResponse(
            user_id=participant.user_id,
            role=participant.role,
            joined_at=participant.joined_at,
            left_at=participant.left_at,
            name=participant.user.name if participant.user else None,
        )
        for participant in meeting.participants
    ]
    return MeetingResponse(
        id=meeting.id,
        created_by_id=meeting.created_by_id,
        title=meeting.title,
        description=meeting.description,
        start_time=meeting.start_time,
        end_time=meeting.end_time,
        language=meeting.language,
        meeting_type=meeting.meeting_type,
        privacy_mode=meeting.privacy_mode,
        status=meeting.status,
        created_at=meeting.created_at,
        participants=participants,
        settings=settings_response(settings),
    )


@router.post("", response_model=MeetingResponse, status_code=status.HTTP_201_CREATED)
def create_meeting(payload: MeetingCreateRequest, current_user: CurrentUser, db: DbSession) -> MeetingResponse:
    if payload.start_time and payload.end_time and payload.end_time <= payload.start_time:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="End time must be after start time")
    meeting = Meeting(
        created_by_id=current_user.id,
        title=payload.title.strip(),
        description=payload.description,
        start_time=payload.start_time,
        end_time=payload.end_time,
        scheduled_at=payload.start_time,
        language=payload.language.lower(),
        meeting_type=payload.meeting_type.lower(),
        privacy_mode=payload.privacy_mode.lower(),
    )
    meeting.participants.append(
        Participant(user_id=current_user.id, role=ParticipantRole.host, joined_at=datetime.now(timezone.utc))
    )
    meeting.settings = MeetingSettings()
    db.add(meeting)
    db.commit()
    db.refresh(meeting)
    meeting = db.scalar(authorized_meeting_query(current_user.id).where(Meeting.id == meeting.id))
    return serialize_meeting(meeting)


@router.get("", response_model=list[MeetingResponse])
def list_meetings(current_user: CurrentUser, db: DbSession) -> list[MeetingResponse]:
    meetings = db.scalars(authorized_meeting_query(current_user.id).order_by(Meeting.created_at.desc())).unique().all()
    return [serialize_meeting(meeting) for meeting in meetings]


@router.get("/{meeting_id}/settings", response_model=MeetingSettingsResponse)
def get_meeting_settings(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> MeetingSettingsResponse:
    meeting = get_authorized_meeting(meeting_id, current_user, db)
    settings = get_or_create_settings(meeting, db)
    db.commit()
    return settings_response(settings)


@router.get("/{meeting_id}/ice-servers")
def get_ice_servers(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> dict:
    get_authorized_meeting(meeting_id, current_user, db)
    servers: list[dict] = []
    if settings.stun_urls:
        servers.append({"urls": settings.stun_urls})
    turn_configured = bool(settings.turn_urls)
    if turn_configured:
        turn_server: dict[str, object] = {"urls": settings.turn_urls}
        if settings.turn_shared_secret:
            expiry = int(time.time()) + 3600
            username = f"{expiry}:{current_user.id}"
            digest = hmac.new(
                settings.turn_shared_secret.encode("utf-8"),
                username.encode("utf-8"),
                hashlib.sha1,
            ).digest()
            turn_server.update(
                {
                    "username": username,
                    "credential": base64.b64encode(digest).decode("ascii"),
                    "credentialType": "password",
                }
            )
        elif settings.turn_username and settings.turn_credential:
            turn_server.update(
                {
                    "username": settings.turn_username,
                    "credential": settings.turn_credential,
                    "credentialType": "password",
                }
            )
        servers.append(turn_server)
    return {"ice_servers": servers, "turn_configured": turn_configured, "ttl": 3600}


@router.patch("/{meeting_id}/settings", response_model=MeetingSettingsResponse)
async def update_meeting_settings(
    meeting_id: UUID,
    payload: MeetingSettingsUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> MeetingSettingsResponse:
    meeting = get_host_meeting(meeting_id, current_user, db)
    settings = get_or_create_settings(meeting, db)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(settings, field, value)
    db.commit()
    settings = get_or_create_settings(meeting, db)
    response = settings_response(settings)
    await manager.broadcast(
        meeting_id,
        {"type": "MEETING_SETTINGS_UPDATED", "payload": response.model_dump()},
    )
    for user_id in manager.connected_users(meeting_id):
        if user_id == meeting.created_by_id:
            continue
        state = manager.get_user_media_state(meeting_id, user_id)
        if state and (
            (settings.camera_required and not state.video_enabled)
            or (settings.microphone_required and not state.audio_enabled)
        ):
            await manager.send_to_user(
                meeting_id,
                user_id,
                {"type": "MEDIA_REQUIREMENT_CHANGED", "payload": response.model_dump()},
            )
    return response


@router.get("/{meeting_id}", response_model=MeetingResponse)
def get_meeting(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> MeetingResponse:
    meeting = get_authorized_meeting(meeting_id, current_user, db)
    get_or_create_settings(meeting, db)
    db.commit()
    return serialize_meeting(meeting)


def get_host_meeting(meeting_id: UUID, user: User, db: Session) -> Meeting:
    meeting = db.scalar(select(Meeting).where(Meeting.id == meeting_id))
    if meeting is None or meeting.created_by_id != user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the meeting host can perform this action")
    return meeting


@router.patch("/{meeting_id}", response_model=MeetingResponse)
def update_meeting(
    meeting_id: UUID,
    payload: MeetingUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> MeetingResponse:
    meeting = get_host_meeting(meeting_id, current_user, db)
    changes = payload.model_dump(exclude_unset=True)
    if "title" in changes:
        meeting.title = changes["title"].strip()
    if "description" in changes:
        meeting.description = changes["description"]
    if "privacy_mode" in changes:
        meeting.privacy_mode = changes["privacy_mode"].lower()
    if payload.start_time is not None and payload.end_time is not None and payload.end_time <= payload.start_time:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="End time must be after start time")
    if "start_time" in changes:
        meeting.start_time = changes["start_time"]
        meeting.scheduled_at = changes["start_time"]
    if "end_time" in changes:
        meeting.end_time = changes["end_time"]
    db.commit()
    return serialize_meeting(get_authorized_meeting(meeting_id, current_user, db))


@router.post("/{meeting_id}/start", response_model=MeetingResponse)
def start_meeting(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> MeetingResponse:
    meeting = get_host_meeting(meeting_id, current_user, db)
    now = datetime.now(timezone.utc)
    meeting.status = MeetingStatus.live
    meeting.started_at = meeting.started_at or now
    db.commit()
    return serialize_meeting(get_authorized_meeting(meeting_id, current_user, db))


@router.post("/{meeting_id}/end", response_model=MeetingResponse)
async def end_meeting(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> MeetingResponse:
    meeting = get_host_meeting(meeting_id, current_user, db)
    now = datetime.now(timezone.utc)
    meeting.status = MeetingStatus.completed
    meeting.ended_at = now
    db.commit()
    await manager.broadcast(meeting_id, {"type": "MEETING_ENDED", "payload": {"reason": "The meeting has ended."}})
    await manager.close_meeting(meeting_id, 4000, "Meeting ended")
    return serialize_meeting(get_authorized_meeting(meeting_id, current_user, db))


@router.post("/{meeting_id}/join", response_model=MeetingResponse)
def join_meeting(
    meeting_id: UUID,
    payload: JoinMeetingRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> MeetingResponse:
    meeting = db.scalar(select(Meeting).where(Meeting.id == meeting_id).options(selectinload(Meeting.participants)))
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")
    participant = db.scalar(
        select(Participant).where(Participant.meeting_id == meeting_id, Participant.user_id == current_user.id)
    )
    now = datetime.now(timezone.utc)
    if participant is None:
        meeting.participants.append(Participant(user_id=current_user.id, role=ParticipantRole.participant, joined_at=now))
    else:
        if participant.role == ParticipantRole.host:
            participant.role = ParticipantRole.host
        elif participant.role not in {ParticipantRole.viewer, ParticipantRole.participant}:
            participant.role = ParticipantRole.participant
        participant.joined_at = participant.joined_at or now
        participant.left_at = None
    db.commit()
    return serialize_meeting(get_authorized_meeting(meeting_id, current_user, db))


@router.patch("/{meeting_id}/participants/{user_id}", response_model=MeetingResponse)
def update_participant_role(
    meeting_id: UUID,
    user_id: UUID,
    payload: ParticipantRoleUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> MeetingResponse:
    meeting = get_host_meeting(meeting_id, current_user, db)
    if user_id == current_user.id or payload.role == ParticipantRole.host:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="The host role cannot be reassigned")
    participant = db.scalar(
        select(Participant).where(Participant.meeting_id == meeting.id, Participant.user_id == user_id)
    )
    if participant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Participant not found")
    participant.role = payload.role
    participant.left_at = None
    db.commit()
    return serialize_meeting(get_authorized_meeting(meeting_id, current_user, db))


@router.delete("/{meeting_id}/participants/{user_id}", response_model=MeetingResponse)
async def remove_participant(
    meeting_id: UUID,
    user_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> MeetingResponse:
    meeting = get_host_meeting(meeting_id, current_user, db)
    if user_id == current_user.id:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="The host cannot remove themselves")
    participant = db.scalar(
        select(Participant).where(
            Participant.meeting_id == meeting.id,
            Participant.user_id == user_id,
            Participant.left_at.is_(None),
        )
    )
    if participant is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Active participant not found")
    participant.left_at = datetime.now(timezone.utc)
    db.commit()
    removed_user = db.get(User, user_id)
    if removed_user:
        await manager.broadcast(
            meeting_id,
            {"type": "PARTICIPANT_LEFT", "payload": {**{"user_id": str(user_id), "name": removed_user.name}}},
        )
    await manager.close_user(meeting_id, user_id, 4403, "Meeting access revoked")
    return serialize_meeting(get_authorized_meeting(meeting_id, current_user, db))


@router.post("/{meeting_id}/leave", response_model=MeetingResponse)
def leave_meeting(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> MeetingResponse:
    meeting = get_authorized_meeting(meeting_id, current_user, db)
    participant = db.scalar(
        select(Participant).where(Participant.meeting_id == meeting_id, Participant.user_id == current_user.id)
    )
    if participant is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You are not a participant in this meeting")
    participant.left_at = datetime.now(timezone.utc)
    db.commit()
    return serialize_meeting(meeting)
