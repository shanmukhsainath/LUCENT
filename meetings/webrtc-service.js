class MeetingWebRTCService {
  constructor({ localStream = null, onRemoteStream, onRemoteStreamRemoved, onConnectionState, onIceCandidate, onError }) {
    this.localStream = localStream;
    this.onRemoteStream = onRemoteStream;
    this.onRemoteStreamRemoved = onRemoteStreamRemoved;
    this.onConnectionState = onConnectionState;
    this.onIceCandidate = onIceCandidate;
    this.onError = onError;
    this.peers = new Map();
    this.pendingIceCandidates = new Map();
    this.configuration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  }

  setLocalStream(stream) {
    this.localStream = stream;
    for (const peer of this.peers.values()) {
      const senders = peer.connection.getSenders();
      for (const track of stream?.getTracks() || []) {
        if (!senders.some((sender) => sender.track?.kind === track.kind)) peer.connection.addTrack(track, stream);
      }
    }
  }

  async createPeer(userId) {
    if (!userId) throw new Error('A participant ID is required to create a WebRTC peer.');
    if (this.peers.has(userId)) return this.peers.get(userId);
    const connection = new RTCPeerConnection(this.configuration);
    const peer = { connection, userId };
    this.peers.set(userId, peer);
    for (const track of this.localStream?.getTracks() || []) connection.addTrack(track, this.localStream);
    connection.addEventListener('track', (event) => {
      const [stream] = event.streams;
      if (stream) this.onRemoteStream?.(userId, stream);
    });
    connection.addEventListener('icecandidate', (event) => {
      if (event.candidate) this.onIceCandidate?.(userId, event.candidate);
    });
    connection.addEventListener('connectionstatechange', () => {
      this.onConnectionState?.(userId, connection.connectionState);
      if (['failed', 'closed'].includes(connection.connectionState)) this.removePeer(userId);
    });
    connection.addEventListener('icecandidateerror', () => {
      this.onError?.(`Unable to establish a network path to participant ${userId}.`);
    });
    return peer;
  }

  async createOffer(userId) {
    const peer = await this.createPeer(userId);
    const offer = await peer.connection.createOffer();
    await peer.connection.setLocalDescription(offer);
    return peer.connection.localDescription;
  }

  async acceptOffer(userId, offer) {
    const peer = await this.createPeer(userId);
    await peer.connection.setRemoteDescription(offer);
    for (const candidate of this.pendingIceCandidates.get(userId) || []) {
      await peer.connection.addIceCandidate(candidate);
    }
    this.pendingIceCandidates.delete(userId);
    const answer = await peer.connection.createAnswer();
    await peer.connection.setLocalDescription(answer);
    return peer.connection.localDescription;
  }

  async acceptAnswer(userId, answer) {
    const peer = this.peers.get(userId);
    if (!peer) throw new Error('Cannot accept an answer before creating a peer.');
    await peer.connection.setRemoteDescription(answer);
  }

  async addIceCandidate(userId, candidate) {
    const peer = this.peers.get(userId);
    if (!peer) throw new Error('Cannot add an ICE candidate before creating a peer.');
    if (!peer.connection.remoteDescription) {
      const pending = this.pendingIceCandidates.get(userId) || [];
      pending.push(candidate);
      this.pendingIceCandidates.set(userId, pending);
      return;
    }
    await peer.connection.addIceCandidate(candidate);
  }

  removePeer(userId) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.connection.close();
    this.peers.delete(userId);
    this.pendingIceCandidates.delete(userId);
    this.onRemoteStreamRemoved?.(userId);
  }

  close() {
    for (const userId of this.peers.keys()) this.removePeer(userId);
  }
}

window.MeetingWebRTCService = MeetingWebRTCService;
