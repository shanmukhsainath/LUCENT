# MeetMind WebSocket protocol

## Endpoint

```text
/ws/meetings/{meeting_id}?token=<jwt-access-token>
```

The browser WebSocket API cannot send an `Authorization` header during the handshake, so the JWT is passed in the `token` query parameter. The backend validates the token and checks that the user is the meeting creator or an active participant. Unauthorized connections close with `4401` or `4403`.

## Message types

| Type | Payload example | Direction |
| --- | --- | --- |
| `TRANSCRIPT` | `{ "text": "...", "speaker_name": "Alex" }` | backend to frontend |
| `TRANSLATION` | `{ "text": "...", "language": "es" }` | backend to frontend |
| `PARTICIPANT_JOINED` | `{ "user_id": "uuid", "name": "Alex", "role": "participant", "audio_enabled": true, "video_enabled": true }` | backend broadcast |
| `PARTICIPANT_LEFT` | `{ "user_id": "uuid", "name": "Alex" }` | backend broadcast |
| `PARTICIPANT_ROSTER` | `{ "participants": [{ "user_id": "...", "name": "Alex", "role": "participant", "audio_enabled": true, "video_enabled": true }] }` | server to newly connected client |
| `MEETING_ENDED` | `{ "reason": "The meeting has ended." }` | backend broadcast |
| `MEETING_EVENT` | `{ "name": "question-timer-started", "duration_seconds": 120 }` | permitted client event |
| `REACTION` | `{ "reaction": "👍" }` | permitted client broadcast |
| `MEDIA_STATE` | `{ "audio_enabled": true, "video_enabled": false }` | permitted client broadcast |
| `MEETING_SETTINGS_UPDATED` | `{ "camera_required": true, "microphone_required": false, "allow_camera_toggle": true, "allow_microphone_toggle": true }` | server broadcast |
| `MEDIA_STATE_REJECTED` | `{ "audio_enabled": true, "video_enabled": true, "user_id": "uuid" }` | server to sender |
| `MEDIA_REQUIREMENT_CHANGED` | `{ "camera_required": true, "microphone_required": false }` | server to affected participant |
| `ERROR` | `{ "code": "FORBIDDEN_MESSAGE", "message": "..." }` | backend error |
| `PING` | `{}` | client heartbeat |
| `PONG` | `{ "at": "..." }` | backend heartbeat response |
| `OFFER` | `{ "target_user_id": "...", "description": {} }` | targeted WebRTC signaling |
| `ANSWER` | `{ "target_user_id": "...", "description": {} }` | targeted WebRTC signaling |
| `ICE_CANDIDATE` | `{ "target_user_id": "...", "candidate": {} }` | targeted WebRTC signaling |

Clients cannot send `TRANSCRIPT`, `TRANSLATION`, `TASK_CREATED`, `BOOKMARK`, or `NOTIFICATION`; those messages receive `ERROR` with code `FORBIDDEN_MESSAGE`. `MEETING_EVENT` is limited to `question-created` and `question-answered` for active participants. `question-timer-started` is restricted to the meeting creator. This allow-list is temporary until the server-authoritative event system is implemented.

Viewers cannot send `REACTION` or `MEDIA_STATE`. Media state is validated as two booleans and the server adds the sender's user ID.

Only one WebSocket per user is allowed for a meeting. Opening a second tab
closes the older connection with code `4001` (`Opened in another window`).

When media requirements are enabled, a participant is not admitted to the roster or WebRTC signaling until a valid `MEDIA_STATE` satisfies the required devices. Signaling to or from that participant receives `NOT_ADMITTED`. Attempts to turn off a required device or a device locked by the host receive `MEDIA_TOGGLE_NOT_ALLOWED` and `MEDIA_STATE_REJECTED`.

Binary `audio/webm` frames are buffered in memory, sent to the configured speech service, and discarded after the request lifecycle; raw audio is not written to permanent storage.

## Frontend service

`meetings/websocket-service.js` provides `MeetingWebSocketService` with automatic reconnect, connection status callbacks, heartbeat pings, JSON parsing, error callbacks, audio chunk sending, and clean client shutdown without reconnect.
