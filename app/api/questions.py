from datetime import datetime, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.api.meetings import get_authorized_meeting
from app.database.session import get_db
from app.models import Question, User
from app.schemas.questions import QuestionAnswerRequest, QuestionCreateRequest, QuestionResponse

router = APIRouter(prefix="/api/meetings/{meeting_id}/questions", tags=["questions"])
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


@router.get("", response_model=list[QuestionResponse])
def list_questions(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> list[QuestionResponse]:
    get_authorized_meeting(meeting_id, current_user, db)
    questions = db.scalars(
        select(Question).where(Question.meeting_id == meeting_id).order_by(Question.created_at.asc())
    ).all()
    return [QuestionResponse.model_validate(question) for question in questions]


@router.post("", response_model=QuestionResponse, status_code=status.HTTP_201_CREATED)
def create_question(
    meeting_id: UUID,
    payload: QuestionCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> QuestionResponse:
    get_authorized_meeting(meeting_id, current_user, db)
    question = Question(meeting_id=meeting_id, asked_by_id=current_user.id, question=payload.question.strip())
    db.add(question)
    db.commit()
    db.refresh(question)
    return QuestionResponse.model_validate(question)


@router.patch("/{question_id}/answer", response_model=QuestionResponse)
def answer_question(
    meeting_id: UUID,
    question_id: UUID,
    payload: QuestionAnswerRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> QuestionResponse:
    get_authorized_meeting(meeting_id, current_user, db)
    question = db.scalar(select(Question).where(Question.id == question_id, Question.meeting_id == meeting_id))
    if question is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Question not found")
    question.answer = payload.answer.strip()
    question.answer_source = payload.answer_source.strip().lower()
    question.answered_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(question)
    return QuestionResponse.model_validate(question)
