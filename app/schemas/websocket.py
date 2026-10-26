from typing import Any, Literal

from pydantic import BaseModel, Field


DevelopmentMessageType = Literal[
    "TRANSCRIPT",
    "TRANSLATION",
    "MEETING_EVENT",
    "TASK_CREATED",
    "BOOKMARK",
]


class DevelopmentEventRequest(BaseModel):
    type: DevelopmentMessageType
    payload: dict[str, Any] = Field(default_factory=dict)
