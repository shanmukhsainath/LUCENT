import asyncio
import importlib.util
import logging
import math
import os
import subprocess
import tempfile
import threading
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Protocol

import numpy as np

from app.database.config import settings

logger = logging.getLogger(__name__)


class SpeechServiceError(RuntimeError):
    """Raised when speech recognition cannot process an audio buffer."""


@dataclass(frozen=True)
class SpeechSegment:
    start: float
    end: float
    text: str


@dataclass(frozen=True)
class SpeechResult:
    text: str
    language: str | None = None
    segments: tuple[SpeechSegment, ...] = ()
    confidence: float | None = None
    start_seconds: float | None = None
    end_seconds: float | None = None


class SpeechService(Protocol):
    async def initialize(self) -> None:
        ...

    async def transcribe(
        self,
        audio: bytes,
        audio_format: str = "webm",
        language: str | None = None,
    ) -> SpeechResult:
        ...

    async def transcribe_pcm(self, audio: bytes, language: str | None) -> SpeechResult:
        ...


class WhisperSpeechService:
    """faster-whisper adapter with a single startup-loaded model."""

    def __init__(self) -> None:
        self._model = None
        self._model_lock = threading.Lock()
        self._inference_lock = threading.Lock()
        self._cuda_dll_directories: list[object] = []
        self._model_name = "medium"
        self._device = "cpu"
        self._compute_type = "int8"

    def _load_model(self):
        if self._model is not None:
            return self._model
        with self._model_lock:
            if self._model is not None:
                return self._model

            try:
                self._load_cuda_libraries()
                from ctranslate2 import get_cuda_device_count
                from faster_whisper import WhisperModel
            except ImportError as error:
                raise SpeechServiceError(
                    "Speech recognition is unavailable. Install the project requirements."
                ) from error

            try:
                cuda_available = get_cuda_device_count() > 0
            except RuntimeError as error:
                logger.warning("CUDA is unavailable to CTranslate2; using the CPU model: %s", error)
                cuda_available = False

            if cuda_available:
                self._model_name = settings.whisper_model
                self._device = "cuda"
                self._compute_type = settings.whisper_compute_type
            else:
                self._model_name = "medium"
                self._device = "cpu"
                self._compute_type = "int8"

            logger.info(
                "Loading faster-whisper model %s on %s (%s). The initial model download may take several minutes.",
                self._model_name,
                self._device,
                self._compute_type,
            )
            self._model = WhisperModel(
                self._model_name,
                device=self._device,
                compute_type=self._compute_type,
            )
            logger.info("faster-whisper model %s is ready.", self._model_name)
            return self._model

    def _load_cuda_libraries(self) -> None:
        if os.name != "nt":
            return
        for module_name in (
            "nvidia.cublas",
            "nvidia.cudnn",
            "nvidia.cuda_nvrtc",
            "nvidia.cuda_runtime",
        ):
            try:
                spec = importlib.util.find_spec(module_name)
            except ModuleNotFoundError:
                continue
            if spec is None:
                continue
            if spec.origin is not None:
                package_directory = Path(spec.origin).parent
            elif spec.submodule_search_locations:
                package_directory = Path(next(iter(spec.submodule_search_locations)))
            else:
                continue
            binary_directory = package_directory / "bin"
            if binary_directory.is_dir():
                directory = str(binary_directory)
                self._cuda_dll_directories.append(os.add_dll_directory(directory))
                os.environ["PATH"] = os.pathsep.join((directory, os.environ.get("PATH", "")))

    async def initialize(self) -> None:
        await asyncio.to_thread(self._load_model)

    @staticmethod
    def _convert_audio(source: Path, destination: Path) -> None:
        try:
            completed = subprocess.run(
                [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(source),
                    "-vn",
                    "-ac",
                    "1",
                    "-ar",
                    "16000",
                    "-f",
                    "wav",
                    str(destination),
                ],
                check=True,
                capture_output=True,
                text=True,
                timeout=120,
            )
        except FileNotFoundError as error:
            raise SpeechServiceError("ffmpeg was not found on PATH.") from error
        except subprocess.TimeoutExpired as error:
            raise SpeechServiceError("Audio conversion timed out after 120 seconds.") from error
        except subprocess.CalledProcessError as error:
            detail = (error.stderr or "").strip().splitlines()
            message = detail[-1] if detail else "ffmpeg could not decode the uploaded audio."
            raise SpeechServiceError(f"Audio conversion failed: {message}") from error
        if completed.stderr:
            logger.debug("ffmpeg audio conversion output: %s", completed.stderr.strip())

    def _transcribe_sync(
        self,
        audio: bytes,
        audio_format: str,
        language: str | None,
    ) -> SpeechResult:
        if not audio:
            raise SpeechServiceError("Received an empty audio buffer.")

        model = self._load_model()
        source_path: Path | None = None
        converted_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(suffix=f".{audio_format}", delete=False) as source_file:
                source_file.write(audio)
                source_path = Path(source_file.name)

            audio_path = source_path
            if audio_format != "wav":
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as converted_file:
                    converted_path = Path(converted_file.name)
                self._convert_audio(source_path, converted_path)
                audio_path = converted_path

            with self._inference_lock:
                raw_segments, info = model.transcribe(
                    str(audio_path),
                    language=language,
                    task="transcribe",
                    vad_filter=True,
                    beam_size=5,
                )
                raw_segment_list = list(raw_segments)
                segments = tuple(
                    SpeechSegment(
                        start=float(segment.start),
                        end=float(segment.end),
                        text=segment.text.strip(),
                    )
                    for segment in raw_segment_list
                    if segment.text.strip()
                )

            text = " ".join(segment.text for segment in segments).strip()
            confidence_values = [
                math.exp(segment.avg_logprob)
                for segment in raw_segment_list
                if getattr(segment, "avg_logprob", None) is not None
            ]
            confidence = (
                min(1.0, max(0.0, sum(confidence_values) / len(confidence_values)))
                if confidence_values
                else None
            )
            return SpeechResult(
                text=text,
                language=getattr(info, "language", None),
                segments=segments,
                confidence=confidence,
                start_seconds=segments[0].start if segments else None,
                end_seconds=segments[-1].end if segments else None,
            )
        except SpeechServiceError:
            raise
        except Exception as error:
            logger.exception("Speech recognition failed while processing uploaded audio.")
            raise SpeechServiceError(f"Speech recognition failed: {error}") from error
        finally:
            if source_path is not None:
                source_path.unlink(missing_ok=True)
            if converted_path is not None:
                converted_path.unlink(missing_ok=True)

    async def transcribe(
        self,
        audio: bytes,
        audio_format: str = "webm",
        language: str | None = None,
    ) -> SpeechResult:
        return await asyncio.to_thread(self._transcribe_sync, audio, audio_format, language)

    def _transcribe_pcm_sync(self, audio: bytes, language: str | None) -> SpeechResult:
        if not audio or len(audio) % 2:
            raise SpeechServiceError("Received an empty or malformed PCM audio buffer.")

        model = self._load_model()
        samples = np.frombuffer(audio, dtype=np.int16).astype(np.float32) / 32768.0
        try:
            with self._inference_lock:
                raw_segments, info = model.transcribe(
                    samples,
                    language=language,
                    task="transcribe",
                    vad_filter=True,
                    vad_parameters={"min_silence_duration_ms": 500},
                    beam_size=1,
                    condition_on_previous_text=False,
                )
                raw_segment_list = list(raw_segments)
                accepted_raw_segments = [
                    segment
                    for segment in raw_segment_list
                    if segment.text.strip()
                    and getattr(segment, "avg_logprob", 0.0) >= -1.0
                    and getattr(segment, "no_speech_prob", 0.0) <= 0.6
                ]
                segments = tuple(
                    SpeechSegment(
                        start=float(segment.start),
                        end=float(segment.end),
                        text=segment.text.strip(),
                    )
                    for segment in accepted_raw_segments
                )
            text = " ".join(segment.text for segment in segments).strip()
            return SpeechResult(
                text=text,
                language=getattr(info, "language", language),
                segments=segments,
                confidence=(
                    min(
                        1.0,
                        max(
                            0.0,
                            sum(math.exp(segment.avg_logprob) for segment in accepted_raw_segments)
                            / len(accepted_raw_segments),
                        ),
                    )
                    if accepted_raw_segments
                    else None
                ),
                start_seconds=segments[0].start if segments else None,
                end_seconds=segments[-1].end if segments else None,
            )
        except SpeechServiceError:
            raise
        except Exception as error:
            logger.exception("Live PCM speech recognition failed.")
            raise SpeechServiceError(f"Live speech recognition failed: {error}") from error

    async def transcribe_pcm(self, audio: bytes, language: str | None) -> SpeechResult:
        return await asyncio.to_thread(self._transcribe_pcm_sync, audio, language)


class DisabledSpeechService:
    async def initialize(self) -> None:
        return None

    async def transcribe(
        self,
        audio: bytes,
        audio_format: str = "webm",
        language: str | None = None,
    ) -> SpeechResult:
        raise SpeechServiceError("Speech recognition is disabled. Set SPEECH_ENABLED=true to enable Whisper.")

    async def transcribe_pcm(self, audio: bytes, language: str | None) -> SpeechResult:
        raise SpeechServiceError("Speech recognition is disabled. Set SPEECH_ENABLED=true to enable Whisper.")


@lru_cache
def get_speech_service() -> SpeechService:
    if not settings.speech_enabled:
        return DisabledSpeechService()
    return WhisperSpeechService()
