# MeetMind WebSocket protocol

## Endpoint

```text
/ws/meetings/{meeting_id}?token=<jwt-access-token>
```

The browser WebSocket API cannot send an `Authorization` header during the handshake, so the JWT is passed in the `token` query parameter. The backend validates the token and checks that the user is the meeting creator or an active participant. Unauthorized connections close with `4401` (missing/invalid authentication) or `4403` (meeting access denied).

Meeting administration is enforced through the HTTP API. Only the meeting
creator can update settings, start or end the meeting, change another
participant's role, or remove an active participant. A client cannot promote
itself to `host` through the join request.

## Envelope

Every message is JSON:

```json
{
  "type": "TRANSCRIPT",
  "payload": {},
  "sender": { "user_id": "uuid", "name": "Alex Rivera" },
  "at": "2026-10-05T12:00:00Z"
}
```

`sender` and `at` are added by the backend for broadcast messages. `payload` is type-specific.

## Message types

| Type | Payload example | Direction |
| --- | --- | --- |
| `TRANSCRIPT` | `{ "text": "...", "speaker_name": "Alex" }` | backend/frontend development messages |
| `TRANSLATION` | `{ "text": "...", "language": "es" }` | backend/frontend development messages |
| `PARTICIPANT_JOINED` | `{ "user_id": "uuid", "name": "Alex" }` | backend broadcast |
| `PARTICIPANT_LEFT` | `{ "user_id": "uuid", "name": "Alex" }` | backend broadcast |
| `MEETING_EVENT` | `{ "name": "started" }` | development messages |
| `TASK_CREATED` | `{ "title": "Follow up" }` | development messages |
| `BOOKMARK` | `{ "timestamp": 120 }` | development messages |
| `ERROR` | `{ "code": "UNKNOWN_MESSAGE_TYPE", "message": "..." }` | backend broadcast/error |
| `PING` | `{}` | client heartbeat |
| `PONG` | `{ "at": "..." }` | backend heartbeat response |
| `PARTICIPANT_ROSTER` | `{ "participants": [{ "user_id": "...", "name": "Alex" }] }` | server to newly connected client |
| `OFFER` | `{ "target_user_id": "...", "description": { "type": "offer", "sdp": "..." } }` | targeted WebRTC signaling |
| `ANSWER` | `{ "target_user_id": "...", "description": { "type": "answer", "sdp": "..." } }` | targeted WebRTC signaling |
| `ICE_CANDIDATE` | `{ "target_user_id": "...", "candidate": {} }` | targeted WebRTC signaling |
| `MEDIA_STATE` | `{ "audio_enabled": true, "video_enabled": false }` | meeting broadcast |
| `MEETING_EVENT` | `{ "name": "question-timer-started", "duration_seconds": 120 }` | shared question timer |
| `REACTION` | `{ "reaction": "👍" }` | meeting broadcast |
| `NOTIFICATION` | `{ "message": "A task was updated" }` | meeting broadcast |

The backend accepts `PING`, the six development-capable message types, and binary `audio/webm` frames from the browser microphone. Audio frames are buffered in memory, sent to the configured speech service, and discarded after the request lifecycle; raw audio is not written to permanent storage.

Transcript results use this payload shape:

```json
{
  "transcript_id": "uuid",
  "speaker": "Alex Rivera",
  "speaker_id": "uuid",
  "text": "A new transcript segment",
  "timestamp": "2026-10-05T12:00:00Z",
  "language": "en",
  "confidence": 0.91
}
```

## Development test message

With an authenticated bearer token, send a development event through HTTP:

```http
POST /api/meetings/{meeting_id}/events/test
Authorization: Bearer <jwt-access-token>
Content-Type: application/json
```

```json
{
  "type": "TRANSCRIPT",
  "payload": {
    "text": "Development message received",
    "speaker_name": "Test speaker"
  }
}
```

Any authorized WebSocket clients in the meeting receive the event. Other supported `type` values are `TRANSLATION`, `MEETING_EVENT`, `TASK_CREATED`, and `BOOKMARK`.

## Frontend service

`meetings/websocket-service.js` provides `MeetingWebSocketService` with:

- automatic reconnect with exponential backoff
- connection status callbacks
- 25-second heartbeat pings
- JSON parsing and error callbacks
- clean client shutdown without reconnect

The workspace uses `MediaRecorder` with one-second `audio/webm` chunks. It handles unsupported browsers, denied microphone permission, empty chunks, disconnected sockets, recorder recovery, bounded server buffering, and speech-service errors without displaying fabricated transcript content.
