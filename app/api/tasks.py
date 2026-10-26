from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.api.meetings import get_authorized_meeting
from app.database.session import get_db
from app.models import Task, User
from app.schemas.tasks import TaskCreateRequest, TaskResponse, TaskUpdateRequest

router = APIRouter(prefix="/api/meetings/{meeting_id}/tasks", tags=["tasks"])
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def task_response(task: Task) -> TaskResponse:
    return TaskResponse.model_validate(task)


@router.get("", response_model=list[TaskResponse])
def list_tasks(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> list[TaskResponse]:
    get_authorized_meeting(meeting_id, current_user, db)
    tasks = db.scalars(select(Task).where(Task.meeting_id == meeting_id).order_by(Task.created_at.asc())).all()
    return [task_response(task) for task in tasks]


@router.post("", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
def create_task(
    meeting_id: UUID,
    payload: TaskCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> TaskResponse:
    get_authorized_meeting(meeting_id, current_user, db)
    task = Task(
        meeting_id=meeting_id,
        title=payload.title.strip(),
        description=payload.description,
        priority=payload.priority,
        due_at=payload.due_at,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task_response(task)


@router.patch("/{task_id}", response_model=TaskResponse)
def update_task(
    meeting_id: UUID,
    task_id: UUID,
    payload: TaskUpdateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> TaskResponse:
    get_authorized_meeting(meeting_id, current_user, db)
    task = db.scalar(select(Task).where(Task.id == task_id, Task.meeting_id == meeting_id))
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    changes = payload.model_dump(exclude_unset=True)
    if "title" in changes:
        task.title = changes["title"].strip()
    for field in ("description", "status", "priority", "due_at"):
        if field in changes:
            setattr(task, field, changes[field])
    db.commit()
    db.refresh(task)
    return task_response(task)
