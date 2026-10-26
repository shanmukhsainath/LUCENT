# Meeting administration

The meeting creator is the persistent host. Host-only API operations are:

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

The meeting workspace exposes these role and removal controls only to the host.
The media settings controls are also host-only. Settings are persisted with the
meeting and are enforced by the WebSocket server at admission and on every
media-state update.

Joining always creates a regular participant. Host status is never accepted
from a client-provided join payload.

The WebSocket checks access before processing each incoming message, so a
participant whose access is revoked cannot continue sending media or realtime
events on an already-open connection.

Questions are available through `GET` and `POST
/api/meetings/{meeting_id}/questions`. Any authorized participant can ask or
answer a question; answers are timestamped and retain their source label.

The meeting workspace includes a host-started countdown timer. Timer state is
shared over the existing `MEETING_EVENT` WebSocket message and is intentionally
ephemeral; the question and answer records remain persisted in the database.
