from datetime import datetime
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Meeting, Summary, Transcript
from app.schemas.summaries import MeetingSummaryResult
from app.services.llm_service import LLMService, LLMServiceError


class MeetingSummaryError(RuntimeError):
    """Raised when a meeting summary cannot be generated or validated."""


SUMMARY_SYSTEM_PROMPT = """You summarize only the supplied meeting transcript. Never invent names, facts, decisions, questions, deadlines, topics, or timestamps. If a section is not supported by the transcript, return an empty array or an empty string. Preserve transcript timestamps in important_moments, action_items.source_timestamp, and deadlines.source_timestamp when available. Return one JSON object with exactly these keys: summary, topics, key_points, decisions, questions, action_items, deadlines, important_moments. action_items must contain text, optional owner, optional deadline, and optional source_timestamp. deadlines must contain text, optional due_at, and optional source_timestamp. important_moments must contain text and optional timestamp."""


def transcript_for_prompt(transcripts: list[Transcript]) -> str:
    lines: list[str] = []
    for transcript in transcripts:
        timestamp = transcript.started_at or transcript.ended_at or transcript.created_at
        timestamp_text = timestamp.isoformat() if timestamp else "timestamp unavailable"
        lines.append(f"[{timestamp_text}] {transcript.content}")
    return "\n".join(lines)


class MeetingSummaryService:
    def __init__(self, llm_service: LLMService) -> None:
        self.llm_service = llm_service

    async def generate(self, meeting: Meeting, db: Session) -> tuple[Summary, MeetingSummaryResult]:
        transcripts = db.scalars(
            select(Transcript)
            .where(Transcript.meeting_id == meeting.id)
            .order_by(Transcript.sequence_number.asc())
        ).all()
        if not transcripts:
            raise MeetingSummaryError("A summary requires at least one transcript segment.")

        try:
            raw_result = await self.llm_service.generate_structured(
                system_prompt=SUMMARY_SYSTEM_PROMPT,
                user_prompt=(
                    f"Meeting title: {meeting.title}\n"
                    f"Meeting language: {meeting.language}\n"
                    "Transcript:\n"
                    f"{transcript_for_prompt(transcripts)}"
                ),
            )
            result = MeetingSummaryResult.model_validate(raw_result)
        except LLMServiceError:
            raise
        except ValidationError as error:
            raise MeetingSummaryError("The LLM response did not match the summary schema.") from error

        summary = db.scalar(select(Summary).where(Summary.meeting_id == meeting.id))
        if summary is None:
            summary = Summary(meeting_id=meeting.id)
            db.add(summary)
        summary.content = result.summary
        summary.language = meeting.language
        summary.topics = result.topics
        summary.key_points = result.key_points
        summary.decisions = result.decisions
        summary.action_items = [item.model_dump() for item in result.action_items]
        summary.questions = result.questions
        summary.deadlines = [deadline.model_dump() for deadline in result.deadlines]
        summary.important_moments = [moment.model_dump() for moment in result.important_moments]
        db.commit()
        db.refresh(summary)
        return summary, result
