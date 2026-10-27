# Speech recognition setup

MeetMind uses a replaceable `SpeechService` interface in `app/services/speech_service.py`. The default adapter is `WhisperSpeechService`, backed by `faster-whisper`.

Environment variables:

```env
SPEECH_ENABLED=true
WHISPER_MODEL=large-v3
WHISPER_DEVICE=auto
WHISPER_COMPUTE_TYPE=int8_float16
```

Install the application dependencies. ffmpeg is needed only when converting non-WAV file uploads; the meeting's live PCM transcription does not require it.

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
winget install --id Gyan.FFmpeg --exact
```

After installing ffmpeg, open a new PowerShell window so its updated `PATH` is available. For Windows NVIDIA GPU inference, install the CUDA 12 runtime libraries in the project virtual environment before starting the API:

```powershell
.\.venv\Scripts\python.exe -m pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
.\.venv\Scripts\python.exe -m pip install --upgrade torch --index-url https://download.pytorch.org/whl/cu130
```

The plain `torch` requirement installs the default wheel. Use the CUDA wheel command above on an NVIDIA machine so Transformers can use the GPU; the NLLB loader falls back to CPU if GPU memory is insufficient alongside Whisper. Then apply database migrations and start the API:

```powershell
.\.venv\Scripts\python.exe -m alembic upgrade head
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The API loads one Whisper model during startup and downloads it on the first run, logging the selected model and device. A CUDA-enabled CTranslate2 runtime uses `large-v3` with `int8_float16` for reduced GPU memory use and faster live inference; otherwise the service selects `medium` on the CPU with `int8`. The NLLB-200 distilled 600M translation model and tokenizer are also downloaded and loaded once at startup, using CUDA with half precision when PyTorch detects a GPU, or CPU otherwise. No API key is required. On Windows, the service adds the NVIDIA runtime DLLs from the project environment to the loader path; other CUDA installations must provide compatible cuBLAS and cuDNN 9 libraries.

Run the API from the project virtual environment. Keep `--reload` off while speech is enabled: each reload initializes both large models again and can exhaust system or GPU memory.

The meeting's authenticated WebSocket sends microphone audio to faster-whisper as 16 kHz mono PCM in 250 ms chunks. Whisper finalizes a transcript segment after a pause or six seconds of audio; the segment is stored in the `transcripts` table and delivered live to connected non-host participants. Participants can load transcript history from `GET /api/meetings/{meeting_id}/transcripts`; hosts are denied by the API. Transcript file uploads and one-off recordings are not part of the meeting transcript feature.

Live translated captions use `ws://localhost:8000/ws/live?src=en&tgt=ml` (use `wss://` for HTTPS). Select a speaking language and caption language in the meeting transcript panel, then start microphone or meeting/tab audio capture. The browser's shared AudioWorklet sends 16 kHz mono PCM int16 in 250 ms frames only while voice is detected, including a short silence tail so the server can finalize captions. The server emits interim and finalized captions after Whisper transcription and NLLB translation; matching interim/final IDs update the same caption row. Supported live language codes are English (`en`), Malayalam (`ml`), Telugu (`te`), Hindi (`hi`), Tamil (`ta`), and Kannada (`kn`). Matching source and target languages skip translation. For tab capture, choose the browser's tab-audio sharing option.

The browser requests microphone permission and captures 16 kHz mono PCM through an AudioWorklet over the authenticated meeting WebSocket. The worklet uses an adaptive RMS voice gate, retains a short pre-roll, sends frames only while speech is active, and signals the end of a phrase after 750 ms of silence. The server independently checks microphone state and speech energy, finalizes after 600 ms of silence or six seconds, and runs Whisper in a background worker so the WebSocket can continue receiving audio and meeting events.

Faster-whisper does not expose token-by-token streaming transcription. MeetMind therefore sends a replaceable interim transcript from rolling snapshots of the current utterance, starting after about 1.25 seconds and refreshing as more audio arrives. Interim snapshots include a short silence pad so Whisper's VAD can recognize an in-progress phrase; an active interim is allowed to finish before its queued final replaces it. Pending interim work is coalesced when inference is behind; final results take priority, are screened using Whisper's no-speech and log-probability values, and are persisted once in the `transcripts` table. Muting, leaving, changing microphones, or losing the meeting socket stops capture and clears pending audio so stale frames cannot be transcribed.

Set `SPEECH_ENABLED=false` to keep the realtime meeting connection available while disabling speech processing. Audio attempts then return a `SPEECH_SERVICE_ERROR` message instead of being stored or silently discarded.
