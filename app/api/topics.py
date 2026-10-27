from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.api.meetings import get_authorized_meeting, get_host_meeting
from app.database.session import get_db
from app.models import MeetingTopic, Participant, ParticipantRole, User
from app.realtime.manager import manager
from app.schemas.topics import TopicCreateRequest, TopicResponse, TopicUpdateRequest

router = APIRouter(prefix="/api/meetings/{meeting_id}/topics", tags=["topics"])
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("", response_model=list[TopicResponse])
def list_topics(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> list[TopicResponse]:
    get_authorized_meeting(meeting_id, current_user, db)
    is_host = db.scalar(
        select(Participant.id).where(
            Participant.meeting_id == meeting_id,
            Participant.user_id == current_user.id,
            Participant.role == ParticipantRole.host,
            Participant.left_at.is_(None),
        )
    ) is not None

    query = select(MeetingTopic).where(MeetingTopic.meeting_id == meeting_id)
    if not is_host:
        query = query.where(MeetingTopic.is_published.is_(True))
    topics = db.scalars(query.order_by(MeetingTopic.created_at.asc())).all()
    return [TopicResponse.model_validate(topic) for topic in topics]


@router.post("", response_model=TopicResponse, status_code=status.HTTP_201_CREATED)
async def create_topic(
    meeting_id: UUID,
    payload: TopicCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> TopicResponse:
    get_host_meeting(meeting_id, current_user, db)
    now = datetime.now(timezone.utc)
    topic = MeetingTopic(
        meeting_id=meeting_id,
        created_by_id=current_user.id,
        title=payload.title.strip(),
        description=payload.description.strip() if payload.description else None,
        is_important=payload.is_important,
        is_published=payload.is_published,
        published_at=now if payload.is_published else None,
    )
    db.add(topic)
    db.commit()
    db.refresh(topic)
    await manager.broadcast(meeting_id, {"type": "TOPIC_UPDATED", "payload": {"topic_id": str(topic.id)}})
    return TopicResponse.model_validate(topic)


@router.patch("/{topic_id}", response_model=TopicResponse)
async def update_topic(
    meeting_id: UUID,
    topic_id: UUID,
    payload: TopicUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> TopicResponse:
    get_host_meeting(meeting_id, current_user, db)
    topic = db.scalar(
        select(MeetingTopic).where(
            MeetingTopic.id == topic_id,
            MeetingTopic.meeting_id == meeting_id,
        )
    )
    if topic is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Topic not found")

    changes = payload.model_dump(exclude_unset=True)
    for field in ("title", "description", "is_important"):
        if field in changes:
            value = changes[field]
            setattr(topic, field, value.strip() if field == "title" and value else value)
    if "is_published" in changes:
        topic.is_published = changes["is_published"]
        topic.published_at = datetime.now(timezone.utc) if topic.is_published else None
    db.commit()
    db.refresh(topic)
    await manager.broadcast(meeting_id, {"type": "TOPIC_UPDATED", "payload": {"topic_id": str(topic.id)}})
    return TopicResponse.model_validate(topic)


@router.delete("/{topic_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_topic(
    meeting_id: UUID,
    topic_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> None:
    get_host_meeting(meeting_id, current_user, db)
    topic = db.scalar(
        select(MeetingTopic).where(
            MeetingTopic.id == topic_id,
            MeetingTopic.meeting_id == meeting_id,
        )
    )
    if topic is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Topic not found")
    db.delete(topic)
    db.commit()
    await manager.broadcast(meeting_id, {"type": "TOPIC_UPDATED", "payload": {"topic_id": str(topic_id)}})
