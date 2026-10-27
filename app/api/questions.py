from datetime import datetime, timedelta, timezone
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.api.meetings import get_authorized_meeting, get_host_meeting
from app.database.session import get_db
from app.models import (
    MeetingQuestion,
    MeetingQuestionAnswer,
    Participant,
    ParticipantRole,
    Question,
    User,
)
from app.realtime.manager import manager
from app.schemas.questions import (
    ParticipantQuestionAnswerResponse,
    QuestionAnswerRequest,
    QuestionCreateRequest,
    QuestionResponse,
    ScheduledQuestionAnswerRequest,
    ScheduledQuestionCreateRequest,
    ScheduledQuestionReorderRequest,
    ScheduledQuestionResponse,
    ScheduledQuestionUpdateRequest,
)

router = APIRouter(prefix="/api/meetings/{meeting_id}/questions", tags=["questions"])
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def meeting_role(meeting_id: UUID, user_id: UUID, db: Session) -> ParticipantRole | None:
    return db.scalar(
        select(Participant.role).where(
            Participant.meeting_id == meeting_id,
            Participant.user_id == user_id,
            Participant.left_at.is_(None),
        )
    )


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def _schedule_responses(
    meeting_id: UUID,
    current_user: User,
    db: Session,
    *,
    host: bool,
) -> list[ScheduledQuestionResponse]:
    meeting = get_authorized_meeting(meeting_id, current_user, db)
    role = meeting_role(meeting_id, current_user.id, db)
    if role is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="An active meeting role is required")
    now = datetime.now(timezone.utc)
    query = select(MeetingQuestion).where(MeetingQuestion.meeting_id == meeting_id)
    if host:
        query = query.options(selectinload(MeetingQuestion.answers).selectinload(MeetingQuestionAnswer.participant))
    questions = db.scalars(query.order_by(MeetingQuestion.position.asc(), MeetingQuestion.created_at.asc())).all()
    answers_by_question: dict[UUID, list[MeetingQuestionAnswer]] = {}
    if not host and questions:
        for answer in db.scalars(
            select(MeetingQuestionAnswer).where(
                MeetingQuestionAnswer.question_id.in_([question.id for question in questions]),
                MeetingQuestionAnswer.participant_id == current_user.id,
            )
        ).all():
            answers_by_question.setdefault(answer.question_id, []).append(answer)

    states: list[tuple[MeetingQuestion, datetime | None, datetime | None, str]] = []
    for question in questions:
        starts_at = None
        if question.manually_activated_at is not None:
            starts_at = _utc(question.manually_activated_at)
        elif question.scheduled_offset_seconds is not None and meeting.started_at is not None:
            starts_at = _utc(meeting.started_at) + timedelta(seconds=question.scheduled_offset_seconds)
        expires_at = (
            starts_at + timedelta(seconds=question.answer_duration_seconds)
            if starts_at is not None and question.answer_duration_seconds is not None
            else None
        )
        if not question.is_enabled:
            state = "disabled"
        elif starts_at is None or now < starts_at:
            state = "upcoming"
        elif expires_at is not None and now >= expires_at:
            state = "closed"
        else:
            state = "active"
        states.append((question, starts_at, expires_at, state))

    active = [state for state in states if state[3] == "active"]
    current_active = max(active, key=lambda state: (state[1] or now, state[0].position), default=None)
    response: list[ScheduledQuestionResponse] = []
    for question, starts_at, expires_at, state in states:
        if state == "active" and current_active is not None and question.id != current_active[0].id:
            state = "closed"
        question_answers = question.answers if host else answers_by_question.get(question.id, [])
        my_answer = question_answers[0].answer if question_answers else None
        if not host and state not in {"active"} and not (
            state == "upcoming" and question.show_before_active
        ) and not (state == "closed" and my_answer is not None):
            continue
        answers = (
            [
                ParticipantQuestionAnswerResponse(
                    participant_id=answer.participant_id,
                    display_name=answer.participant.display_name,
                    answer=answer.answer,
                    answered_at=answer.answered_at,
                )
                for answer in question_answers
            ]
            if host
            else []
        )
        response.append(
            ScheduledQuestionResponse(
                id=question.id,
                question=question.question,
                position=question.position,
                scheduled_offset_seconds=question.scheduled_offset_seconds,
                answer_duration_seconds=question.answer_duration_seconds,
                show_before_active=question.show_before_active,
                is_enabled=question.is_enabled,
                status=state,
                active_at=starts_at,
                expires_at=expires_at,
                my_answer=my_answer,
                answers=answers,
            )
        )
    return response


async def _broadcast_schedule(meeting_id: UUID) -> None:
    await manager.broadcast(meeting_id, {"type": "SCHEDULED_QUESTIONS_UPDATED", "payload": {}})


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


