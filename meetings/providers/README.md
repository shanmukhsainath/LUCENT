# Media providers

The workspace selects `window.MEETMIND_MEDIA_PROVIDER` and currently supports
only `mesh`. A future LiveKit provider should implement the `MediaProvider`
contract in `../media-provider.js`:

- `connect` creates the LiveKit room and maps room events to the callbacks.
- `setLocalStream`, `publishTrack`, and `unpublishTrack` map to local
  publication APIs.
- `setAudioEnabled` and `setVideoEnabled` map to publication mute/unmute.
- `handleSignal`, `restartConnection`, and `getStats` map to the provider's
  signaling, reconnect, and diagnostics APIs.
- `getParticipantMedia` returns the participant's current camera/microphone
  streams.

Do not add provider credentials or fake room state to the frontend. The
backend must issue any provider-specific authorization in a later phase.
