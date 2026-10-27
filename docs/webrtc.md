# WebRTC media

MeetMind uses a frontend media-provider contract so the current mesh
implementation can later be replaced by an SFU provider. Set
`MEETMIND_MEDIA_PROVIDER=mesh` (the default) or provide a future provider
implementing `connect`, `disconnect`, stream/track publication, signaling,
reconnect, and stats methods.

The mesh provider is appropriate for small meetings, approximately 4-6
participants. Every admitted participant has a peer connection with every
other admitted participant. The authenticated WebSocket carries signaling;
audio and video never pass through REST.

## ICE configuration

The workspace requests `GET /api/meetings/{meeting_id}/ice-servers` before
creating peers. The endpoint is restricted to authorized participants and
returns STUN URLs plus TURN credentials when configured. With
`TURN_SHARED_SECRET`, credentials use one-hour coturn REST-API usernames and
HMAC-SHA1 passwords. Otherwise static `TURN_USERNAME` and `TURN_CREDENTIAL`
are returned.

TURN is not included with MeetMind. Deploy and operate a TURN service such as
coturn separately, then configure its URLs and credentials in the backend
environment. STUN-only deployments can fail behind strict NATs.

## Reconnect behaviour

The WebSocket reconnects with backoff and receives a fresh roster containing
role and server-authoritative media state. The mesh provider retains healthy
peers, restarts ICE for unstable connections, and recreates a failed peer
through authenticated signaling. Opening the meeting in another tab closes
the older socket with code `4001`.

## Local camera and microphone

The local preview attaches the acquired camera stream to the mounted video
element and keeps it muted. Disabling the camera unpublishes the video sender,
removes and stops only the camera's video track, and leaves the microphone and
peer connections running. Enabling video later requests a fresh camera track
and replaces the existing video sender when available; otherwise the provider
adds a track and negotiates it. Leaving the meeting stops remaining local
tracks and detaches the preview elements.

Camera and microphone access is requested from the user's control action. The
page must be served from HTTPS or localhost for browser media permissions.
Permission and unavailable-device errors are shown in the meeting UI.
