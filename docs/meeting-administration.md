# Meeting administration

The active `host` participant role is authoritative. The creator receives that
role when the meeting is created; a current host may transfer it to another
active participant with `POST /api/meetings/{meeting_id}/participants/{user_id}/host`.
The server serializes transfers, changes both participant roles, and broadcasts
`HOST_TRANSFERRED` to connected clients. The former host loses privileged access
immediately. A disconnected host retains the role and can recover it by
rejoining; meetings are not ended automatically on disconnect.

Host-only API operations are:

- `PATCH /api/meetings/{meeting_id}` to update the title, description, schedule,
  and privacy mode.
- `POST /api/meetings/{meeting_id}/start` to mark the meeting live.
- `POST /api/meetings/{meeting_id}/end` to complete the meeting.
- `PATCH /api/meetings/{meeting_id}/participants/{user_id}` to assign
  `participant` or `viewer`.
- `DELETE /api/meetings/{meeting_id}/participants/{user_id}` to revoke active
  access.
- `GET /api/meetings/{meeting_id}/settings` to read persisted media settings.
- `PATCH /api/meetings/{meeting_id}/settings` to update camera/microphone
  requirements and participant toggle permissions.
- `POST`, `PATCH`, and `DELETE /api/meetings/{meeting_id}/topics` (with a topic
  ID for updates/deletes) to manage host-published meeting topics.
- `POST` and `DELETE /api/meetings/{meeting_id}/tasks` (with a task ID for
  deletes) to manage follow-up tasks.

The meeting workspace exposes these role and removal controls only to the host.
The media settings controls are also host-only. Settings are persisted with the
meeting and are enforced by the WebSocket server at admission and on every
media-state update.

Joining always creates a regular participant unless the account already has an
authoritative host assignment. Host status is never accepted from a
client-provided join payload.

The WebSocket checks access before processing each incoming message, so a
participant whose access is revoked cannot continue sending media or realtime
events on an already-open connection.

Open room questions remain available through `GET` and `POST
/api/meetings/{meeting_id}/questions`; they retain their existing answer-source
and timestamp behavior.

Host-managed scheduled questions use:

- `GET` and `POST /api/meetings/{meeting_id}/questions/scheduled`.
- `PATCH /api/meetings/{meeting_id}/questions/scheduled/{question_id}` to edit.
- `PATCH /api/meetings/{meeting_id}/questions/scheduled/reorder` with the full
  ordered question ID list.
- `POST /api/meetings/{meeting_id}/questions/scheduled/{question_id}/activate`
  to activate a question immediately.
- `DELETE /api/meetings/{meeting_id}/questions/scheduled/{question_id}`.
- `POST /api/meetings/{meeting_id}/questions/scheduled/{question_id}/answer`
  for participants to submit or revise their own active-question answer.

Scheduled offsets are measured from the server-recorded meeting start time.
Questions without an offset wait for host activation; a blank answer duration
leaves the active question open until another question is activated. Future
questions are hidden from participants unless the host enables their preview.
The server determines active and expired states on every schedule read and
answer submission. Participant answers are private to the respondent and the
current host; other participants cannot read them. Schedule changes are
broadcast using `SCHEDULED_QUESTIONS_UPDATED`.

The existing host-started meeting countdown timer remains available separately.
Its `MEETING_EVENT` state is intentionally ephemeral; scheduled-question timing,
ordering, and answers are stored in the database.

Apply the additive `0008_scheduled_questions` Alembic migration after the
existing meeting migrations before using the scheduled-question endpoints.

Personal notes are restricted to active participants and each notes query or
mutation is scoped to the authenticated author's notes. Hosts cannot list or
modify another participant's private notes.
