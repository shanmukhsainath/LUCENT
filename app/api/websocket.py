import json
import asyncio
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from uuid import UUID

import numpy as np
import jwt
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
from app.database.session import SessionLocal, get_db
from app.models import ChatMessage, Meeting, MeetingSettings, Participant, ParticipantRole, Transcript, User
from app.realtime.manager import manager
from app.services.speech_service import SpeechServiceError, get_speech_service
websocket_router = APIRouter(tags=["realtime"])

SAMPLE_RATE = 16_000
SILENCE_SECONDS = 0.6
MAX_SEGMENT_SECONDS = 6.0
INTERIM_INTERVAL_SECONDS = 1.25
FIRST_INTERIM_SECONDS = 1.25
INTERIM_SILENCE_PADDING_SECONDS = 0.75
MAX_PENDING_TRANSCRIPT_JOBS = 4
MAX_AUDIO_CHUNK_BYTES = 64_000
MIN_SPEECH_RMS = 250


@dataclass(frozen=True)
class TranscriptJob:
    utterance_id: int
    audio_epoch: int
    audio: bytes
    final: bool


def authenticated_user_from_token(token: str, db: Session) -> User | None:
    try:
        user_id = decode_access_token(token)
    except (jwt.InvalidTokenError, ValueError, TypeError):
        return None
    user = db.get(User, user_id)
    return user if user and user.is_active else None


def user_can_access_meeting(meeting_id: UUID, user_id: UUID, db: Session) -> bool:
    return db.scalar(
        select(Participant.id).where(
            Participant.meeting_id == meeting_id,
            Participant.user_id == user_id,
            Participant.left_at.is_(None),
        )
    ) is not None


def user_label(user: User) -> dict[str, str]:
    return {"user_id": str(user.id), "name": user.name}


def participant_presence(meeting_id: UUID, user_id: UUID, db: Session) -> dict:
    user = db.get(User, user_id)
    role = participant_role(meeting_id, user_id, db)
    state = manager.get_user_media_state(meeting_id, user_id)
    return {
        **user_label(user),
        "audio_enabled": bool(state and state.audio_enabled),
        "video_enabled": bool(state and state.video_enabled),
        "role": role.value if role else None,
    }


def participant_role(meeting_id: UUID, user_id: UUID, db: Session) -> ParticipantRole | None:
    return db.scalar(
        select(Participant.role).where(
            Participant.meeting_id == meeting_id,
            Participant.user_id == user_id,
            Participant.left_at.is_(None),
        )
    )


def meeting_settings(meeting_id: UUID, db: Session) -> MeetingSettings | None:
    meeting = db.get(Meeting, meeting_id)
    if meeting is None:
        return None
    settings = db.scalar(select(MeetingSettings).where(MeetingSettings.meeting_id == meeting_id))
    if settings is None:
        settings = MeetingSettings(meeting_id=meeting_id)
        db.add(settings)
        db.commit()
    else:
        db.refresh(settings)
    return settings


def state_satisfies_settings(settings: MeetingSettings, audio_enabled: bool, video_enabled: bool) -> bool:
    return (
        (not settings.camera_required or video_enabled)
        and (not settings.microphone_required or audio_enabled)
    )


