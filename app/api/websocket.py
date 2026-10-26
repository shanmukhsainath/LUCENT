import json
from datetime import datetime, timedelta, timezone
from uuid import UUID

import jwt
from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session

from app.core.security import decode_access_token
from app.database.session import get_db
from app.models import Meeting, MeetingSettings, Participant, ParticipantRole, Transcript, User
from app.realtime.manager import manager
from app.services.speech_service import SpeechServiceError, get_speech_service
websocket_router = APIRouter(tags=["realtime"])


def authenticated_user_from_token(token: str, db: Session) -> User | None:
    try:
        user_id = decode_access_token(token)
    except (jwt.InvalidTokenError, ValueError, TypeError):
        return None
    user = db.get(User, user_id)
    return user if user and user.is_active else None


def user_can_access_meeting(meeting_id: UUID, user_id: UUID, db: Session) -> bool:
    participant_access = exists(
        select(Participant.id).where(
            Participant.meeting_id == Meeting.id,
            Participant.user_id == user_id,
            Participant.left_at.is_(None),
        )
    )
    return db.scalar(
        select(Meeting.id).where(
            Meeting.id == meeting_id,
            or_(Meeting.created_by_id == user_id, participant_access),
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
    exempt = meeting.created_by_id == user.id or role == ParticipantRole.viewer
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
    max_audio_buffer_bytes = 2_000_000
    previous_transcript = ""
    next_sequence = (db.scalar(
        select(func.coalesce(func.max(Transcript.sequence_number), -1) + 1).where(Transcript.meeting_id == meeting_id)
    ) or 0)

    async def process_audio_chunk(audio: bytes) -> None:
        nonlocal previous_transcript, next_sequence
        if not audio:
            await manager.send_error(websocket, "EMPTY_AUDIO", "The audio chunk was empty.")
            return
        audio_buffer.extend(audio)
        if len(audio_buffer) > max_audio_buffer_bytes:
            audio_buffer.clear()
            await manager.send_error(
                websocket,
                "AUDIO_BUFFER_LIMIT",
                "Audio buffering exceeded the safe limit. Please restart the microphone.",
            )
            return
        # Whisper needs enough context to produce stable words; retain the buffer only in memory.
        if len(audio_buffer) < 32_000:
            return
        try:
            result = await speech_service.transcribe(bytes(audio_buffer), audio_format="webm")
        except SpeechServiceError as error:
            audio_buffer.clear()
            await manager.send_error(websocket, "SPEECH_SERVICE_ERROR", str(error))
            return
        audio_buffer.clear()
        text = result.text.strip()
        if not text or text == previous_transcript:
            return
        delta = text[len(previous_transcript):].strip() if previous_transcript and text.startswith(previous_transcript) else text
        previous_transcript = text
        if not delta:
            return
        now = datetime.now(timezone.utc)
        duration = result.end_seconds or 0
        transcript = Transcript(
            meeting_id=meeting_id,
            speaker_id=user.id,
            content=delta,
            language=result.language or user.preferred_language,
            sequence_number=next_sequence,
            started_at=now - timedelta(seconds=duration),
            ended_at=now,
            confidence=result.confidence,
        )
        next_sequence += 1
        db.add(transcript)
        db.commit()
        await manager.broadcast(
            meeting_id,
            {
                "type": "TRANSCRIPT",
                "payload": {
                    "transcript_id": str(transcript.id),
                    "speaker": user.name,
                    "speaker_id": str(user.id),
                    "text": delta,
                    "timestamp": now.isoformat(),
                    "language": transcript.language,
                    "confidence": result.confidence,
                },
                "sender": user_label(user),
                "at": now.isoformat(),
            },
        )

    try:
        while True:
            raw_message = await websocket.receive()
            if raw_message.get("type") == "websocket.disconnect":
                raise WebSocketDisconnect()
            if not user_can_access_meeting(meeting_id, user.id, db):
                await websocket.close(code=4403, reason="Meeting access revoked")
                break
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
                if not (meeting.created_by_id == user.id):
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
                        True if was_admitted or meeting.created_by_id == user.id or role == ParticipantRole.viewer
                        or state_satisfies_settings(settings, next_audio, next_video) else False
                    ),
                    audio_enabled=next_audio,
                    video_enabled=next_video,
                )
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
            if message_type in {"TRANSCRIPT", "TRANSLATION", "TASK_CREATED", "BOOKMARK", "NOTIFICATION"}:
                await manager.send_error(websocket, "FORBIDDEN_MESSAGE", f"Clients cannot send {message_type} messages.")
                continue
            if message_type == "MEETING_EVENT":
                payload = message.get("payload") or {}
                event_name = payload.get("name")
                allowed = event_name in {"question-created", "question-answered"}
                if event_name == "question-timer-started":
                    meeting = db.get(Meeting, meeting_id)
                    allowed = bool(meeting and meeting.created_by_id == user.id)
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
        was_connected = manager.disconnect(meeting_id, user.id, websocket)
        db.close()
        if was_connected:
            await manager.broadcast(
                meeting_id,
                {"type": "PARTICIPANT_LEFT", "payload": {**user_label(user), "at": datetime.now(timezone.utc).isoformat()}},
            )
