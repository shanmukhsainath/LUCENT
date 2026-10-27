from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.api.meetings import get_authorized_meeting, get_host_meeting
from app.database.session import get_db
from app.models import Participant, ParticipantRole, Task, User
from app.realtime.manager import manager
from app.schemas.tasks import TaskCreateRequest, TaskResponse, TaskUpdateRequest

router = APIRouter(prefix="/api/meetings/{meeting_id}/tasks", tags=["tasks"])
DbSession = Annotated[Session, Depends(get_db)]
CurrentUser = Annotated[User, Depends(get_current_user)]


def task_response(task: Task) -> TaskResponse:
    return TaskResponse.model_validate(task)


def is_current_host(meeting_id: UUID, user_id: UUID, db: Session) -> bool:
    return db.scalar(
        select(Participant.id).where(
            Participant.meeting_id == meeting_id,
            Participant.user_id == user_id,
            Participant.role == ParticipantRole.host,
            Participant.left_at.is_(None),
        )
    ) is not None


@router.get("", response_model=list[TaskResponse])
def list_tasks(meeting_id: UUID, current_user: CurrentUser, db: DbSession) -> list[TaskResponse]:
    get_authorized_meeting(meeting_id, current_user, db)
    query = select(Task).where(Task.meeting_id == meeting_id)
    if not is_current_host(meeting_id, current_user.id, db):
        query = query.where((Task.assignee_id == current_user.id) | Task.assignee_id.is_(None))
    tasks = db.scalars(query.order_by(Task.created_at.asc())).all()
    return [task_response(task) for task in tasks]


@router.post("", response_model=TaskResponse, status_code=status.HTTP_201_CREATED)
async def create_task(
    meeting_id: UUID,
    payload: TaskCreateRequest,
    current_user: CurrentUser,
    db: DbSession,
) -> TaskResponse:
    get_host_meeting(meeting_id, current_user, db)
    if payload.assignee_id is not None:
        assignee = db.scalar(
            select(Participant.id).where(
                Participant.meeting_id == meeting_id,
                Participant.user_id == payload.assignee_id,
                Participant.left_at.is_(None),
            )
        )
        if assignee is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Task assignee must be an active meeting participant")
    task = Task(
        meeting_id=meeting_id,
        assignee_id=payload.assignee_id,
        title=payload.title.strip(),
        description=payload.description,
        priority=payload.priority,
        due_at=payload.due_at,
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    await manager.broadcast(meeting_id, {"type": "TASK_UPDATED", "payload": {"task_id": str(task.id)}})
    return task_response(task)


@router.patch("/{task_id}", response_model=TaskResponse)
async def update_task(
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
    host = is_current_host(meeting_id, current_user.id, db)
    if not host:
        participant_role = db.scalar(
            select(Participant.role).where(
                Participant.meeting_id == meeting_id,
                Participant.user_id == current_user.id,
                Participant.left_at.is_(None),
            )
        )
        if participant_role != ParticipantRole.participant:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only assigned participants can update task status")
        if set(changes) != {"status"}:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the host can edit task details")
        if task.assignee_id not in {None, current_user.id}:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This task is assigned to another participant")
    if "title" in changes:
        task.title = changes["title"].strip()
    for field in ("description", "status", "priority", "due_at"):
        if field in changes:
            setattr(task, field, changes[field])
    if "assignee_id" in changes:
        assignee_id = changes["assignee_id"]
        if assignee_id is not None:
            assignee = db.scalar(
                select(Participant.id).where(
                    Participant.meeting_id == meeting_id,
                    Participant.user_id == assignee_id,
                    Participant.left_at.is_(None),
                )
            )
            if assignee is None:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Task assignee must be an active meeting participant")
        task.assignee_id = assignee_id
    db.commit()
    db.refresh(task)
    await manager.broadcast(meeting_id, {"type": "TASK_UPDATED", "payload": {"task_id": str(task.id)}})
    return task_response(task)


@router.delete("/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_task(
    meeting_id: UUID,
    task_id: UUID,
    current_user: CurrentUser,
    db: DbSession,
) -> None:
    get_host_meeting(meeting_id, current_user, db)
    task = db.scalar(select(Task).where(Task.id == task_id, Task.meeting_id == meeting_id))
    if task is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")
    db.delete(task)
    db.commit()
    await manager.broadcast(meeting_id, {"type": "TASK_UPDATED", "payload": {"task_id": str(task_id)}})
