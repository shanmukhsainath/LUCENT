# Speech recognition setup

MeetMind uses a replaceable `SpeechService` interface in `app/services/speech_service.py`. The default adapter is `WhisperSpeechService`, backed by `faster-whisper`.

Environment variables:

```env
SPEECH_ENABLED=true
WHISPER_MODEL=small
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
```

Recommended development setup:

```powershell
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload
```

The first transcription may download the configured Whisper model through `faster-whisper`. No API key is required. For GPU deployments, configure `WHISPER_DEVICE=cuda` and an appropriate compute type.

The browser requests microphone permission and sends one-second `audio/webm` chunks over the authenticated meeting WebSocket. Audio is buffered only in memory for transcription and is not persisted. Each successfully processed segment is released immediately, and the server rejects buffers above a 2 MB safety limit. Transcript segments are stored in the `transcripts` table with speaker, language, timestamps, and confidence when the model provides it.

Set `SPEECH_ENABLED=false` to keep the realtime meeting connection available while disabling speech processing. Audio attempts then return a `SPEECH_SERVICE_ERROR` message instead of being stored or silently discarded.
