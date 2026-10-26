"""Create the initial MeetMind database schema.

Revision ID: 0001_initial_schema
Revises:
Create Date: 2026-10-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial_schema"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    meeting_status = postgresql.ENUM("scheduled", "live", "completed", "cancelled", name="meeting_status")
    participant_role = postgresql.ENUM("host", "participant", "guest", name="participant_role")
    task_status = postgresql.ENUM("open", "in_progress", "completed", "cancelled", name="task_status")
    task_priority = postgresql.ENUM("low", "medium", "high", "urgent", name="task_priority")
    document_status = postgresql.ENUM("uploaded", "processing", "ready", "failed", name="document_status")

    uuid_type = postgresql.UUID(as_uuid=True)
    timestamp = sa.DateTime(timezone=True)

    def timestamps() -> tuple[sa.Column, sa.Column]:
        return (
            sa.Column("created_at", timestamp, server_default=sa.text("now()"), nullable=False),
            sa.Column("updated_at", timestamp, server_default=sa.text("now()"), nullable=False),
        )

    op.create_table(
        "users",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=False),
        sa.Column("preferred_language", sa.String(length=10), server_default="en", nullable=False),
        sa.Column("timezone", sa.String(length=64), server_default="UTC", nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.true(), nullable=False),
        *timestamps(),
        sa.PrimaryKeyConstraint("id", name="pk_users"),
        sa.UniqueConstraint("email", name="uq_users_email"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=False)

    op.create_table(
        "meetings",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("created_by_id", uuid_type, nullable=False),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("status", meeting_status, server_default="scheduled", nullable=False),
        sa.Column("scheduled_at", timestamp),
        sa.Column("started_at", timestamp),
        sa.Column("ended_at", timestamp),
        sa.Column("privacy_mode", sa.String(length=32), server_default="private", nullable=False),
        *timestamps(),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], name="fk_meetings_created_by_id_users", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name="pk_meetings"),
    )

    op.create_table(
        "participants",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("meeting_id", uuid_type, nullable=False),
        sa.Column("user_id", uuid_type, nullable=False),
        sa.Column("role", participant_role, server_default="participant", nullable=False),
        sa.Column("joined_at", timestamp),
        sa.Column("left_at", timestamp),
        *timestamps(),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], name="fk_participants_meeting_id_meetings", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], name="fk_participants_user_id_users", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_participants"),
        sa.UniqueConstraint("meeting_id", "user_id", name="uq_participants_meeting_user"),
    )

    op.create_table(
        "transcripts",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("meeting_id", uuid_type, nullable=False),
        sa.Column("speaker_id", uuid_type),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("language", sa.String(length=10), server_default="en", nullable=False),
        sa.Column("sequence_number", sa.Integer(), nullable=False),
        sa.Column("started_at", timestamp),
        sa.Column("ended_at", timestamp),
        sa.Column("confidence", sa.Float()),
        *timestamps(),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], name="fk_transcripts_meeting_id_meetings", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["speaker_id"], ["users.id"], name="fk_transcripts_speaker_id_users", ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name="pk_transcripts"),
    )
    op.create_index("ix_transcripts_meeting_id", "transcripts", ["meeting_id"], unique=False)

    op.create_table(
        "notes",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("meeting_id", uuid_type, nullable=False),
        sa.Column("author_id", uuid_type, nullable=False),
        sa.Column("title", sa.String(length=255)),
        sa.Column("content", sa.Text(), server_default="", nullable=False),
        sa.Column("canvas_data", postgresql.JSONB()),
        *timestamps(),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], name="fk_notes_author_id_users", ondelete="RESTRICT"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], name="fk_notes_meeting_id_meetings", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_notes"),
    )
    op.create_index("ix_notes_meeting_id", "notes", ["meeting_id"], unique=False)

    op.create_table(
        "documents",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("meeting_id", uuid_type, nullable=False),
        sa.Column("uploaded_by_id", uuid_type, nullable=False),
        sa.Column("filename", sa.String(length=255), nullable=False),
        sa.Column("content_type", sa.String(length=100), nullable=False),
        sa.Column("storage_key", sa.String(length=512), nullable=False),
        sa.Column("status", document_status, server_default="uploaded", nullable=False),
        sa.Column("extracted_text", sa.Text()),
        sa.Column("page_count", sa.Integer()),
        *timestamps(),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], name="fk_documents_meeting_id_meetings", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["uploaded_by_id"], ["users.id"], name="fk_documents_uploaded_by_id_users", ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name="pk_documents"),
    )
    op.create_index("ix_documents_meeting_id", "documents", ["meeting_id"], unique=False)

    op.create_table(
        "tasks",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("meeting_id", uuid_type, nullable=False),
        sa.Column("assignee_id", uuid_type),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("status", task_status, server_default="open", nullable=False),
        sa.Column("priority", task_priority, server_default="medium", nullable=False),
        sa.Column("due_at", timestamp),
        sa.Column("source_transcript_id", uuid_type),
        *timestamps(),
        sa.ForeignKeyConstraint(["assignee_id"], ["users.id"], name="fk_tasks_assignee_id_users", ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], name="fk_tasks_meeting_id_meetings", ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_transcript_id"], ["transcripts.id"], name="fk_tasks_source_transcript_id_transcripts", ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id", name="pk_tasks"),
    )
    op.create_index("ix_tasks_meeting_id", "tasks", ["meeting_id"], unique=False)

    op.create_table(
        "summaries",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("meeting_id", uuid_type, nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("language", sa.String(length=10), server_default="en", nullable=False),
        sa.Column("key_points", postgresql.JSONB()),
        sa.Column("decisions", postgresql.JSONB()),
        sa.Column("action_items", postgresql.JSONB()),
        sa.Column("generated_at", timestamp, server_default=sa.text("now()"), nullable=False),
        *timestamps(),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], name="fk_summaries_meeting_id_meetings", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_summaries"),
        sa.UniqueConstraint("meeting_id", name="uq_summaries_meeting_id"),
    )

    op.create_table(
        "questions",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("meeting_id", uuid_type, nullable=False),
        sa.Column("asked_by_id", uuid_type),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("answer", sa.Text()),
        sa.Column("answer_source", sa.String(length=32)),
        sa.Column("answered_at", timestamp),
        *timestamps(),
        sa.ForeignKeyConstraint(["asked_by_id"], ["users.id"], name="fk_questions_asked_by_id_users", ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], name="fk_questions_meeting_id_meetings", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_questions"),
    )
    op.create_index("ix_questions_meeting_id", "questions", ["meeting_id"], unique=False)

    op.create_table(
        "translations",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column("transcript_id", uuid_type, nullable=False),
        sa.Column("target_language", sa.String(length=10), nullable=False),
        sa.Column("translated_text", sa.Text(), nullable=False),
        sa.Column("provider", sa.String(length=64)),
        *timestamps(),
        sa.ForeignKeyConstraint(["transcript_id"], ["transcripts.id"], name="fk_translations_transcript_id_transcripts", ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_translations"),
        sa.UniqueConstraint("transcript_id", "target_language", name="uq_translations_transcript_language"),
    )


def downgrade() -> None:
    for table_name in (
        "translations",
        "questions",
        "summaries",
        "tasks",
        "documents",
        "notes",
        "transcripts",
        "participants",
        "meetings",
        "users",
    ):
        op.drop_table(table_name)
    for enum_name in ("document_status", "task_priority", "task_status", "participant_role", "meeting_status"):
        postgresql.ENUM(name=enum_name).drop(op.get_bind(), checkfirst=True)
