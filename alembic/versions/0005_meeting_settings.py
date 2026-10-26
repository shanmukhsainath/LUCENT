"""Add persisted meeting media settings.

Revision ID: 0005_meeting_settings
Revises: 0004_summary_sections
"""
import uuid
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0005_meeting_settings"
down_revision: Union[str, None] = "0004_summary_sections"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "meeting_settings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("meeting_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("camera_required", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("microphone_required", sa.Boolean(), server_default=sa.false(), nullable=False),
        sa.Column("allow_camera_toggle", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("allow_microphone_toggle", sa.Boolean(), server_default=sa.true(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id", name="pk_meeting_settings"),
        sa.UniqueConstraint("meeting_id", name="uq_meeting_settings_meeting_id"),
    )
    op.create_index("ix_meeting_settings_meeting_id", "meeting_settings", ["meeting_id"], unique=True)
    connection = op.get_bind()
    meeting_ids = connection.execute(sa.text("SELECT id FROM meetings")).scalars().all()
    if meeting_ids:
        values = ", ".join(
            f"('{uuid.uuid4()}', '{meeting_id}', false, false, true, true)"
            for meeting_id in meeting_ids
        )
        connection.execute(
            sa.text(
                "INSERT INTO meeting_settings "
                "(id, meeting_id, camera_required, microphone_required, allow_camera_toggle, allow_microphone_toggle) "
                f"VALUES {values}"
            )
        )


def downgrade() -> None:
    op.drop_index("ix_meeting_settings_meeting_id", table_name="meeting_settings")
    op.drop_table("meeting_settings")
