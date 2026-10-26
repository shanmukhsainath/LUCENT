class MeetingWebRTCService {
  constructor({ localUserId = '', iceServers = [], onRemoteStream, onRemoteStreamRemoved, onConnectionState, onIceCandidate, onRenegotiate, onError }) {
    this.localUserId = localUserId;
    this.localStream = null;
    this.iceServers = iceServers.length ? iceServers : [{ urls: 'stun:stun.l.google.com:19302' }];
    this.callbacks = { onRemoteStream, onRemoteStreamRemoved, onConnectionState, onIceCandidate, onRenegotiate, onError };
    this.peers = new Map();
    this.pendingIceCandidates = new Map();
  }

  setLocalStream(stream) {
    this.localStream = stream;
    return Promise.all([...this.peers.values()].map((peer) => this.syncTracks(peer)));
  }

  async syncTracks(peer) {
    const tracks = this.localStream?.getTracks() || [];
    for (const track of tracks) {
      const sender = peer.connection.getSenders().find((item) => item.track?.kind === track.kind);
      if (sender) {
        if (sender.track?.id !== track.id) await sender.replaceTrack(track);
      } else {
        peer.connection.addTrack(track, this.localStream);
        peer.needsNegotiation = true;
      }
    }
    if (peer.needsNegotiation) await this.queueNegotiation(peer, true);
  }

  publishTrack(track, stream) {
    if (!track) return Promise.resolve();
    this.localStream = stream || this.localStream;
    return Promise.all([...this.peers.values()].map(async (peer) => {
      const sender = peer.connection.getSenders().find((item) => item.track?.kind === track.kind);
      if (sender) await sender.replaceTrack(track);
      else {
        peer.connection.addTrack(track, this.localStream);
        peer.needsNegotiation = true;
        await this.queueNegotiation(peer, false);
      }
    }));
  }

  unpublishTrack(kind) {
    for (const peer of this.peers.values()) {
      const sender = peer.connection.getSenders().find((item) => item.track?.kind === kind);
      if (sender) sender.replaceTrack(null).catch(() => {});
    }
  }

  setTrackEnabled(kind, enabled) {
    this.localStream?.getTracks().filter((track) => track.kind === kind).forEach((track) => { track.enabled = enabled; });
  }

  async createPeer(userId) {
    if (!userId) throw new Error('A participant ID is required.');
    if (this.peers.has(userId)) return this.peers.get(userId);
    const connection = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = {
      connection,
      userId,
      polite: this.localUserId < userId,
      makingOffer: false,
      ignoreOffer: false,
      needsNegotiation: false,
      negotiationQueue: Promise.resolve(),
      restartAttempts: 0,
      remoteStreams: new Map(),
      restartTimer: null,
    };
    this.peers.set(userId, peer);
    for (const track of this.localStream?.getTracks() || []) connection.addTrack(track, this.localStream);
    connection.addEventListener('track', (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      peer.remoteStreams.set(event.track.kind, stream);
      this.callbacks.onRemoteStream?.(userId, stream, event.track.kind);
    });
    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate) this.callbacks.onIceCandidate?.(userId, event.candidate);
    });
    connection.addEventListener('negotiationneeded', () => this.queueNegotiation(peer, true));
    const reportState = () => {
      const state = connection.connectionState === 'connected' && connection.iceConnectionState === 'connected'
        ? 'connected'
        : connection.connectionState === 'failed' ? 'failed'
          : connection.connectionState === 'disconnected' || connection.iceConnectionState === 'disconnected' ? 'unstable' : 'connecting';
      this.callbacks.onConnectionState?.(userId, state);
      if (state === 'unstable') {
        window.clearTimeout(peer.restartTimer);
        peer.restartTimer = window.setTimeout(() => this.restartConnection(userId), 5000);
      }
      if (state === 'failed') this.restartConnection(userId);
    };
    connection.addEventListener('connectionstatechange', reportState);
    connection.addEventListener('iceconnectionstatechange', reportState);
    connection.addEventListener('icecandidateerror', () => this.callbacks.onError?.('Unable to establish a network path. TURN may be required.', userId));
    return peer;
  }

  queueNegotiation(peer, shouldOffer) {
    peer.negotiationQueue = peer.negotiationQueue.then(async () => {
      if (!shouldOffer || peer.connection.signalingState !== 'stable') return;
      peer.makingOffer = true;
      try {
        const offer = await peer.connection.createOffer();
        await peer.connection.setLocalDescription(offer);
        this.callbacks.onRenegotiate?.(peer.userId, peer.connection.localDescription);
      } finally {
        peer.makingOffer = false;
        peer.needsNegotiation = false;
      }
    }).catch((error) => this.callbacks.onError?.(`Negotiation failed: ${error.message}`, peer.userId));
    return peer.negotiationQueue;
  }

  async offer(userId) {
    const peer = await this.createPeer(userId);
    peer.needsNegotiation = true;
    await this.queueNegotiation(peer, true);
  }

  async handleSignal(message) {
    const payload = message.payload || {};
    const userId = payload.sender_user_id;
    if (!userId) return;
    const peer = await this.createPeer(userId);
    const connection = peer.connection;
    const offerCollision = message.type === 'OFFER' && (peer.makingOffer || connection.signalingState !== 'stable');
    peer.ignoreOffer = !peer.polite && offerCollision;
    if (peer.ignoreOffer) return;
    if (message.type === 'OFFER') {
      if (offerCollision) await connection.setLocalDescription({ type: 'rollback' });
      await connection.setRemoteDescription(payload.description);
      for (const candidate of this.pendingIceCandidates.get(userId) || []) await connection.addIceCandidate(candidate);
      this.pendingIceCandidates.delete(userId);
      const answer = await connection.createAnswer();
      await connection.setLocalDescription(answer);
      this.signaling?.sendAnswer?.(userId, connection.localDescription);
    } else if (message.type === 'ANSWER') {
      await connection.setRemoteDescription(payload.description);
    } else if (message.type === 'ICE_CANDIDATE') {
      if (!connection.remoteDescription) {
        const pending = this.pendingIceCandidates.get(userId) || [];
        pending.push(payload.candidate);
        this.pendingIceCandidates.set(userId, pending);
      } else {
        await connection.addIceCandidate(payload.candidate);
      }
    }
  }

  async restartConnection(userId) {
    const peer = this.peers.get(userId);
    if (!peer || peer.restartAttempts >= 3) {
      this.callbacks.onError?.('Connection failed. Use Reconnect on the participant tile.', userId);
      this.callbacks.onConnectionState?.(userId, 'failed');
      return;
    }
    peer.restartAttempts += 1;
    if (peer.connection.connectionState !== 'closed') {
      try {
        const offer = await peer.connection.createOffer({ iceRestart: true });
        await peer.connection.setLocalDescription(offer);
        this.callbacks.onRenegotiate?.(userId, peer.connection.localDescription);
        return;
      } catch {}
    }
    this.removePeer(userId);
    await this.createPeer(userId);
    await this.offer(userId);
  }

  getParticipantMedia(userId) { return this.peers.get(userId)?.remoteStreams || null; }
  getStats(userId) { return this.peers.get(userId)?.connection.getStats() || Promise.resolve(null); }
  removePeer(userId) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    window.clearTimeout(peer.restartTimer);
    peer.connection.close();
    this.peers.delete(userId);
    this.pendingIceCandidates.delete(userId);
    this.callbacks.onRemoteStreamRemoved?.(userId);
  }
  close() { [...this.peers.keys()].forEach((userId) => this.removePeer(userId)); }
}

window.MeetingWebRTCService = MeetingWebRTCService;
