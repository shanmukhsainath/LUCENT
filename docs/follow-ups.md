# Follow-ups

Tasks use the existing `tasks` table. Hosts create, assign, edit, and delete
tasks. Participants can view tasks assigned to them or to everyone and can
change the status of those tasks only:

- `GET /api/meetings/{meeting_id}/tasks`
- `POST /api/meetings/{meeting_id}/tasks`
- `PATCH /api/meetings/{meeting_id}/tasks/{task_id}`
- `DELETE /api/meetings/{meeting_id}/tasks/{task_id}`

Task creation accepts `assignee_id` (null assigns it to all participants),
`description`, `priority`, and `due_at`. The server validates that an assignee
is an active participant and broadcasts task updates to the meeting.

Host-managed topics are stored separately from automatically detected summary
topics. `GET /api/meetings/{meeting_id}/topics` returns drafts only to the host;
participants receive published topics only. Hosts can create, edit, publish,
unpublish, and delete topics. Automatically detected topics remain sourced
from the persisted meeting summary and are not invented when no summary exists.

The new topics table requires the database migration:

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
```
