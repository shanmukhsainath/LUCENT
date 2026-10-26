"""Add persisted summary sections.

Revision ID: 0004_summary_sections
Revises: 0003_meeting_schedule_and_viewer
Create Date: 2026-10-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0004_summary_sections"
down_revision: Union[str, None] = "0003_meeting_schedule_and_viewer"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("summaries", sa.Column("topics", postgresql.JSONB()))
    op.add_column("summaries", sa.Column("questions", postgresql.JSONB()))
    op.add_column("summaries", sa.Column("deadlines", postgresql.JSONB()))
    op.add_column("summaries", sa.Column("important_moments", postgresql.JSONB()))


def downgrade() -> None:
    op.drop_column("summaries", "important_moments")
    op.drop_column("summaries", "deadlines")
    op.drop_column("summaries", "questions")
    op.drop_column("summaries", "topics")