@websocket_router.websocket("/ws/meetings/{meeting_id}")
async def meeting_websocket(websocket: WebSocket, meeting_id: UUID) -> None:
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4401, reason="Authentication required")
        return

    db = next(get_db())
    user = authenticated_user_from_token(token, db)
    if user is None or not user_can_access_meeting(meeting_id, user.id, db):
        db.close()
        await websocket.close(code=4403, reason="Meeting access denied")
        return

    meeting = db.get(Meeting, meeting_id)
    role = participant_role(meeting_id, user.id, db)
    settings = meeting_settings(meeting_id, db)
    if meeting is None or settings is None or role is None:
        db.close()
        await websocket.close(code=4403, reason="Meeting access denied")
        return
    exempt = role in {ParticipantRole.host, ParticipantRole.viewer}
    admitted = exempt or state_satisfies_settings(settings, False, False)
    existing_users = [connected_user_id for connected_user_id in manager.connected_users(meeting_id) if connected_user_id != user.id]
    await manager.connect(meeting_id, user.id, websocket, admitted=admitted)
    await websocket.send_json({"type": "MEETING_SETTINGS_UPDATED", "payload": {
        "camera_required": settings.camera_required,
        "microphone_required": settings.microphone_required,
        "allow_camera_toggle": settings.allow_camera_toggle,
        "allow_microphone_toggle": settings.allow_microphone_toggle,
    }})
    if admitted:
        await manager.broadcast(
            meeting_id,
            {"type": "PARTICIPANT_JOINED", "payload": {**participant_presence(meeting_id, user.id, db), "at": datetime.now(timezone.utc).isoformat()}},
            exclude=websocket,
        )
    await websocket.send_json(
        {
            "type": "PARTICIPANT_ROSTER",
            "payload": {"participants": [participant_presence(meeting_id, connected_user_id, db) for connected_user_id in existing_users]},
        }
    )
    speech_service = get_speech_service()
    audio_buffer = bytearray()
    segment_has_voice = False
    silent_duration = 0.0
    noise_rms = 100.0
    utterance_id = 0
    audio_epoch = 0
    last_interim_duration = 0.0
    pending_jobs: deque[TranscriptJob] = deque()
    job_ready = asyncio.Event()
    job_space = asyncio.Event()
    job_space.set()
    worker_db = SessionLocal()
    is_connected = True
    next_sequence = (db.scalar(
        select(func.coalesce(func.max(Transcript.sequence_number), -1) + 1).where(Transcript.meeting_id == meeting_id)
    ) or 0)

    async def reset_audio_buffer() -> None:
        nonlocal audio_epoch, segment_has_voice, silent_duration, last_interim_duration
        discarded_utterance_id = utterance_id or None
        audio_epoch += 1
        audio_buffer.clear()
        segment_has_voice = False
        silent_duration = 0.0
        last_interim_duration = 0.0
        pending_jobs.clear()
        job_space.set()
        job_ready.set()
        if discarded_utterance_id is not None:
            message = {
                "type": "TRANSCRIPT_DISCARDED",
                "payload": {
                    "utterance_id": discarded_utterance_id,
                    "speaker_id": str(user.id),
                },
            }
            for participant_id in manager.connected_users(meeting_id):
                if participant_id == user.id:
                    continue
                if participant_role(meeting_id, participant_id, db) not in {None, ParticipantRole.host}:
                    await manager.send_to_user(meeting_id, participant_id, message)

    async def queue_transcription(job: TranscriptJob) -> None:
        if not job.final:
            retained_jobs = [
                pending for pending in pending_jobs
                if pending.final or pending.utterance_id != job.utterance_id
            ]
            pending_jobs.clear()
            pending_jobs.extend(retained_jobs)
            if len(pending_jobs) >= MAX_PENDING_TRANSCRIPT_JOBS:
                return
        else:
            latest_interim = next(
                (
                    pending for pending in reversed(pending_jobs)
                    if not pending.final and pending.utterance_id == job.utterance_id
                ),
                None,
            )
            pending_jobs_copy = [pending for pending in pending_jobs if pending.final]
            pending_jobs.clear()
            pending_jobs.extend(pending_jobs_copy)
            if latest_interim and len(pending_jobs) < MAX_PENDING_TRANSCRIPT_JOBS - 1:
                pending_jobs.append(latest_interim)
            while len(pending_jobs) >= MAX_PENDING_TRANSCRIPT_JOBS and is_connected:
                job_space.clear()
                await job_space.wait()
        if not is_connected or job.audio_epoch != audio_epoch:
            return
        pending_jobs.append(job)
        job_ready.set()

    async def transcript_worker() -> None:
        nonlocal next_sequence
        try:
            while is_connected or pending_jobs:
                if not pending_jobs:
                    job_ready.clear()
                    await job_ready.wait()
                    continue
                job = pending_jobs.popleft()
                job_space.set()
                if job.audio_epoch != audio_epoch:
                    continue
                try:
                    result = await speech_service.transcribe_pcm(job.audio, language=None)
                except SpeechServiceError as error:
                    if is_connected and job.audio_epoch == audio_epoch:
                        await manager.send_error(websocket, "SPEECH_SERVICE_ERROR", str(error))
                    continue
                text = result.text.strip()
                if not text and job.final and is_connected and job.audio_epoch == audio_epoch:
                    message = {
                        "type": "TRANSCRIPT_DISCARDED",
                        "payload": {
                            "utterance_id": job.utterance_id,
                            "speaker_id": str(user.id),
                        },
                    }
                    for participant_id in manager.connected_users(meeting_id):
                        if participant_role(meeting_id, participant_id, worker_db) not in {None, ParticipantRole.host}:
                            await manager.send_to_user(meeting_id, participant_id, message)
                if (
                    not text
                    or not is_connected
                    or job.audio_epoch != audio_epoch
                ):
                    continue

                now = datetime.now(timezone.utc)
                payload = {
                    "utterance_id": job.utterance_id,
                    "sequence_number": next_sequence,
                    "speaker": user.name,
                    "speaker_id": str(user.id),
                    "text": text,
                    "timestamp": now.isoformat(),
                    "language": result.language or user.preferred_language,
                    "confidence": result.confidence,
                }
                if not job.final:
                    for participant_id in manager.connected_users(meeting_id):
                        if participant_role(meeting_id, participant_id, worker_db) not in {
                            None,
                            ParticipantRole.host,
                        }:
                            await manager.send_to_user(
                                meeting_id,
                                participant_id,
                                {"type": "TRANSCRIPT_INTERIM", "payload": payload},
                            )
                    continue

                duration = result.end_seconds or 0
                transcript = Transcript(
                    meeting_id=meeting_id,
                    speaker_id=user.id,
                    content=text,
                    language=result.language or user.preferred_language,
                    sequence_number=next_sequence,
                    started_at=now - timedelta(seconds=duration),
                    ended_at=now,
                    confidence=result.confidence,
                )
                next_sequence += 1
                worker_db.add(transcript)
                worker_db.commit()
                payload.update({
                    "transcript_id": str(transcript.id),
                    "timestamp": now.isoformat(),
                    "confidence": result.confidence,
                })
                message = {
                    "type": "TRANSCRIPT",
                    "payload": payload,
                    "sender": user_label(user),
                    "at": now.isoformat(),
                }
                for participant_id in manager.connected_users(meeting_id):
                    if participant_role(meeting_id, participant_id, worker_db) not in {None, ParticipantRole.host}:
                        await manager.send_to_user(meeting_id, participant_id, message)
        finally:
            worker_db.close()

    async def finalize_audio_segment() -> None:
        nonlocal segment_has_voice, silent_duration, last_interim_duration
        if segment_has_voice and audio_buffer:
            await queue_transcription(
                TranscriptJob(utterance_id, audio_epoch, bytes(audio_buffer), True)
            )
        audio_buffer.clear()
        segment_has_voice = False
        silent_duration = 0.0
        last_interim_duration = 0.0

    async def process_audio_chunk(audio: bytes) -> None:
        nonlocal segment_has_voice, silent_duration, noise_rms, utterance_id, last_interim_duration
        state = manager.get_media_state(websocket)
        if state is None or not state.audio_enabled:
            await reset_audio_buffer()
            return
        if not audio or len(audio) % 2 or len(audio) > MAX_AUDIO_CHUNK_BYTES:
            await manager.send_error(websocket, "INVALID_AUDIO", "Expected 16 kHz mono PCM int16 audio.")
            return
        samples = np.frombuffer(audio, dtype=np.int16)
        if not samples.size:
            return
        chunk_duration = len(samples) / SAMPLE_RATE
        rms = float(np.sqrt(np.mean(np.square(samples.astype(np.float32)))))
        threshold = max(MIN_SPEECH_RMS, noise_rms * 2.5)
        if rms >= threshold:
            if not segment_has_voice:
                utterance_id += 1
                last_interim_duration = 0.0
            segment_has_voice = True
            silent_duration = 0.0
        else:
            noise_rms = (noise_rms * 0.95) + (rms * 0.05)
            if not segment_has_voice:
                return
            silent_duration += chunk_duration

        audio_buffer.extend(audio)
        segment_duration = len(audio_buffer) / (SAMPLE_RATE * 2)
        if segment_duration >= MAX_SEGMENT_SECONDS or silent_duration >= SILENCE_SECONDS:
            await finalize_audio_segment()
            return
        if (
            segment_duration >= FIRST_INTERIM_SECONDS
            and segment_duration - last_interim_duration >= INTERIM_INTERVAL_SECONDS
        ):
            last_interim_duration = segment_duration
            interim_audio = bytes(audio_buffer) + bytes(
                round(SAMPLE_RATE * INTERIM_SILENCE_PADDING_SECONDS) * 2
            )
            await queue_transcription(
                TranscriptJob(utterance_id, audio_epoch, interim_audio, False)
            )

    async def handle_audio_silence() -> None:
        if audio_buffer:
            await finalize_audio_segment()

    async def handle_audio_reset() -> None:
        await reset_audio_buffer()

    worker = asyncio.create_task(transcript_worker())
    try:
        while True:
            raw_message = await websocket.receive()
            if raw_message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()
            if raw_message.get("bytes") is not None:
                await process_audio_chunk(raw_message["bytes"])
                continue
            if raw_message.get("text") is None:
                continue
            try:
                message = json.loads(raw_message["text"])
            except ValueError:
                await manager.send_error(websocket, "INVALID_JSON", "Messages must be valid JSON.")
                continue

            message_type = message.get("type")
            if message_type == "AUDIO_SILENCE":
                state = manager.get_media_state(websocket)
                if state is not None and state.audio_enabled:
                    await handle_audio_silence()
                else:
                    await handle_audio_reset()
                continue
            if message_type == "AUDIO_RESET":
                await handle_audio_reset()
                continue
            if message_type == "PING":
                await websocket.send_json({"type": "PONG", "payload": {"at": datetime.now(timezone.utc).isoformat()}})
                continue
            if message_type in {"OFFER", "ANSWER", "ICE_CANDIDATE"}:
                sender_state = manager.get_media_state(websocket)
                if sender_state is None or not sender_state.admitted:
                    await manager.send_error(websocket, "NOT_ADMITTED", "Enable the required media before exchanging signaling.")
                    continue
                payload = message.get("payload") or {}
                target_user_id = payload.get("target_user_id")
                if not target_user_id:
                    await manager.send_error(websocket, "MISSING_TARGET", "A target participant is required.")
                    continue
                try:
                    target_id = UUID(target_user_id)
                except (ValueError, TypeError):
                    await manager.send_error(websocket, "INVALID_TARGET", "The target participant ID is invalid.")
                    continue
                if target_id == user.id or not user_can_access_meeting(meeting_id, target_id, db):
                    await manager.send_error(websocket, "INVALID_TARGET", "The target participant is not in this meeting.")
                    continue
                if not manager.is_admitted(meeting_id, target_id):
                    await manager.send_error(websocket, "NOT_ADMITTED", "The target participant has not enabled the required media.")
                    continue
                delivered = await manager.send_to_user(
                    meeting_id,
                    target_id,
                    {
                        "type": message_type,
                        "payload": {**payload, "sender_user_id": str(user.id), "sender_name": user.name},
                    },
                    admitted_only=True,
                )
                if not delivered:
                    await manager.send_error(websocket, "TARGET_UNAVAILABLE", "The target participant is not connected.")
                continue
            if message_type == "MEDIA_STATE":
                role = participant_role(meeting_id, user.id, db)
                if role == ParticipantRole.viewer:
                    await manager.send_error(websocket, "FORBIDDEN_MESSAGE", "Viewers cannot send media state.")
                    continue
                payload = message.get("payload") or {}
                if not isinstance(payload.get("audio_enabled"), bool) or not isinstance(payload.get("video_enabled"), bool):
                    await manager.send_error(websocket, "INVALID_MEDIA_STATE", "Media state must contain boolean audio_enabled and video_enabled values.")
                    continue
                state = manager.get_media_state(websocket)
                if state is None:
                    await manager.send_error(websocket, "NOT_ADMITTED", "This connection is not admitted.")
                    continue
                settings = meeting_settings(meeting_id, db)
                if settings is None:
                    await manager.send_error(websocket, "MEETING_UNAVAILABLE", "Meeting settings are unavailable.")
                    continue
                next_audio = payload["audio_enabled"]
                next_video = payload["video_enabled"]
                if role != ParticipantRole.host:
                    denied = (
                        (state.video_enabled and not next_video and not settings.allow_camera_toggle)
                        or (state.audio_enabled and not next_audio and not settings.allow_microphone_toggle)
                        or (settings.camera_required and not next_video)
                        or (settings.microphone_required and not next_audio)
                    )
                    if denied:
                        server_state = {
                            "audio_enabled": state.audio_enabled,
                            "video_enabled": state.video_enabled,
                            "user_id": str(user.id),
                        }
                        await manager.send_error(websocket, "MEDIA_TOGGLE_NOT_ALLOWED", "The current meeting settings do not allow that media change.")
                        await websocket.send_json({"type": "MEDIA_STATE_REJECTED", "payload": server_state})
                        continue
                was_admitted = state.admitted
                manager.update_media_state(
                    websocket,
                    admitted=(
                        True if was_admitted or role in {ParticipantRole.host, ParticipantRole.viewer}
                        or state_satisfies_settings(settings, next_audio, next_video) else False
                    ),
                    audio_enabled=next_audio,
                    video_enabled=next_video,
                )
                if not next_audio:
                    await reset_audio_buffer()
                if not was_admitted and state.admitted:
                    await manager.broadcast(
                        meeting_id,
                        {"type": "PARTICIPANT_JOINED", "payload": {**participant_presence(meeting_id, user.id, db), "at": datetime.now(timezone.utc).isoformat()}},
                        exclude=websocket,
                    )
                    admitted_roster = [connected_user_id for connected_user_id in manager.connected_users(meeting_id) if connected_user_id != user.id]
                    await websocket.send_json({"type": "PARTICIPANT_ROSTER", "payload": {
                        "participants": [participant_presence(meeting_id, connected_user_id, db) for connected_user_id in admitted_roster],
                    }})
                if not state.admitted:
                    continue
                await manager.broadcast(
                    meeting_id,
                    {
                        "type": message_type,
                        "payload": {
                            "audio_enabled": next_audio,
                            "video_enabled": next_video,
                            "user_id": str(user.id),
                        },
                        "sender": user_label(user),
                        "at": datetime.now(timezone.utc).isoformat(),
                    },
                    exclude=websocket,
                )
                continue
            if message_type == "REACTION":
                if participant_role(meeting_id, user.id, db) == ParticipantRole.viewer:
                    await manager.send_error(websocket, "FORBIDDEN_MESSAGE", "Viewers cannot send reactions.")
                    continue
                reaction = (message.get("payload") or {}).get("reaction")
                if reaction not in {"👍", "👏", "❤️", "🎉", "😂", "❓"}:
                    await manager.send_error(websocket, "INVALID_REACTION", "Unsupported reaction.")
                    continue
                await manager.broadcast(
                    meeting_id,
                    {
                        "type": "REACTION",
                        "payload": {"reaction": reaction},
                        "sender": user_label(user),
                        "at": datetime.now(timezone.utc).isoformat(),
                    },
                )
                continue
            if message_type == "CHAT_MESSAGE":
                content = (message.get("payload") or {}).get("content")
                if not isinstance(content, str):
                    await manager.send_error(websocket, "INVALID_CHAT_MESSAGE", "Chat content must be text.")
                    continue
                content = content.strip()
                if not content:
                    await manager.send_error(websocket, "INVALID_CHAT_MESSAGE", "Chat content cannot be empty.")
                    continue
                if len(content) > 2000:
                    await manager.send_error(websocket, "INVALID_CHAT_MESSAGE", "Chat content must be 2000 characters or fewer.")
                    continue
                chat_message = ChatMessage(meeting_id=meeting_id, sender_id=user.id, content=content)
                db.add(chat_message)
                db.commit()
                db.refresh(chat_message)
                await manager.broadcast(
                    meeting_id,
                    {
                        "type": "CHAT_MESSAGE",
                        "payload": {
                            "id": str(chat_message.id),
                            "meeting_id": str(meeting_id),
                            "sender_id": str(user.id),
                            "sender_name": user.name,
                            "content": content,
                            "created_at": chat_message.created_at.isoformat(),
                        },
                        "sender": user_label(user),
                        "at": chat_message.created_at.isoformat(),
                    },
                )
                continue
            if message_type in {"TRANSCRIPT", "TRANSLATION", "TASK_CREATED", "BOOKMARK", "NOTIFICATION"}:
                await manager.send_error(websocket, "FORBIDDEN_MESSAGE", f"Clients cannot send {message_type} messages.")
                continue
            if message_type == "MEETING_EVENT":
                payload = message.get("payload") or {}
                event_name = payload.get("name")
                allowed = event_name in {"question-created", "question-answered"}
                if event_name == "question-timer-started":
                    allowed = participant_role(meeting_id, user.id, db) == ParticipantRole.host
                if not allowed:
                    await manager.send_error(websocket, "FORBIDDEN_MESSAGE", "This meeting event is not allowed for your account.")
                    continue
                # Temporary allow-list until the server-authoritative event system is implemented.
                await manager.broadcast(
                    meeting_id,
                    {
                        "type": message_type,
                        "payload": message.get("payload", {}),
                        "sender": user_label(user),
                        "at": datetime.now(timezone.utc).isoformat(),
                    },
                )
                continue
            await manager.send_error(websocket, "UNKNOWN_MESSAGE_TYPE", f"Unsupported message type: {message_type}")
    except WebSocketDisconnect:
        pass
    finally:
        await reset_audio_buffer()
        is_connected = False
        job_ready.set()
        job_space.set()
        worker.cancel()
        try:
            await worker
        except asyncio.CancelledError:
            pass
        connection_state = manager.get_media_state(websocket)
        was_admitted = bool(connection_state and connection_state.admitted)
        was_connected = manager.disconnect(meeting_id, user.id, websocket)
        db.close()
        if was_connected and was_admitted:
            await manager.broadcast(
                meeting_id,
                {"type": "PARTICIPANT_LEFT", "payload": {**user_label(user), "at": datetime.now(timezone.utc).isoformat()}},
            )
