import asyncio
import math
import tempfile
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Protocol

from app.database.config import settings


class SpeechServiceError(RuntimeError):
    """Raised when speech recognition cannot process an audio buffer."""


@dataclass(frozen=True)
class SpeechResult:
    text: str
    language: str | None = None
    confidence: float | None = None
    start_seconds: float | None = None
    end_seconds: float | None = None


class SpeechService(Protocol):
    async def transcribe(self, audio: bytes, audio_format: str = "webm") -> SpeechResult:
        """Transcribe an in-memory audio buffer without persisting raw audio."""


class WhisperSpeechService:
    """faster-whisper adapter; the model is loaded lazily and audio stays temporary."""

    def __init__(self) -> None:
        self._model = None

    def _load_model(self):
        if self._model is not None:
            return self._model
        try:
            from faster_whisper import WhisperModel
        except ImportError as error:
            raise SpeechServiceError(
                "Speech recognition is unavailable. Install faster-whisper and enable SPEECH_ENABLED."
            ) from error
        self._model = WhisperModel(
            settings.whisper_model,
            device=settings.whisper_device,
            compute_type=settings.whisper_compute_type,
        )
        return self._model

    def _transcribe_sync(self, audio: bytes, audio_format: str) -> SpeechResult:
        if not audio:
            raise SpeechServiceError("Received an empty audio buffer.")
        model = self._load_model()
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(suffix=f".{audio_format}", delete=False) as temporary_file:
                temporary_file.write(audio)
                temporary_path = Path(temporary_file.name)
            segments, info = model.transcribe(
                str(temporary_path),
                beam_size=1,
                vad_filter=True,
                language=None,
            )
            segment_list = list(segments)
            text = " ".join(segment.text.strip() for segment in segment_list if segment.text.strip()).strip()
            confidence_values = [
                math.exp(segment.avg_logprob)
                for segment in segment_list
                if getattr(segment, "avg_logprob", None) is not None
            ]
            confidence = min(1.0, max(0.0, sum(confidence_values) / len(confidence_values))) if confidence_values else None
            return SpeechResult(
                text=text,
                language=getattr(info, "language", None),
                confidence=confidence,
                start_seconds=segment_list[0].start if segment_list else None,
                end_seconds=segment_list[-1].end if segment_list else None,
            )
        except SpeechServiceError:
            raise
        except Exception as error:
            raise SpeechServiceError("Speech recognition failed while decoding the audio.") from error
        finally:
            if temporary_path:
                temporary_path.unlink(missing_ok=True)

    async def transcribe(self, audio: bytes, audio_format: str = "webm") -> SpeechResult:
        return await asyncio.to_thread(self._transcribe_sync, audio, audio_format)


class DisabledSpeechService:
    async def transcribe(self, audio: bytes, audio_format: str = "webm") -> SpeechResult:
        raise SpeechServiceError("Speech recognition is disabled. Set SPEECH_ENABLED=true to enable Whisper.")


@lru_cache
def get_speech_service() -> SpeechService:
    if not settings.speech_enabled:
        return DisabledSpeechService()
    return WhisperSpeechService()