@router.get("/scheduled", response_model=list[ScheduledQuestionResponse])
def list_scheduled_questions(
    meeting_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> list[ScheduledQuestionResponse]:
    get_authorized_meeting(meeting_id, current_user, db)
    return _schedule_responses(
        meeting_id,
        current_user,
        db,
        host=meeting_role(meeting_id, current_user.id, db) == ParticipantRole.host,
    )


@router.post(
    "/scheduled",
    response_model=ScheduledQuestionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_scheduled_question(
    meeting_id: UUID,
    payload: ScheduledQuestionCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> ScheduledQuestionResponse:
    get_host_meeting(meeting_id, current_user, db)
    position = db.scalar(
        select(func.coalesce(func.max(MeetingQuestion.position), -1)).where(
            MeetingQuestion.meeting_id == meeting_id
        )
    ) + 1
    question = MeetingQuestion(
        meeting_id=meeting_id,
        created_by_id=current_user.id,
        question=payload.question.strip(),
        position=position,
        scheduled_offset_seconds=payload.scheduled_offset_seconds,
        answer_duration_seconds=payload.answer_duration_seconds,
        show_before_active=payload.show_before_active,
    )
    db.add(question)
    db.commit()
    await _broadcast_schedule(meeting_id)
    return next(
        item
        for item in _schedule_responses(meeting_id, current_user, db, host=True)
        if item.id == question.id
    )


@router.patch("/scheduled/reorder", status_code=status.HTTP_204_NO_CONTENT)
async def reorder_scheduled_questions(
    meeting_id: UUID,
    payload: ScheduledQuestionReorderRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> None:
    get_host_meeting(meeting_id, current_user, db)
    questions = db.scalars(
        select(MeetingQuestion)
        .where(MeetingQuestion.meeting_id == meeting_id)
        .order_by(MeetingQuestion.position.asc())
        .with_for_update()
    ).all()
    if len(payload.question_ids) != len(questions) or set(payload.question_ids) != {question.id for question in questions}:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Provide every scheduled question exactly once.",
        )
    by_id = {question.id: question for question in questions}
    for position, question_id in enumerate(payload.question_ids):
        by_id[question_id].position = position
    db.commit()
    await _broadcast_schedule(meeting_id)


@router.patch("/scheduled/{question_id}", response_model=ScheduledQuestionResponse)
async def update_scheduled_question(
    meeting_id: UUID,
    question_id: UUID,
    payload: ScheduledQuestionUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> ScheduledQuestionResponse:
    get_host_meeting(meeting_id, current_user, db)
    question = db.scalar(
        select(MeetingQuestion)
        .where(MeetingQuestion.id == question_id, MeetingQuestion.meeting_id == meeting_id)
        .with_for_update()
    )
    if question is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Scheduled question not found")
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(question, field, value.strip() if field == "question" and value else value)
    db.commit()
    await _broadcast_schedule(meeting_id)
    return next(
        item
        for item in _schedule_responses(meeting_id, current_user, db, host=True)
        if item.id == question.id
    )


@router.delete("/scheduled/{question_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_scheduled_question(
    meeting_id: UUID,
    question_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> None:
    get_host_meeting(meeting_id, current_user, db)
    question = db.scalar(
        select(MeetingQuestion).where(
            MeetingQuestion.id == question_id,
            MeetingQuestion.meeting_id == meeting_id,
        )
    )
    if question is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Scheduled question not found")
    db.delete(question)
    db.commit()
    await _broadcast_schedule(meeting_id)


@router.post("/scheduled/{question_id}/activate", response_model=ScheduledQuestionResponse)
async def activate_scheduled_question(
    meeting_id: UUID,
    question_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> ScheduledQuestionResponse:
    get_host_meeting(meeting_id, current_user, db)
    question = db.scalar(
        select(MeetingQuestion)
        .where(MeetingQuestion.id == question_id, MeetingQuestion.meeting_id == meeting_id)
        .with_for_update()
    )
    if question is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Scheduled question not found")
    if not question.is_enabled:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Enable this question before activating it")
    question.manually_activated_at = datetime.now(timezone.utc)
    db.commit()
    await _broadcast_schedule(meeting_id)
    return next(
        item
        for item in _schedule_responses(meeting_id, current_user, db, host=True)
        if item.id == question.id
    )


@router.post("/scheduled/{question_id}/answer", response_model=ScheduledQuestionResponse)
async def answer_scheduled_question(
    meeting_id: UUID,
    question_id: UUID,
    payload: ScheduledQuestionAnswerRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> ScheduledQuestionResponse:
    get_authorized_meeting(meeting_id, current_user, db)
    role = meeting_role(meeting_id, current_user.id, db)
    if role != ParticipantRole.participant:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only active participants can answer questions")
    question = db.scalar(
        select(MeetingQuestion)
        .where(MeetingQuestion.id == question_id, MeetingQuestion.meeting_id == meeting_id)
        .with_for_update()
    )
    if question is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Scheduled question not found")
    schedule = _schedule_responses(meeting_id, current_user, db, host=False)
    active_question = next((item for item in schedule if item.status == "active"), None)
    if active_question is None or active_question.id != question.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This question is not currently accepting answers")
    answer = db.scalar(
        select(MeetingQuestionAnswer).where(
            MeetingQuestionAnswer.question_id == question_id,
            MeetingQuestionAnswer.participant_id == current_user.id,
        )
    )
    now = datetime.now(timezone.utc)
    if answer is None:
        answer = MeetingQuestionAnswer(
            question_id=question_id,
            participant_id=current_user.id,
            answer=payload.answer.strip(),
            answered_at=now,
        )
        db.add(answer)
    else:
        answer.answer = payload.answer.strip()
        answer.answered_at = now
    db.commit()
    await _broadcast_schedule(meeting_id)
    return next(
        item
        for item in _schedule_responses(meeting_id, current_user, db, host=False)
        if item.id == question.id
    )


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
