from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.api.meetings import get_authorized_meeting
from app.database.session import get_db
from app.models import Note, Participant, ParticipantRole, User
from app.schemas.notes import NoteCreateRequest, NoteResponse, NoteUpdateRequest

router = APIRouter(tags=["notes"])
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def require_note_access(meeting_id: UUID, current_user: User, db: Session) -> None:
    get_authorized_meeting(meeting_id, current_user, db)
    participant = db.scalar(
        select(Participant).where(
            Participant.meeting_id == meeting_id,
            Participant.user_id == current_user.id,
            Participant.left_at.is_(None),
        )
    )
    if participant is None or participant.role != ParticipantRole.participant:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Personal notes are available only to meeting participants.",
        )


@router.post("/api/meetings/{meeting_id}/notes", response_model=NoteResponse, status_code=status.HTTP_201_CREATED)
def create_note(
    meeting_id: UUID,
    payload: NoteCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> NoteResponse:
    require_note_access(meeting_id, current_user, db)
    note = Note(
        meeting_id=meeting_id,
        author_id=current_user.id,
        title=payload.title.strip() if payload.title else None,
        content=payload.content,
    )
    db.add(note)
    db.commit()
    db.refresh(note)
    return NoteResponse.model_validate(note)


@router.get("/api/meetings/{meeting_id}/notes", response_model=list[NoteResponse])
def list_notes(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> list[NoteResponse]:
    require_note_access(meeting_id, current_user, db)
    notes = db.scalars(
        select(Note)
        .where(Note.meeting_id == meeting_id, Note.author_id == current_user.id)
        .order_by(Note.updated_at.desc())
    ).all()
    return [NoteResponse.model_validate(note) for note in notes]


@router.put("/api/notes/{note_id}", response_model=NoteResponse)
def update_note(
    note_id: UUID,
    payload: NoteUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> NoteResponse:
    note = db.scalar(select(Note).where(Note.id == note_id, Note.author_id == current_user.id))
    if note is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    require_note_access(note.meeting_id, current_user, db)
    note.title = payload.title.strip() if payload.title else None
    note.content = payload.content
    db.commit()
    db.refresh(note)
    return NoteResponse.model_validate(note)


@router.delete("/api/notes/{note_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_note(note_id: UUID, current_user: CurrentUser, db: DbSession) -> None:
    note = db.scalar(select(Note).where(Note.id == note_id, Note.author_id == current_user.id))
    if note is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Note not found")
    require_note_access(note.meeting_id, current_user, db)
    db.delete(note)
    db.commit()
