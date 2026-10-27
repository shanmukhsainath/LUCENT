"""Add host-managed scheduled questions and private participant answers.

Revision ID: 0008_scheduled_questions
Revises: 0007_meeting_topics
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0008_scheduled_questions"
down_revision: Union[str, None] = "0007_meeting_topics"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "meeting_questions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("meeting_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("created_by_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("question", sa.Text(), nullable=False),
        sa.Column("position", sa.Integer(), server_default="0", nullable=False),
        sa.Column("scheduled_offset_seconds", sa.Integer(), nullable=True),
        sa.Column("answer_duration_seconds", sa.Integer(), nullable=True),
        sa.Column("show_before_active", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("is_enabled", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("manually_activated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by_id"], ["users.id"], ondelete="RESTRICT"),
        sa.PrimaryKeyConstraint("id", name="pk_meeting_questions"),
    )
    op.create_index("ix_meeting_questions_meeting_id", "meeting_questions", ["meeting_id"])
    op.create_table(
        "meeting_question_answers",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("question_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("participant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("answered_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["question_id"], ["meeting_questions.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["participant_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_meeting_question_answers"),
        sa.UniqueConstraint(
            "question_id",
            "participant_id",
            name="uq_meeting_question_answers_question_participant",
        ),
    )
    op.create_index("ix_meeting_question_answers_question_id", "meeting_question_answers", ["question_id"])
    op.create_index("ix_meeting_question_answers_participant_id", "meeting_question_answers", ["participant_id"])


def downgrade() -> None:
    op.drop_index("ix_meeting_question_answers_participant_id", table_name="meeting_question_answers")
    op.drop_index("ix_meeting_question_answers_question_id", table_name="meeting_question_answers")
    op.drop_table("meeting_question_answers")
    op.drop_index("ix_meeting_questions_meeting_id", table_name="meeting_questions")
    op.drop_table("meeting_questions")
