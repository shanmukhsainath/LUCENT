# WebRTC media layer

The meeting workspace now includes a reusable `MeetingWebRTCService` in
`meetings/webrtc-service.js`.

It provides:

- local audio/video track management
- peer connection creation
- SDP offer and answer helpers
- ICE candidate handling
- remote stream callbacks
- peer connection state callbacks
- cleanup for individual peers or the whole meeting

Phase 3 does not send signaling messages. The existing authenticated meeting
WebSocket remains the signaling transport planned for Phase 4. Until that
phase is implemented, the workspace shows the local camera preview and a
waiting state for remote video instead of displaying fabricated participants.
