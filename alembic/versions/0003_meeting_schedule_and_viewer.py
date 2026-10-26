"""Add meeting scheduling fields and viewer participant role.

Revision ID: 0003_meeting_schedule_and_viewer
Revises: 0002_add_user_auth_fields
Create Date: 2026-10-05
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0003_meeting_schedule_and_viewer"
down_revision: Union[str, None] = "0002_add_user_auth_fields"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("meetings", sa.Column("start_time", sa.DateTime(timezone=True), nullable=True))
    op.add_column("meetings", sa.Column("end_time", sa.DateTime(timezone=True), nullable=True))
    op.add_column("meetings", sa.Column("language", sa.String(length=10), server_default="en", nullable=False))
    op.add_column("meetings", sa.Column("meeting_type", sa.String(length=32), server_default="online", nullable=False))
    op.execute("UPDATE meetings SET start_time = scheduled_at WHERE start_time IS NULL")
    op.alter_column("meetings", "language", server_default=None)
    op.alter_column("meetings", "meeting_type", server_default=None)
    op.execute("ALTER TYPE participant_role ADD VALUE IF NOT EXISTS 'viewer'")


def downgrade() -> None:
    op.drop_column("meetings", "meeting_type")
    op.drop_column("meetings", "language")
    op.drop_column("meetings", "end_time")
    op.drop_column("meetings", "start_time")
    # PostgreSQL enum values cannot be removed safely in a simple downgrade.