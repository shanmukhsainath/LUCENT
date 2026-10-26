from collections import defaultdict
from dataclasses import dataclass
from uuid import UUID

from fastapi import WebSocket


@dataclass
class ConnectionMediaState:
    admitted: bool
    audio_enabled: bool = False
    video_enabled: bool = False


class MeetingConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[UUID, dict[UUID, set[WebSocket]]] = defaultdict(lambda: defaultdict(set))
        self._states: dict[WebSocket, ConnectionMediaState] = {}

    async def connect(
        self,
        meeting_id: UUID,
        user_id: UUID,
        websocket: WebSocket,
        *,
        admitted: bool,
        audio_enabled: bool = False,
        video_enabled: bool = False,
    ) -> None:
        await websocket.accept()
        for older in list(self._connections.get(meeting_id, {}).get(user_id, set())):
            try:
                await older.close(code=4001, reason="Opened in another window")
            except Exception:
                pass
            self.disconnect(meeting_id, user_id, older)
        self._connections[meeting_id][user_id].add(websocket)
        self._states[websocket] = ConnectionMediaState(admitted, audio_enabled, video_enabled)

    def disconnect(self, meeting_id: UUID, user_id: UUID, websocket: WebSocket) -> bool:
        user_connections = self._connections.get(meeting_id, {}).get(user_id)
        if not user_connections:
            return False
        user_connections.discard(websocket)
        if not user_connections:
            self._connections[meeting_id].pop(user_id, None)
        if not self._connections.get(meeting_id):
            self._connections.pop(meeting_id, None)
        self._states.pop(websocket, None)
        return True

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

    async def send_to_user(
        self, meeting_id: UUID, user_id: UUID, message: dict, *, admitted_only: bool = False
    ) -> bool:
        connections = list(self._connections.get(meeting_id, {}).get(user_id, set()))
        delivered = False
        for websocket in connections:
            if admitted_only and not self._states.get(websocket, ConnectionMediaState(False)).admitted:
                continue
            try:
                await websocket.send_json(message)
                delivered = True
            except Exception:
                self.disconnect(meeting_id, user_id, websocket)
        return delivered

    async def close_user(self, meeting_id: UUID, user_id: UUID, code: int, reason: str) -> None:
        connections = list(self._connections.get(meeting_id, {}).get(user_id, set()))
        for websocket in connections:
            try:
                await websocket.close(code=code, reason=reason)
            except Exception:
                pass
            self.disconnect(meeting_id, user_id, websocket)

    async def close_meeting(self, meeting_id: UUID, code: int, reason: str) -> None:
        connections = [
            (user_id, websocket)
            for user_id, user_connections in self._connections.get(meeting_id, {}).items()
            for websocket in list(user_connections)
        ]
        for user_id, websocket in connections:
            try:
                await websocket.close(code=code, reason=reason)
            except Exception:
                pass
            self.disconnect(meeting_id, user_id, websocket)

    def get_media_state(self, websocket: WebSocket) -> ConnectionMediaState | None:
        return self._states.get(websocket)

    def update_media_state(
        self, websocket: WebSocket, *, admitted: bool | None = None, audio_enabled: bool, video_enabled: bool
    ) -> ConnectionMediaState | None:
        state = self._states.get(websocket)
        if state is None:
            return None
        if admitted is not None:
            state.admitted = admitted
        state.audio_enabled = audio_enabled
        state.video_enabled = video_enabled
        return state

    def is_admitted(self, meeting_id: UUID, user_id: UUID) -> bool:
        return any(
            self._states.get(websocket, ConnectionMediaState(False)).admitted
            for websocket in self._connections.get(meeting_id, {}).get(user_id, set())
        )

    def get_user_media_state(self, meeting_id: UUID, user_id: UUID) -> ConnectionMediaState | None:
        for websocket in self._connections.get(meeting_id, {}).get(user_id, set()):
            state = self._states.get(websocket)
            if state is not None and state.admitted:
                return state
        return None

    def connected_users(self, meeting_id: UUID) -> list[UUID]:
        return [
            user_id for user_id in self._connections.get(meeting_id, {})
            if self.is_admitted(meeting_id, user_id)
        ]

    async def send_error(self, websocket: WebSocket, code: str, message: str) -> None:
        await websocket.send_json({"type": "ERROR", "payload": {"code": code, "message": message}})


manager = MeetingConnectionManager()
