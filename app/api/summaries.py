from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.api.meetings import get_authorized_meeting
from app.database.session import get_db
from app.models import Summary, User
from app.schemas.summaries import MeetingSummaryResult, SummaryResponse
from app.services.llm_service import LLMServiceError, get_llm_service
from app.services.meeting_summary_service import MeetingSummaryError, MeetingSummaryService

router = APIRouter(tags=["summaries"])
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def response_from_summary(summary: Summary) -> SummaryResponse:
    result = MeetingSummaryResult(
        summary=summary.content,
        topics=summary.topics or [],
        key_points=summary.key_points or [],
        decisions=summary.decisions or [],
        questions=summary.questions or [],
        action_items=summary.action_items or [],
        deadlines=summary.deadlines or [],
        important_moments=summary.important_moments or [],
    )
    return SummaryResponse(
        **result.model_dump(),
        id=summary.id,
        meeting_id=summary.meeting_id,
        language=summary.language,
        generated_at=summary.generated_at,
    )


@router.post("/api/meetings/{meeting_id}/summarize", response_model=SummaryResponse)
async def summarize_meeting(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> SummaryResponse:
    meeting = get_authorized_meeting(meeting_id, current_user, db)
    try:
        summary, result = await MeetingSummaryService(get_llm_service()).generate(meeting, db)
    except MeetingSummaryError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error
    except LLMServiceError as error:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(error)) from error
    return SummaryResponse(
        **result.model_dump(),
        id=summary.id,
        meeting_id=summary.meeting_id,
        language=summary.language,
        generated_at=summary.generated_at,
    )


@router.get("/api/meetings/{meeting_id}/summary", response_model=SummaryResponse)
def get_summary(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> SummaryResponse:
    get_authorized_meeting(meeting_id, current_user, db)
    summary = db.scalar(select(Summary).where(Summary.meeting_id == meeting_id))
    if summary is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Summary not found")
    return response_from_summary(summary)
