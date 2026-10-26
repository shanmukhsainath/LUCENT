class MeshMediaProvider extends MediaProvider {
  connect({ selfUserId, signaling, iceServers, callbacks }) {
    this.selfUserId = selfUserId;
    this.signaling = signaling;
    this.callbacks = callbacks || {};
    this.service = new MeetingWebRTCService({
      localUserId: selfUserId,
      iceServers,
      onRemoteStream: (userId, stream, kind) => this.callbacks.onRemoteStream?.(userId, stream, kind),
      onRemoteStreamRemoved: (userId) => this.callbacks.onRemoteStreamRemoved?.(userId),
      onConnectionState: (userId, state) => this.callbacks.onConnectionState?.(userId, state),
      onIceCandidate: (userId, candidate) => signaling.sendIceCandidate(userId, candidate),
      onRenegotiate: (userId, offer) => signaling.sendOffer(userId, offer),
      onError: (message, userId) => this.callbacks.onError?.(message, userId),
    });
    this.service.signaling = signaling;
    this.service.setLocalStream(this.localStream);
  }

  disconnect() { this.service?.close(); }
  setLocalStream(stream) {
    this.localStream = stream;
    return this.service?.setLocalStream(stream);
  }
  publishTrack(track, stream, kind) {
    this.localStream = stream || this.localStream;
    return this.service?.publishTrack(track, this.localStream, kind);
  }
  unpublishTrack(kind) { return this.service?.unpublishTrack(kind); }
  setAudioEnabled(enabled) { return this.service?.setTrackEnabled('audio', enabled); }
  setVideoEnabled(enabled) { return this.service?.setTrackEnabled('video', enabled); }
  getParticipantMedia(userId) { return this.service?.getParticipantMedia(userId) || null; }
  handleSignal(message) { return this.service?.handleSignal(message); }
  restartConnection(userId) { return this.service?.restartConnection(userId); }
  getStats(userId) { return this.service?.getStats(userId); }
  offer(userId) { return this.service?.offer(userId); }
  removePeer(userId) { return this.service?.removePeer(userId); }
  participantIds() { return this.service ? [...this.service.peers.keys()] : []; }
}

window.MeshMediaProvider = MeshMediaProvider;
