import asyncio
import json
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Annotated
from uuid import UUID

import jwt
from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect, status
from sqlalchemy import exists, func, or_, select
from sqlalchemy.orm import Session

from app.api.dependencies import get_current_user
from app.core.security import decode_access_token
from app.database.session import get_db
from app.models import Meeting, Participant, Transcript, User
from app.services.speech_service import SpeechServiceError, get_speech_service
from app.schemas.websocket import DevelopmentEventRequest


class MeetingConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[UUID, dict[UUID, set[WebSocket]]] = defaultdict(lambda: defaultdict(set))

    async def connect(self, meeting_id: UUID, user_id: UUID, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections[meeting_id][user_id].add(websocket)

    def disconnect(self, meeting_id: UUID, user_id: UUID, websocket: WebSocket) -> None:
        user_connections = self._connections.get(meeting_id, {}).get(user_id)
        if not user_connections:
            return
        user_connections.discard(websocket)
        if not user_connections:
            self._connections[meeting_id].pop(user_id, None)
        if not self._connections.get(meeting_id):
            self._connections.pop(meeting_id, None)

    async def broadcast(self, meeting_id: UUID, message: dict, exclude: WebSocket | None = None) -> None:
        stale_connections: list[tuple[UUID, WebSocket]] = []
        for user_id, connections in list(self._connections.get(meeting_id, {}).items()):
            for websocket in list(connections):
                if websocket is exclude:
                    continue
                try:
                    await websocket.send_json(message)
                except Exception:
                    stale_connections.append((user_id, websocket))
        for user_id, websocket in stale_connections:
            self.disconnect(meeting_id, user_id, websocket)

    async def send_to_user(self, meeting_id: UUID, user_id: UUID, message: dict) -> bool:
        connections = list(self._connections.get(meeting_id, {}).get(user_id, set()))
        delivered = False
        for websocket in connections:
            try:
                await websocket.send_json(message)
                delivered = True
            except Exception:
                self.disconnect(meeting_id, user_id, websocket)
        return delivered

    def connected_users(self, meeting_id: UUID) -> list[UUID]:
        return list(self._connections.get(meeting_id, {}).keys())

    async def send_error(self, websocket: WebSocket, code: str, message: str) -> None:
        await websocket.send_json({"type": "ERROR", "payload": {"code": code, "message": message}})


manager = MeetingConnectionManager()
websocket_router = APIRouter(tags=["realtime"])
development_router = APIRouter(prefix="/api/meetings", tags=["realtime-development"])


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

    existing_users = [connected_user_id for connected_user_id in manager.connected_users(meeting_id) if connected_user_id != user.id]
    await manager.connect(meeting_id, user.id, websocket)
    await manager.broadcast(
        meeting_id,
        {"type": "PARTICIPANT_JOINED", "payload": {**user_label(user), "at": datetime.now(timezone.utc).isoformat()}},
        exclude=websocket,
    )
    roster_users = [db.get(User, connected_user_id) for connected_user_id in existing_users]
    await websocket.send_json(
        {
            "type": "PARTICIPANT_ROSTER",
            "payload": {"participants": [user_label(roster_user) for roster_user in roster_users if roster_user]},
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
                delivered = await manager.send_to_user(
                    meeting_id,
                    target_id,
                    {
                        "type": message_type,
                        "payload": {**payload, "sender_user_id": str(user.id), "sender_name": user.name},
                    },
                )
                if not delivered:
                    await manager.send_error(websocket, "TARGET_UNAVAILABLE", "The target participant is not connected.")
                continue
            if message_type == "MEDIA_STATE":
                await manager.broadcast(
                    meeting_id,
                    {"type": message_type, "payload": message.get("payload", {}), "sender": user_label(user)},
                    exclude=websocket,
                )
                continue
            if message_type == "REACTION":
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
            if message_type in {"TRANSCRIPT", "TRANSLATION", "MEETING_EVENT", "TASK_CREATED", "BOOKMARK", "NOTIFICATION"}:
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
        manager.disconnect(meeting_id, user.id, websocket)
        db.close()
        await manager.broadcast(
            meeting_id,
            {"type": "PARTICIPANT_LEFT", "payload": {**user_label(user), "at": datetime.now(timezone.utc).isoformat()}},
        )


@development_router.post("/{meeting_id}/events/test")
async def send_development_event(
    meeting_id: UUID,
    payload: DevelopmentEventRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict[str, str]:
    if not user_can_access_meeting(meeting_id, current_user.id, db):
        return {"status": "ignored"}
    await manager.broadcast(
        meeting_id,
        {
            "type": payload.type,
            "payload": payload.payload,
            "sender": user_label(current_user),
            "at": datetime.now(timezone.utc).isoformat(),
            "development": True,
        },
    )
    return {"status": "broadcast"}
