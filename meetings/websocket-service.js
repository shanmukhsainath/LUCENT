class MeetingWebSocketService {
  constructor({ meetingId, token, onMessage, onStatus, onError, reconnect = true }) {
    this.meetingId = meetingId;
    this.token = token;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.onError = onError;
    this.reconnect = reconnect;
    this.socket = null;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.reconnectAttempt = 0;
    this.closedByClient = false;
  }

  connect() {
    if (!this.meetingId || !this.token || this.socket?.readyState === WebSocket.OPEN) return;
    this.closedByClient = false;
    this.onStatus?.('connecting');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.MEETMIND_WS_URL || ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '8000' ? `${protocol}//${window.location.hostname}:8000` : `${protocol}//${window.location.host || 'localhost:8000'}`);
    this.socket = new WebSocket(`${host}/ws/meetings/${encodeURIComponent(this.meetingId)}?token=${encodeURIComponent(this.token)}`);
    this.socket.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.onStatus?.('connected');
      this.startHeartbeat();
    });
    this.socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(event.data);
        this.onMessage?.(message);
      } catch {
        this.onError?.('Received an invalid realtime message.');
      }
    });
    this.socket.addEventListener('error', () => this.onError?.('Realtime connection error.'));
    this.socket.addEventListener('close', (event) => {
      this.stopHeartbeat();
      this.socket = null;
      if (event.code === 4001) {
        this.closedByClient = true;
        this.reconnect = false;
        this.onError?.('This meeting was opened in another window. This tab has been disconnected.');
        return;
      }
      this.onStatus?.('disconnected');
      if (!this.closedByClient && this.reconnect && event.code !== 4401 && event.code !== 4403) this.scheduleReconnect();
    });
  }

  send(type, payload = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type, payload }));
    return true;
  }

  sendOffer(targetUserId, description) {
    return this.send('OFFER', { target_user_id: targetUserId, description });
  }

  sendAnswer(targetUserId, description) {
    return this.send('ANSWER', { target_user_id: targetUserId, description });
  }

  sendIceCandidate(targetUserId, candidate) {
    return this.send('ICE_CANDIDATE', {
      target_user_id: targetUserId,
      candidate: candidate?.toJSON ? candidate.toJSON() : candidate,
    });
  }

  sendMediaState(state) {
    return this.send('MEDIA_STATE', state);
  }

  sendAudioChunk(audioChunk) {
    if (this.socket?.readyState !== WebSocket.OPEN || !audioChunk?.byteLength) return false;
    this.socket.send(audioChunk);
    return true;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => this.send('PING'), 25000);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(1000 * (2 ** this.reconnectAttempt), 15000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  close() {
    this.closedByClient = true;
    this.reconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) window.clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, 'Client closed connection');
  }
}

window.MeetingWebSocketService = MeetingWebSocketService;
