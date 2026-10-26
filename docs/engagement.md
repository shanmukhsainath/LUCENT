# Realtime engagement

Phase 9 adds ephemeral meeting engagement over the authenticated WebSocket:

- `REACTION` accepts `👍`, `👏`, `❤️`, `🎉`, `😂`, and `❓`.
- `NOTIFICATION` carries a short meeting notification message.

Reactions and notifications are broadcast to currently connected participants
and are not persisted. The backend validates reactions before broadcasting them.
