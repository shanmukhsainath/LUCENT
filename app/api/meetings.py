from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import exists, or_, select
from sqlalchemy.orm import Session, selectinload

from app.api.dependencies import get_current_user
from app.database.session import get_db
from app.models import Meeting, MeetingStatus, Participant, ParticipantRole, User
from app.schemas.meetings import (
    JoinMeetingRequest,
    MeetingCreateRequest,
    MeetingResponse,
    MeetingUpdateRequest,
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
    ).options(selectinload(Meeting.participants).selectinload(Participant.user))


def get_authorized_meeting(meeting_id: UUID, user: User, db: Session) -> Meeting:
    meeting = db.scalar(authorized_meeting_query(user.id).where(Meeting.id == meeting_id))
    if meeting is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Meeting not found")
    return meeting


def serialize_meeting(meeting: Meeting) -> MeetingResponse:
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
    db.add(meeting)
    db.commit()
    db.refresh(meeting)
    meeting = db.scalar(authorized_meeting_query(current_user.id).where(Meeting.id == meeting.id))
    return serialize_meeting(meeting)


@router.get("", response_model=list[MeetingResponse])
def list_meetings(current_user: CurrentUser, db: DbSession) -> list[MeetingResponse]:
    meetings = db.scalars(authorized_meeting_query(current_user.id).order_by(Meeting.created_at.desc())).unique().all()
    return [serialize_meeting(meeting) for meeting in meetings]


@router.get("/{meeting_id}", response_model=MeetingResponse)
def get_meeting(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> MeetingResponse:
    return serialize_meeting(get_authorized_meeting(meeting_id, current_user, db))


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
def end_meeting(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> MeetingResponse:
    meeting = get_host_meeting(meeting_id, current_user, db)
    now = datetime.now(timezone.utc)
    meeting.status = MeetingStatus.completed
    meeting.ended_at = now
    db.commit()
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
def remove_participant(
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
