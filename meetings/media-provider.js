/**
 * Media-provider contract used by the meeting workspace.
 *
 * A provider owns media transport and signaling. The workspace only supplies
 * authenticated signaling callbacks and reacts to provider callbacks.
 */
class MediaProvider {
  connect(_options) { throw new Error('Media provider connect() is not implemented.'); }
  disconnect() {}
  setLocalStream(_stream) {}
  publishTrack(_track, _stream, _kind) {}
  unpublishTrack(_kind) {}
  setAudioEnabled(_enabled) {}
  setVideoEnabled(_enabled) {}
  getParticipantMedia(_userId) { return null; }
  handleSignal(_message) {}
  restartConnection(_userId) {}
  getStats(_userId) { return Promise.resolve(null); }
}

function createMediaProvider(name = window.MEETMIND_MEDIA_PROVIDER || 'mesh') {
  if (name !== 'mesh') {
    throw new Error(`Unknown media provider "${name}". Configure MEETMIND_MEDIA_PROVIDER as "mesh".`);
  }
  if (!window.MeshMediaProvider) throw new Error('The mesh media provider failed to load.');
  return new window.MeshMediaProvider();
}

window.MediaProvider = MediaProvider;
window.createMediaProvider = createMediaProvider;
