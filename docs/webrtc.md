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
