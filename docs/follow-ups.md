# Follow-ups

Tasks use the existing `tasks` table and are available to authorized meeting
participants:

- `GET /api/meetings/{meeting_id}/tasks`
- `POST /api/meetings/{meeting_id}/tasks`
- `PATCH /api/meetings/{meeting_id}/tasks/{task_id}`

The meeting workspace can create tasks and update their status. Topics are read
from the persisted meeting summary after summarization; no topics are invented
when a summary is unavailable.
