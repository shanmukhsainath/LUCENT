import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass

import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.database.config import settings
from app.services.speech_service import SpeechServiceError, get_speech_service
from app.services.translation_service import (
    NLLB_LANGUAGES,
    TranslationServiceError,
    get_translation_service,
)

logger = logging.getLogger(__name__)
live_translation_router = APIRouter(tags=["live translation"])

SAMPLE_RATE = 16_000
SILENCE_SECONDS = 0.6
MAX_SEGMENT_SECONDS = 6.0
INTERIM_INTERVAL_SECONDS = 1.5
MAX_PENDING_JOBS = 4
MAX_CHUNK_BYTES = 64_000
SILENCE_RMS_THRESHOLD = 320


@dataclass(frozen=True)
class CaptionJob:
    caption_id: int
    audio: bytes
    final: bool


@live_translation_router.websocket("/ws/live")
async def live_translation_websocket(websocket: WebSocket) -> None:
    source = websocket.query_params.get("src", "en")
    target = websocket.query_params.get("tgt", "ml")
    origin = websocket.headers.get("origin")
    if source not in NLLB_LANGUAGES or target not in NLLB_LANGUAGES:
        await websocket.close(code=1008, reason="Unsupported source or caption language")
        return
    if origin and origin not in settings.cors_origins:
        await websocket.close(code=1008, reason="Origin is not allowed")
        return

    try:
        speech_service = get_speech_service()
        translation_service = get_translation_service()
    except TranslationServiceError as error:
        await websocket.close(code=1011, reason=str(error)[:120])
        return
    if not settings.speech_enabled:
        await websocket.close(code=1011, reason="Live speech recognition is disabled")
        return

    await websocket.accept()
    pending_jobs: deque[CaptionJob] = deque()
    job_ready = asyncio.Event()
    job_space = asyncio.Event()
    job_space.set()
    segment_buffer = bytearray()
    segment_has_voice = False
    silent_duration = 0.0
    last_interim_at = time.monotonic()
    next_caption_id = 1
    is_connected = True

    async def queue_job(job: CaptionJob) -> None:
        if not job.final:
            retained_jobs = [
                pending for pending in pending_jobs
                if pending.final or pending.caption_id != job.caption_id
            ]
            pending_jobs.clear()
            pending_jobs.extend(retained_jobs)
            if len(pending_jobs) >= MAX_PENDING_JOBS:
                return
        else:
            retained_jobs = [pending for pending in pending_jobs if pending.final]
            pending_jobs.clear()
            pending_jobs.extend(retained_jobs)
            while len(pending_jobs) >= MAX_PENDING_JOBS and is_connected:
                job_space.clear()
                await job_space.wait()
        if not is_connected:
            return
        pending_jobs.append(job)
        job_ready.set()

    async def caption_worker() -> None:
        nonlocal is_connected
        while is_connected or pending_jobs:
            if not pending_jobs:
                job_ready.clear()
                await job_ready.wait()
                continue
            job = pending_jobs.popleft()
            job_space.set()
            try:
                result = await speech_service.transcribe_pcm(job.audio, source)
                original = result.text.strip()
                if not original:
                    continue
                translated = await translation_service.translate(original, source, target)
                if is_connected:
                    await websocket.send_json(
                        {
                            "type": "caption",
                            "id": job.caption_id,
                            "original": original,
                            "translated": translated,
                            "final": job.final,
                        }
                    )
            except (SpeechServiceError, TranslationServiceError) as error:
                if is_connected:
                    await websocket.send_json({"type": "error", "message": str(error)})
            except WebSocketDisconnect:
                is_connected = False
                job_ready.set()
                job_space.set()
            except Exception:
                logger.exception("Unexpected live translation failure.")
                if is_connected:
                    await websocket.send_json(
                        {"type": "error", "message": "Live translation failed unexpectedly."}
                    )

    worker = asyncio.create_task(caption_worker())
    try:
        await websocket.send_json({"type": "status", "status": "listening"})
        while True:
            audio = await websocket.receive_bytes()
            if not audio or len(audio) > MAX_CHUNK_BYTES or len(audio) % 2:
                await websocket.send_json(
                    {"type": "error", "message": "Expected a small 16 kHz mono PCM int16 chunk."}
                )
                continue

            samples = np.frombuffer(audio, dtype=np.int16)
            chunk_duration = len(samples) / SAMPLE_RATE
            segment_buffer.extend(audio)
            rms = float(np.sqrt(np.mean(np.square(samples.astype(np.float32))))) if samples.size else 0
            if rms >= SILENCE_RMS_THRESHOLD:
                segment_has_voice = True
                silent_duration = 0.0
            else:
                silent_duration += chunk_duration

            segment_duration = len(segment_buffer) / (SAMPLE_RATE * 2)
            now = time.monotonic()
            should_finalize = segment_duration >= MAX_SEGMENT_SECONDS or (
                segment_has_voice and silent_duration >= SILENCE_SECONDS
            )
            if should_finalize:
                if segment_has_voice:
                    await queue_job(CaptionJob(next_caption_id, bytes(segment_buffer), True))
                    next_caption_id += 1
                segment_buffer.clear()
                segment_has_voice = False
                silent_duration = 0.0
                last_interim_at = now
            elif (
                segment_has_voice
                and segment_duration >= INTERIM_INTERVAL_SECONDS
                and now - last_interim_at >= INTERIM_INTERVAL_SECONDS
            ):
                await queue_job(CaptionJob(next_caption_id, bytes(segment_buffer), False))
                last_interim_at = now
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.exception("Live translation WebSocket failed.")
        if websocket.client_state.name == "CONNECTED":
            await websocket.close(code=1011, reason="Live translation failed")
    finally:
        is_connected = False
        job_ready.set()
        job_space.set()
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)
