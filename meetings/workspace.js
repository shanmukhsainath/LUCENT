const API_URL = window.MEETMIND_API_URL || ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '8000' ? `${window.location.protocol}//${window.location.hostname}:8000` : (window.location.protocol.startsWith('http') ? window.location.origin : 'http://localhost:8000'));
const TOKEN_KEY = 'meetmind_access_token';
const token = sessionStorage.getItem(TOKEN_KEY);
if (!token) window.location.replace('../login/index.html');
const meetingId = new URLSearchParams(window.location.search).get('id');
const currentUserId = (() => {
	try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return null; }
})();
const authHeaders = { Authorization: `Bearer ${token}` };
let realtime;
let microphoneStream;
let microphoneAudioContext;
let microphoneAudioWorklet;
let microphoneAudioSource;
let microphoneAudioGeneration = 0;
let microphoneAudioStarting = false;
const transcriptEntries = new Map();
const transcriptInterims = new Map();
let transcriptHistoryLoaded = false;
let transcriptHistoryPromise;
const liveCaptionState = {
	active: false,
	socket: null,
	stream: null,
	context: null,
	worklet: null,
	reconnectTimer: null,
	reconnectDelay: 1000,
	socketGeneration: 0,
	source: 'en',
	target: 'ml',
	captions: new Map(),
};
let cameraStream;
let cameraToggleInProgress = false;
let localStream = new MediaStream();
let mediaProvider;
const participantsState = new Map();
let iceServers = [];
let meetingState;
let questions = [];
let scheduledQuestions = [];
let scheduledQuestionRefresh;
let scheduledQuestionClock;
let tasks = [];
let topics = [];
let meetingTopics = [];
let chatMessages = [];
let chatUnreadCount = 0;
let questionTimer;
let questionTimerEndsAt;
const panelState = { active: null };

function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function initials(name = '') { return name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'MM'; }
function formatDate(value) { return value ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not scheduled'; }
function EmptyPanel({ icon, title, message, className = '' }) { return `<div class="empty-panel ${className}"><span class="empty-panel-icon">${icon}</span><h3>${title}</h3><p>${message}</p></div>`; }
function currentParticipant() { return meetingState?.participants?.find((participant) => participant.user_id === currentUserId); }
function meetingHostId() { return meetingState?.host_user_id || meetingState?.created_by; }
function isHost() { return currentParticipant()?.role === 'host' || meetingHostId() === currentUserId; }
function isMediaExempt() { return isHost() || currentParticipant()?.role === 'viewer'; }
function settingsRequireMedia() { return !isMediaExempt() && Boolean(meetingState?.settings?.camera_required || meetingState?.settings?.microphone_required); }
function localMediaState() { return { audio_enabled: localStream.getAudioTracks().some((track) => track.enabled && track.readyState === 'live'), video_enabled: localStream.getVideoTracks().some((track) => track.enabled && track.readyState === 'live') }; }
async function loadIceServers() {
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/ice-servers`, { headers: authHeaders });
	if (!response.ok) throw new Error('Unable to load media connection settings.');
	const data = await response.json();
	iceServers = data.ice_servers || [];
	if (!data.turn_configured) showToast('TURN is not configured; some networks may not connect.');
}
function setupWebRTC() {
	try {
		mediaProvider = window.createMediaProvider();
		mediaProvider.connect({
			meetingId,
			selfUserId: currentUserId,
			iceServers,
			signaling: {
				sendOffer: (userId, offer) => realtime?.sendOffer(userId, offer),
				sendAnswer: (userId, answer) => realtime?.sendAnswer(userId, answer),
				sendIceCandidate: (userId, candidate) => realtime?.sendIceCandidate(userId, candidate),
			},
			callbacks: {
				onRemoteStream: renderRemoteStream,
				onRemoteStreamRemoved: removeRemoteTile,
				onConnectionState: (userId, state) => {
					const current = participantsState.get(userId) || {};
					participantsState.set(userId, { ...current, connectionState: state });
					const row = document.querySelector(`.participant-row[data-user-id="${CSS.escape(userId)}"] .participant-connection`);
					if (row) row.className = `participant-connection ${state}`;
					const badge = document.querySelector(`#remoteTiles [data-user-id="${CSS.escape(userId)}"] .connection-badge span`);
					if (badge) badge.textContent = state === 'connected' ? 'Connected' : state === 'disconnected' || state === 'failed' ? 'Offline' : 'Connecting';
					if (state === 'connected') showToast('Participant media connected.');
				},
				onError: (message) => showToast(message),
			},
		});
		mediaProvider.setLocalStream(localStream);
	} catch (error) {
		showToast(error.message);
	}
}
function appendStreamMessage(targetId, payload, fallbackTitle) { const target = document.querySelector(`#${targetId}`); if (!target || !payload) return; const text = payload.text || payload.content || payload.translated_text; if (!text) return; if (target.querySelector('.empty-panel')) target.innerHTML = '<div class="stream-list"></div>'; const list = target.querySelector('.stream-list'); const item = document.createElement('article'); item.className = 'stream-item'; item.innerHTML = `<small>${escapeHtml(payload.speaker_name || fallbackTitle)}</small><p>${escapeHtml(text)}</p>`; list.appendChild(item); list.scrollTop = list.scrollHeight; }
async function negotiateWith(userId) {
	if (!mediaProvider || !userId) return;
	try {
		await mediaProvider.offer(userId);
	} catch (error) {
		showToast(`Unable to start participant connection: ${error.message}`);
	}
}
async function renegotiatePeers() {
	if (!mediaProvider) return;
	for (const userId of mediaProvider.participantIds?.() || []) await negotiateWith(userId);
}
async function handleSignalingMessage(message) {
	const payload = message.payload || {};
	const senderId = payload.sender_user_id;
	if (!senderId || !mediaProvider) return;
	try {
		await mediaProvider.handleSignal(message);
	} catch (error) {
		showToast(`Participant connection failed: ${error.message}`);
	}
}
function removeRemoteTile(userId) {
	document.querySelector(`#remoteTiles [data-user-id="${CSS.escape(userId)}"]`)?.remove();
}
function renderChat() {
	const list = document.querySelector('#chatList');
	if (!list) return;
	const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 36;
	list.innerHTML = chatMessages.length ? chatMessages.map((message) => `<article class="chat-message ${message.sender_id === currentUserId ? 'own' : ''}"><div><b>${escapeHtml(message.sender_id === currentUserId ? 'You' : message.sender_name || 'Participant')}</b><time>${escapeHtml(formatDate(message.created_at))}</time></div><p>${escapeHtml(message.content)}</p></article>`).join('') : EmptyPanel({ icon: '·', title: 'No messages yet.', message: 'Start the conversation with the meeting.' });
	if (nearBottom) list.scrollTop = list.scrollHeight;
}
async function loadChat() {
	try {
		const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/chat`, { headers: authHeaders });
		if (!response.ok) throw new Error('Unable to load meeting chat.');
		chatMessages = await response.json();
		renderChat();
	} catch (error) { showToast(error.message); }
}
function sendChatMessage(content) {
	if (!realtime) { showToast('Chat is waiting for the realtime connection.'); return; }
	realtime.send('CHAT_MESSAGE', { content });
}
function handleRealtimeMessage(message) {
	if (message.type === 'TRANSCRIPT' && !isHost()) addTranscriptEntry(message.payload || {});
	if (message.type === 'TRANSCRIPT_INTERIM' && !isHost()) addTranscriptInterim(message.payload || {});
	if (message.type === 'TRANSCRIPT_DISCARDED' && !isHost()) {
		if (transcriptInterims.delete(transcriptUtteranceKey(message.payload || {}))) renderTranscriptEntries();
	}
	if (message.type === 'TRANSLATION') appendStreamMessage('translationContent', message.payload, 'Translation');
	if (message.type === 'PARTICIPANT_ROSTER') {
		const roster = message.payload?.participants || [];
		const rosterIds = new Set(roster.map((participant) => participant.user_id));
		participantsState.forEach((_, userId) => {
			if (userId === currentUserId || rosterIds.has(userId)) return;
			participantsState.delete(userId);
			mediaProvider?.removePeer?.(userId);
			removeRemoteTile(userId);
		});
		roster.forEach(async (participant) => {
			participantsState.set(participant.user_id, { ...participant, connectionState: 'connecting' });
			if (participant.user_id !== currentUserId) ensureRemoteTile(participant.user_id, participant);
			await negotiateWith(participant.user_id);
		});
		renderParticipantPanel();
		renderLobbyParticipants();
		updateParticipantCount();
	}
	if (message.type === 'PARTICIPANT_JOINED') {
		const participant = message.payload || {};
		participantsState.set(participant.user_id, { ...participant, connectionState: 'connecting' });
		if (participant.user_id && participant.user_id !== currentUserId) ensureRemoteTile(participant.user_id, participant);
		renderParticipantPanel();
		renderLobbyParticipants();
		renderTaskPanel();
		updateParticipantCount();
		showToast(`${message.payload?.name || 'A participant'} joined the meeting.`);
	}
	if (message.type === 'PARTICIPANT_LEFT') {
		const userId = message.payload?.user_id;
		if (!userId || userId === currentUserId) return;
		mediaProvider?.removePeer?.(userId);
		participantsState.delete(userId);
		removeRemoteTile(userId);
		renderParticipantPanel();
		renderLobbyParticipants();
		renderTaskPanel();
		updateParticipantCount();
		showToast(`${message.payload?.name || 'A participant'} left the meeting.`);
	}
	if (['OFFER', 'ANSWER', 'ICE_CANDIDATE'].includes(message.type)) handleSignalingMessage(message);
	if (message.type === 'ERROR') showToast(message.payload?.message || 'Realtime message error.');
	if (message.type === 'ERROR' && message.payload?.code === 'SPEECH_SERVICE_ERROR') {
		setTranscriptStatus(`Speech recognition error: ${message.payload.message}`, 'error');
	}
	if (message.type === 'MEETING_SETTINGS_UPDATED') {
		meetingState.settings = message.payload || meetingState.settings;
		updateMediaControls();
	}
	if (message.type === 'HOST_TRANSFERRED') applyHostTransfer(message.payload || {});
	if (message.type === 'MEDIA_STATE_REJECTED') {
		applyServerMediaState(message.payload || {});
		showToast('The host meeting settings rejected that media change.');
	}
	if (message.type === 'MEDIA_REQUIREMENT_CHANGED') {
		meetingState.settings = message.payload || meetingState.settings;
		updateMediaControls();
		const state = localMediaState();
		if (!isMediaExempt() && ((meetingState.settings.camera_required && !state.video_enabled) || (meetingState.settings.microphone_required && !state.audio_enabled))) {
			showToast('The host changed the required media settings.');
			showPreJoinModal();
		}
	}
	if (message.type === 'MEDIA_STATE' && message.sender?.name) {
		const userId = message.payload?.user_id || message.sender?.user_id;
		const current = participantsState.get(userId) || {};
		participantsState.set(userId, { ...current, ...message.payload });
		const tile = document.querySelector(`#remoteTiles [data-user-id="${CSS.escape(userId)}"]`);
		if (tile) {
			tile.classList.toggle('camera-off', message.payload?.video_enabled === false);
			tile.querySelector('.media-state').textContent = `${message.payload?.video_enabled ? 'Camera on' : 'Camera off'} · ${message.payload?.audio_enabled ? 'Mic on' : 'Mic off'}`;
			const micState = tile.querySelector('.tile-mic-state');
			if (micState) micState.innerHTML = roomIcon(message.payload?.audio_enabled ? 'mic' : 'micOff', 15);
		}
		const participantRow = document.querySelector(`.participant-row[data-user-id="${CSS.escape(userId)}"]`);
		if (participantRow) participantRow.querySelector('.participant-subline').innerHTML = `${userId === meetingHostId() ? '<span class="role-badge">Host</span>' : ''}<i class="participant-connection ${escapeHtml(participantsState.get(userId)?.connectionState || 'connecting')}"></i>${roomIcon(message.payload?.audio_enabled ? 'mic' : 'micOff', 15)}<span class="camera-state-icon">${roomIcon(message.payload?.video_enabled ? 'camera' : 'videoOff', 15)}</span>`;
		const audio = message.payload?.audio_enabled ? 'mic on' : 'muted';
		const video = message.payload?.video_enabled ? 'camera on' : 'camera off';
		showToast(`${message.sender.name}: ${audio}, ${video}.`);
	}
	if (message.type === 'CHAT_MESSAGE' && message.payload?.id) {
		if (!chatMessages.some((item) => item.id === message.payload.id)) { chatMessages.push(message.payload); if (!document.querySelector('.chat-panel')?.classList.contains('panel-open')) { chatUnreadCount += 1; document.querySelectorAll('[data-unread="chat"]').forEach((dot) => { dot.hidden = false; }); if (message.payload.sender_id !== currentUserId) showToast(`New chat message from ${message.payload.sender_name || 'a participant'}.`); } }
		renderChat();
	}
	if (message.type === 'MEETING_ENDED') {
		stopLocalMedia();
		realtime?.close();
		renderEndedMeeting(message.payload?.reason || 'The meeting has ended.');
	}
	if (message.type === 'REACTION') showReaction(message.payload?.reaction || '', message.sender?.name || 'Participant');
	if (message.type === 'NOTIFICATION') showToast(message.payload?.message || 'Meeting notification');
	if (message.type === 'MEETING_EVENT' && message.payload?.name === 'question-timer-started') startQuestionTimer(Number(message.payload.duration_seconds) || 60, false);
	if (message.type === 'TASK_UPDATED') loadTasks();
	if (message.type === 'TOPIC_UPDATED') loadTopics();
	if (message.type === 'SCHEDULED_QUESTIONS_UPDATED') loadScheduledQuestions();
	if (message.type === 'MEETING_EVENT' || message.type === 'TASK_CREATED' || message.type === 'BOOKMARK') showToast(`${message.type.replace('_', ' ').toLowerCase()} received.`);
}
function connectRealtime() {
	if (!window.MeetingWebSocketService) { updateConnectionStatus('Unavailable'); return; }
	realtime = new window.MeetingWebSocketService({
		meetingId,
		token,
		onStatus: (status) => {
			updateConnectionStatus(status);
			updateTranscriptConnectionStatus(status);
			if (status === 'connected') {
				document.querySelector('#reconnectingBanner')?.remove();
				updateMediaState();
				if (microphoneStream) startMicrophoneTranscription();
				if (!isHost()) loadTranscriptHistory(true);
			} else if (status === 'disconnected') {
				stopMicrophoneTranscription();
				updateConnectionStatus('Reconnecting…');
				if (!document.querySelector('#reconnectingBanner')) {
					const banner = document.createElement('div');
					banner.id = 'reconnectingBanner';
					banner.className = 'reconnecting-banner';
					banner.textContent = 'Reconnecting…';
					document.body.appendChild(banner);
				}
			}
		},
		onMessage: handleRealtimeMessage,
		onError: showToast,
	});
	realtime.connect();
}
function updateMediaControls() {
	const settings = meetingState?.settings || {};
	const cameraLocked = !isHost() && settings.allow_camera_toggle === false && localMediaState().video_enabled;
	const microphoneLocked = !isHost() && settings.allow_microphone_toggle === false && localMediaState().audio_enabled;
	const cameraButton = document.querySelector('#cameraButton');
	const microphoneButton = document.querySelector('#micButton');
	if (cameraButton) {
		cameraButton.innerHTML = cameraLocked ? '▣ <span aria-hidden="true">🔒</span>' : '▣';
		cameraButton.title = cameraLocked ? 'The host does not allow you to turn off your camera' : '';
		cameraButton.setAttribute('aria-label', cameraLocked ? 'The host does not allow you to turn off your camera' : 'Enable camera');
		cameraButton.dataset.locked = String(cameraLocked);
	}
	if (microphoneButton) {
		microphoneButton.innerHTML = microphoneLocked ? '♩ <span aria-hidden="true">🔒</span>' : '♩';
		microphoneButton.title = microphoneLocked ? 'The host does not allow you to mute your microphone' : '';
		microphoneButton.setAttribute('aria-label', microphoneLocked ? 'The host does not allow you to mute your microphone' : 'Enable microphone');
		microphoneButton.dataset.locked = String(microphoneLocked);
	}
}
function updateMediaState(broadcast = true) {
	const { video_enabled: cameraOn, audio_enabled: micOn } = localMediaState();
	const state = document.querySelector('#mediaState');
	if (state) state.textContent = `Camera ${cameraOn ? 'on' : 'off'} · Mic ${micOn ? 'on' : 'off'}`;
	if (broadcast) realtime?.sendMediaState({ audio_enabled: micOn, video_enabled: cameraOn });
	const muteButton = document.querySelector('#muteButton');
	if (muteButton) {
		muteButton.textContent = micOn ? 'Mute' : 'Unmute';
		muteButton.classList.toggle('active', !micOn && Boolean(microphoneStream));
	}
	const placeholder = document.querySelector('#mediaPlaceholder');
	if (placeholder) placeholder.classList.toggle('hidden', cameraOn);
	const video = document.querySelector('#localVideo');
	if (video) video.classList.toggle('visible', cameraOn);
	updateMediaControls();
}
function mediaError(error, device) {
	if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return `${device} access is blocked. Allow ${device.toLowerCase()} access in your browser's site settings, then try again.`;
	if (error.name === 'NotFoundError') return `No ${device.toLowerCase()} detected. Connect one and try again.`;
	if (error.name === 'NotReadableError') return `${device} is already in use by another application. Close other apps using it and try again.`;
	if (error.name === 'OverconstrainedError') return `The selected ${device.toLowerCase()} is unavailable. Choose another device and try again.`;
	if (!window.isSecureContext) return `${device} access requires HTTPS or localhost. Open this meeting over a secure connection.`;
	return error.message
		? `Unable to access the ${device.toLowerCase()}: ${error.message}`
		: `Unable to access the ${device.toLowerCase()}. Check browser permissions and device settings, then try again.`;
}
async function enableMicrophone() {
	if (microphoneStream) {
		microphoneStream.getAudioTracks().forEach((track) => { track.enabled = true; });
		return true;
	}
	try {
		microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		microphoneStream.getTracks().forEach((track) => localStream.addTrack(track));
		await mediaProvider?.setLocalStream(localStream);
		updateMediaState(false);
		return true;
	} catch (error) {
		microphoneStream?.getTracks().forEach((track) => track.stop());
		microphoneStream = null;
		showToast(mediaError(error, 'Microphone'));
		return false;
	}
}
function applyServerMediaState(payload) {
	if (typeof payload.video_enabled === 'boolean') cameraStream?.getVideoTracks().forEach((track) => { track.enabled = payload.video_enabled; });
	if (typeof payload.audio_enabled === 'boolean') microphoneStream?.getAudioTracks().forEach((track) => { track.enabled = payload.audio_enabled; });
	updateMediaState(false);
}
async function toggleCamera() {
	const button = document.querySelector('#cameraButton');
	if (cameraToggleInProgress) return;
	const cameraOn = localMediaState().video_enabled;
	if (cameraOn && button?.dataset.locked === 'true') {
		showToast('The host does not allow you to turn off your camera.');
		return;
	}
	cameraToggleInProgress = true;
	if (button) button.disabled = true;
	try {
		if (cameraOn) {
			await disableCamera();
			updateMediaState();
			showToast('Camera disabled.');
			return;
		}
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error(window.isSecureContext
				? 'This browser does not support camera capture.'
				: 'Camera access requires HTTPS or localhost. Open this meeting over a secure connection.');
		}
		if (!await enableCamera()) return;
		button?.classList.add('active');
		updateMediaState();
		showToast('Camera enabled.');
	} catch (error) {
		const message = ['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(error.name)
			? mediaError(error, 'Camera')
			: error.message;
		showToast(message || 'Unable to update the camera.', 'error');
	} finally {
		cameraToggleInProgress = false;
		if (button) button.disabled = false;
	}
}
async function toggleMicrophone() {
	const button = document.querySelector('#micButton');
	if (microphoneStream) {
		if (button?.dataset.locked === 'true' && microphoneStream.getAudioTracks().some((track) => track.enabled)) {
			showToast('The host does not allow you to mute your microphone.');
			return;
		}
		microphoneStream.getAudioTracks().forEach((track) => { track.enabled = !track.enabled; });
		button.classList.toggle('active', microphoneStream.getAudioTracks().some((track) => track.enabled));
		updateMediaState();
		showToast(microphoneStream.getAudioTracks().some((track) => track.enabled) ? 'Microphone enabled.' : 'Microphone muted.');
		return;
	}
	if (!navigator.mediaDevices?.getUserMedia) {
		showToast(window.isSecureContext
			? 'This browser does not support microphone capture.'
			: 'Microphone access requires HTTPS or localhost. Open this meeting over a secure connection.', 'error');
		return;
	}
	if (!window.AudioWorkletNode || !window.AudioContext) {
		showToast('This browser does not support live microphone transcription.', 'error');
		return;
	}
	try {
		if (!await enableMicrophone()) return;
		if (!mediaProvider) setupWebRTC();
		startMicrophoneTranscription();
		button.classList.add('active');
		updateMediaState();
		showToast('Microphone enabled. Listening for speech.');
	} catch (error) { showToast(mediaError(error, 'Microphone')); }
}
function requiredMediaText() {
	const settings = meetingState.settings || {};
	const cameraMissing = settings.camera_required && !localMediaState().video_enabled;
	const microphoneMissing = settings.microphone_required && !localMediaState().audio_enabled;
	if (cameraMissing && microphoneMissing) return 'The host requires your camera and microphone to join.';
	if (cameraMissing) return 'The host requires your camera to join.';
	return 'The host requires your microphone to join.';
}
function showPreJoinModal() {
	if (isMediaExempt()) return;
	let modal = document.querySelector('#preJoinModal');
	if (!modal) {
		modal = document.createElement('div');
		modal.id = 'preJoinModal';
		modal.className = 'modal-backdrop';
		document.body.appendChild(modal);
	}
	const settings = meetingState.settings || {};
	const cameraMissing = settings.camera_required && !localMediaState().video_enabled;
	const microphoneMissing = settings.microphone_required && !localMediaState().audio_enabled;
	const allowLabel = cameraMissing && microphoneMissing ? 'Allow camera and microphone' : cameraMissing ? 'Allow camera' : 'Allow microphone';
	modal.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="preJoinTitle"><h2 id="preJoinTitle">Media required to join</h2><p>${escapeHtml(requiredMediaText())}</p><p class="modal-help">Your browser will ask for permission. If access is denied, change this site's browser permission and retry.</p><div class="modal-actions"><button class="small-button" data-action="prejoin-allow">${allowLabel}</button><button class="small-button" data-action="prejoin-retry">Retry</button><button class="small-button" data-action="prejoin-leave">Leave meeting</button></div></section>`;
	document.querySelector('#admissionStatus')?.classList.remove('hidden');
}
async function completePreJoin() {
	const settings = meetingState.settings || {};
	let success = true;
	if (settings.camera_required && !localMediaState().video_enabled) success = await enableCamera() && success;
	if (settings.microphone_required && !localMediaState().audio_enabled) success = await enableMicrophone() && success;
	if (!success || !((!settings.camera_required || localMediaState().video_enabled) && (!settings.microphone_required || localMediaState().audio_enabled))) {
		showPreJoinModal();
		return;
	}
	document.querySelector('#preJoinModal')?.remove();
	document.querySelector('#admissionStatus')?.classList.add('hidden');
	if (!realtime) connectRealtime();
	updateMediaState();
}
function openMeetingSettings() {
	if (!isHost()) return;
	const settings = meetingState.settings || {};
	const modal = document.createElement('div');
	modal.id = 'settingsModal';
	modal.className = 'modal-backdrop';
	modal.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="settingsTitle"><h2 id="settingsTitle">Meeting settings</h2><form id="settingsForm"><label><input type="checkbox" name="camera_required" ${settings.camera_required ? 'checked' : ''}/> Camera required</label><label><input type="checkbox" name="microphone_required" ${settings.microphone_required ? 'checked' : ''}/> Microphone required</label><label><input type="checkbox" name="allow_camera_toggle" ${settings.allow_camera_toggle ? 'checked' : ''}/> Participants can turn camera off</label><label><input type="checkbox" name="allow_microphone_toggle" ${settings.allow_microphone_toggle ? 'checked' : ''}/> Participants can mute themselves</label><div class="modal-actions"><button class="small-button" type="submit">Save settings</button><button class="small-button" type="button" data-action="settings-close">Cancel</button></div></form></section>`;
	document.body.appendChild(modal);
}
async function saveMeetingSettings(form) {
	const payload = Object.fromEntries(new FormData(form).entries());
	for (const key of ['camera_required', 'microphone_required', 'allow_camera_toggle', 'allow_microphone_toggle']) payload[key] = payload[key] === 'on';
	try {
		const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/settings`, { method: 'PATCH', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.detail || 'Unable to save meeting settings.');
		meetingState.settings = data;
		updateMediaControls();
		closeRoomModal('settingsModal');
		showToast('Meeting settings saved.');
	} catch (error) { showToast(error.message); }
}
async function startMicrophoneTranscription() {
	const track = microphoneStream?.getAudioTracks().find((item) => item.readyState === 'live' && item.enabled);
	if (!track || microphoneAudioWorklet || microphoneAudioStarting || !realtime || document.querySelector('#connectionStatus')?.dataset.status !== 'connected') return;
	if (!window.AudioWorkletNode || !window.AudioContext) {
		setTranscriptStatus('This browser does not support live microphone transcription.', 'error');
		return;
	}
	const stream = microphoneStream;
	const generation = ++microphoneAudioGeneration;
	microphoneAudioStarting = true;
	let context;
	let source;
	let worklet;
	let silentGain;
	try {
		context = new AudioContext({ sampleRate: 16_000 });
		microphoneAudioContext = context;
		await context.audioWorklet.addModule(new URL('./live-audio-worklet.js', window.location.href));
		if (generation !== microphoneAudioGeneration || microphoneStream !== stream) {
			await context.close();
			return;
		}
		source = context.createMediaStreamSource(stream);
		worklet = new AudioWorkletNode(context, 'live-pcm-processor');
		silentGain = context.createGain();
		silentGain.gain.value = 0;
		worklet.port.onmessage = ({ data }) => {
			if (generation !== microphoneAudioGeneration || !microphoneStream || !track.enabled || document.querySelector('#connectionStatus')?.dataset.status !== 'connected') return;
			if (data?.type === 'silence') {
				realtime?.send('AUDIO_SILENCE');
				return;
			}
			if (data?.type !== 'audio' || !data.samples?.length) return;
			const samples = data.samples;
			const pcm = new Int16Array(samples.length);
			for (let index = 0; index < samples.length; index += 1) {
				const sample = Math.max(-1, Math.min(1, samples[index]));
				pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
			}
			if (!realtime?.sendAudioChunk(pcm.buffer)) {
				setTranscriptStatus('Audio is waiting for the meeting connection.', 'connecting');
			}
		};
		source.connect(worklet);
		worklet.connect(silentGain);
		silentGain.connect(context.destination);
		await context.resume();
		if (generation !== microphoneAudioGeneration || microphoneStream !== stream) {
			worklet.port.close();
			worklet.disconnect();
			source.disconnect();
			await context.close();
			return;
		}
		microphoneAudioSource = source;
		microphoneAudioWorklet = worklet;
		setTranscriptStatus('Live · waiting for speech');
	} catch (error) {
		worklet?.port.close();
		worklet?.disconnect();
		source?.disconnect();
		if (context && context.state !== 'closed') await context.close().catch(() => {});
		if (microphoneAudioContext === context) microphoneAudioContext = null;
		if (generation === microphoneAudioGeneration) setTranscriptStatus(`Microphone transcription failed: ${error.message}`, 'error');
	} finally {
		if (generation === microphoneAudioGeneration) microphoneAudioStarting = false;
	}
}
function stopMicrophoneTranscription() {
	microphoneAudioGeneration += 1;
	microphoneAudioStarting = false;
	clearOwnTranscriptInterims();
	renderTranscriptEntries();
	if (realtime && document.querySelector('#connectionStatus')?.dataset.status === 'connected') {
		realtime.send('AUDIO_RESET');
	}
	microphoneAudioWorklet?.port.close();
	microphoneAudioWorklet?.disconnect();
	microphoneAudioSource?.disconnect();
	if (microphoneAudioContext && microphoneAudioContext.state !== 'closed') {
		microphoneAudioContext.close().catch((error) => console.warn('Unable to close microphone audio context:', error));
	}
	microphoneAudioWorklet = null;
	microphoneAudioSource = null;
	microphoneAudioContext = null;
}
let notes = [];
let activeNoteId = null;
let noteSaveTimer;
function updateSaveState(text) { const state = document.querySelector('#saveState'); if (state) state.textContent = text; }
function scheduledOffsetLabel(seconds) {
	if (seconds === null || seconds === undefined) return 'Manual activation';
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds % 60;
	return `Starts ${minutes ? `${minutes}m ` : ''}${remainder}s after meeting start`;
}
function scheduledQuestionTimeLeft(item) {
	if (!item.expires_at || item.status !== 'active') return '';
	const remaining = Math.max(0, Math.ceil((new Date(item.expires_at).getTime() - Date.now()) / 1000));
	return remaining ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')} remaining` : 'Time is up';
}
function renderScheduledQuestions() {
	const root = document.querySelector('#scheduledQuestionWorkspace');
	if (!root) return;
	window.clearInterval(scheduledQuestionClock);
	scheduledQuestionClock = null;
	const host = isHost();
	if (!scheduledQuestions.length) {
		root.innerHTML = EmptyPanel({
			icon: 'question',
			title: host ? 'No scheduled questions yet.' : 'The host has not scheduled a question yet.',
			message: host ? 'Add a question and choose when participants can answer.' : 'The current question will appear here when it is activated.',
		});
		return;
	}
	if (!host) {
		const active = scheduledQuestions.find((item) => item.status === 'active');
		const upcoming = scheduledQuestions.filter((item) => item.status === 'upcoming');
		const answered = scheduledQuestions.filter((item) => item.status === 'closed' && item.my_answer);
		root.innerHTML = `${active ? `<article class="scheduled-question active"><div class="scheduled-question-meta"><span>Current question</span><strong id="scheduledQuestionTimer">${escapeHtml(scheduledQuestionTimeLeft(active) || 'Open')}</strong></div><h3>${escapeHtml(active.question)}</h3>${active.my_answer ? `<p class="question-answer-label">Your answer</p>` : ''}<form class="scheduled-answer-form" data-question-id="${escapeHtml(active.id)}"><textarea name="answer" maxlength="5000" aria-label="Your answer" placeholder="Write your answer..." required>${escapeHtml(active.my_answer || '')}</textarea><button type="submit">${active.my_answer ? 'Update answer' : 'Submit answer'}</button></form></article>` : `<div class="scheduled-question-empty">${EmptyPanel({ icon: 'question', title: 'Waiting for the next question.' })}</div>`}${upcoming.length ? `<section class="upcoming-questions"><h3>Coming up</h3>${upcoming.map((item) => `<article class="scheduled-question upcoming"><small>${escapeHtml(scheduledOffsetLabel(item.scheduled_offset_seconds))}</small><p>${escapeHtml(item.question)}</p></article>`).join('')}</section>` : ''}${answered.length ? `<section class="previous-answers"><h3>Your previous answers</h3>${answered.map((item) => `<article class="scheduled-question previous"><p>${escapeHtml(item.question)}</p><blockquote>${escapeHtml(item.my_answer)}</blockquote></article>`).join('')}</section>` : ''}`;
		if (active?.expires_at) {
			scheduledQuestionClock = window.setInterval(() => {
				const timer = document.querySelector('#scheduledQuestionTimer');
				if (timer) timer.textContent = scheduledQuestionTimeLeft(active) || 'Time is up';
			}, 1000);
		}
		return;
	}
	root.innerHTML = `<div class="scheduled-question-list">${scheduledQuestions.map((item, index) => `<article class="scheduled-question managed"><header><span>Question ${index + 1}</span><span class="question-status ${escapeHtml(item.status)}">${escapeHtml(item.status)}</span></header><h3>${escapeHtml(item.question)}</h3><div class="scheduled-question-meta"><span>${escapeHtml(scheduledOffsetLabel(item.scheduled_offset_seconds))}</span><span>${item.answer_duration_seconds ? `${item.answer_duration_seconds}s to answer` : 'No answer timer'}</span><span>${item.show_before_active ? 'Visible before activation' : 'Hidden until active'}</span></div><div class="scheduled-question-actions"><button type="button" class="small-button" data-scheduled-action="activate" data-question-id="${escapeHtml(item.id)}" ${item.is_enabled ? '' : 'disabled'}>Activate now</button><button type="button" class="small-button" data-scheduled-action="up" data-question-id="${escapeHtml(item.id)}" ${index === 0 ? 'disabled' : ''} aria-label="Move question up">↑</button><button type="button" class="small-button" data-scheduled-action="down" data-question-id="${escapeHtml(item.id)}" ${index === scheduledQuestions.length - 1 ? 'disabled' : ''} aria-label="Move question down">↓</button><button type="button" class="small-button" data-scheduled-action="delete" data-question-id="${escapeHtml(item.id)}">Delete</button></div><details class="scheduled-question-edit"><summary>Edit schedule</summary><form data-scheduled-edit="${escapeHtml(item.id)}"><label>Question<textarea name="question" maxlength="2000" required>${escapeHtml(item.question)}</textarea></label><label>Start after meeting start (seconds; blank = manual)<input name="scheduled_offset_seconds" type="number" min="0" max="86400" value="${item.scheduled_offset_seconds ?? ''}"/></label><label>Answer duration (seconds; blank = no timer)<input name="answer_duration_seconds" type="number" min="10" max="3600" value="${item.answer_duration_seconds ?? ''}"/></label><label><input name="show_before_active" type="checkbox" ${item.show_before_active ? 'checked' : ''}/> Show this question before it becomes active</label><label><input name="is_enabled" type="checkbox" ${item.is_enabled ? 'checked' : ''}/> Enabled</label><button class="small-button" type="submit">Save changes</button></form></details><div class="scheduled-question-answers"><strong>Answers (${item.answers.length})</strong>${item.answers.length ? item.answers.map((answer) => `<p><b>${escapeHtml(answer.display_name)}</b> ${escapeHtml(answer.answer)}</p>`).join('') : '<p>No answers submitted yet.</p>'}</div></article>`).join('')}</div>`;
}
let scheduledQuestionLoadInProgress = false;
async function loadScheduledQuestions() {
	if (scheduledQuestionLoadInProgress || !document.querySelector('#scheduledQuestionWorkspace')) return;
	scheduledQuestionLoadInProgress = true;
	try {
		const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions/scheduled`, { headers: authHeaders });
		if (!response.ok) throw new Error('Unable to load the scheduled questions.');
		scheduledQuestions = await response.json();
		renderScheduledQuestions();
	} catch (error) {
		const root = document.querySelector('#scheduledQuestionWorkspace');
		if (root && !scheduledQuestions.length) root.innerHTML = EmptyPanel({ icon: 'question', title: error.message });
	} finally {
		scheduledQuestionLoadInProgress = false;
	}
}
function startScheduledQuestionPolling() {
	if (scheduledQuestionRefresh) return;
	scheduledQuestionRefresh = window.setInterval(loadScheduledQuestions, 4000);
}
function renderQuestions() { const list = document.querySelector('#questionList'); if (!list) return; list.innerHTML = questions.length ? questions.map((item) => `<article class="question-item"><small>${escapeHtml(item.asked_by_id === currentUserId ? 'You asked' : 'Participant question')}</small><p>${escapeHtml(item.question)}</p>${item.answer ? `<div class="question-answer"><b>Answer</b><p>${escapeHtml(item.answer)}</p></div>` : `<form class="answer-form" data-question-id="${item.id}"><input name="answer" placeholder="Add an answer" aria-label="Answer question" required/><button type="submit">Answer</button></form>`}</article>`).join('') : EmptyPanel({ icon: 'Q', title: 'No questions yet.', message: 'Ask the first question about this meeting.' }); }
async function loadQuestions() { try { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions`, { headers: authHeaders }); if (!response.ok) throw new Error('Unable to load questions.'); questions = await response.json(); renderQuestions(); } catch (error) { showToast(error.message); } }
function renderTasks() {
	const list = document.querySelector('#taskList');
	if (!list) return;
	list.innerHTML = tasks.length ? tasks.map((task) => {
		const assignee = task.assignee_id
			? meetingState?.participants?.find((person) => person.user_id === task.assignee_id)?.name || 'Assigned participant'
			: 'All participants';
		const canUpdate = isHost() || task.assignee_id === null || task.assignee_id === currentUserId;
		return `<article class="task-item"><div><b>${escapeHtml(task.title)}</b><small>${escapeHtml(task.priority)} · ${escapeHtml(task.status)} · ${escapeHtml(assignee)}</small></div><select data-task-id="${escapeHtml(task.id)}" aria-label="Task status" ${canUpdate ? '' : 'disabled'}><option value="open" ${task.status === 'open' ? 'selected' : ''}>Open</option><option value="in_progress" ${task.status === 'in_progress' ? 'selected' : ''}>In progress</option><option value="completed" ${task.status === 'completed' ? 'selected' : ''}>Completed</option><option value="cancelled" ${task.status === 'cancelled' ? 'selected' : ''}>Cancelled</option></select>${isHost() ? `<button type="button" class="small-button" data-task-edit="${escapeHtml(task.id)}">Edit</button><button type="button" class="small-button" data-task-delete="${escapeHtml(task.id)}" aria-label="Delete ${escapeHtml(task.title)}">Delete</button>` : ''}</article>`;
	}).join('') : EmptyPanel({ icon: 'task', title: 'No tasks yet.', message: isHost() ? 'Add an action item for this meeting.' : 'The host has not assigned any tasks.' });
}
async function loadTasks() { try { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/tasks`, { headers: authHeaders }); if (!response.ok) throw new Error('Unable to load tasks.'); tasks = await response.json(); renderTasks(); } catch (error) { showToast(error.message); } }
async function createTask(payload) {
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/tasks`, {
		method: 'POST',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		showToast(data.detail || 'Unable to create task.');
		return;
	}
	tasks.push(data);
	renderTasks();
}
async function updateTaskStatus(taskId, status) { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); const data = await response.json().catch(() => ({})); if (!response.ok) { showToast(data.detail || 'Unable to update task.'); return; } tasks = tasks.map((task) => task.id === data.id ? data : task); renderTasks(); }
async function deleteTask(taskId) {
	if (!window.confirm('Delete this task for everyone?')) return;
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/tasks/${encodeURIComponent(taskId)}`, {
		method: 'DELETE',
		headers: authHeaders,
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		showToast(data.detail || 'Unable to delete task.', 'error');
		return;
	}
	tasks = tasks.filter((task) => task.id !== taskId);
	renderTasks();
}
async function editTask(taskId) {
	const task = tasks.find((item) => item.id === taskId);
	if (!task) return;
	const title = window.prompt('Edit task title', task.title);
	if (title === null) return;
	const description = window.prompt('Edit task description', task.description || '');
	if (description === null) return;
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/tasks/${encodeURIComponent(taskId)}`, {
		method: 'PATCH',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: title.trim(), description: description.trim() || null }),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		showToast(data.detail || 'Unable to edit task.', 'error');
		return;
	}
	tasks = tasks.map((item) => item.id === data.id ? data : item);
	renderTasks();
}
function renderTopics() {
	const list = document.querySelector('#topicsList');
	if (!list) return;
	const published = meetingTopics.map((topic) => `<article class="meeting-topic"><div><b>${escapeHtml(topic.title)}</b>${topic.is_important ? '<span class="topic-important">Important</span>' : ''}<small>${topic.is_published ? 'Published' : 'Draft'}${topic.published_at ? ` · ${escapeHtml(formatDate(topic.published_at))}` : ''}</small>${topic.description ? `<p>${escapeHtml(topic.description)}</p>` : ''}</div>${isHost() ? `<div class="topic-actions"><button type="button" class="small-button" data-topic-edit="${escapeHtml(topic.id)}">Edit</button><button type="button" class="small-button" data-topic-publish="${escapeHtml(topic.id)}">${topic.is_published ? 'Unpublish' : 'Publish'}</button><button type="button" class="small-button" data-topic-delete="${escapeHtml(topic.id)}">Delete</button></div>` : ''}</article>`).join('');
	const detected = topics.map((topic) => `<span class="topic-chip">${escapeHtml(topic)}</span>`).join('');
	list.innerHTML = `${published ? `<section class="topic-section"><h3>Host-published topics</h3>${published}</section>` : ''}${detected ? `<section class="topic-section"><h3>AI-detected topics</h3><div class="topics">${detected}</div></section>` : ''}${!published && !detected ? EmptyPanel({ icon: 'topics', title: isHost() ? 'Add topics for participants.' : 'No topics have been published yet.' }) : ''}`;
}
async function loadTopics() {
	try {
		const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/topics`, { headers: authHeaders });
		if (!response.ok) throw new Error('Unable to load meeting topics.');
		meetingTopics = await response.json();
		renderTopics();
	} catch (error) {
		showToast(error.message);
	}
	try {
		const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/summary`, { headers: authHeaders });
		if (response.status === 404) {
			renderTopics();
			return;
		}
		if (!response.ok) throw new Error('Unable to load AI-detected topics.');
		const summary = await response.json();
		topics = summary.topics || [];
		renderTopics();
	} catch (error) {
		showToast(error.message);
	}
}
async function createTopic(payload) {
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/topics`, {
		method: 'POST',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		showToast(data.detail || 'Unable to create topic.', 'error');
		return;
	}
	meetingTopics.push(data);
	renderTopics();
}
async function updateTopic(topicId, changes) {
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/topics/${encodeURIComponent(topicId)}`, {
		method: 'PATCH',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify(changes),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		showToast(data.detail || 'Unable to update topic.', 'error');
		return;
	}
	meetingTopics = meetingTopics.map((topic) => topic.id === data.id ? data : topic);
	renderTopics();
}
async function deleteTopic(topicId) {
	if (!window.confirm('Delete this topic for everyone?')) return;
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/topics/${encodeURIComponent(topicId)}`, {
		method: 'DELETE',
		headers: authHeaders,
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		showToast(data.detail || 'Unable to delete topic.', 'error');
		return;
	}
	meetingTopics = meetingTopics.filter((topic) => topic.id !== topicId);
	renderTopics();
}
async function submitQuestion(question) { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions`, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) }); const data = await response.json().catch(() => ({})); if (!response.ok) { showToast(data.detail || 'Unable to ask question.'); return; } questions.push(data); renderQuestions(); realtime?.send('MEETING_EVENT', { name: 'question-created', question_id: data.id }); }
async function answerQuestion(questionId, answer) { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions/${encodeURIComponent(questionId)}/answer`, { method: 'PATCH', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }) }); const data = await response.json().catch(() => ({})); if (!response.ok) { showToast(data.detail || 'Unable to answer question.'); return; } questions = questions.map((item) => item.id === data.id ? data : item); renderQuestions(); realtime?.send('MEETING_EVENT', { name: 'question-answered', question_id: data.id }); }
async function saveScheduledQuestion(form, questionId = null) {
	const formData = new FormData(form);
	const scheduledOffset = formData.get('scheduled_offset_seconds')?.toString().trim() || null;
	const duration = formData.get('answer_duration_seconds')?.toString().trim() || null;
	const payload = {
		question: formData.get('question')?.toString().trim(),
		scheduled_offset_seconds: scheduledOffset === null ? null : Number(scheduledOffset),
		answer_duration_seconds: duration === null ? null : Number(duration),
		show_before_active: formData.has('show_before_active'),
		is_enabled: formData.has('is_enabled'),
	};
	if (!questionId) delete payload.is_enabled;
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions/scheduled${questionId ? `/${encodeURIComponent(questionId)}` : ''}`, {
		method: questionId ? 'PATCH' : 'POST',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		showToast(data.detail || 'Unable to save the scheduled question.', 'error');
		return;
	}
	if (!questionId) form.reset();
	await loadScheduledQuestions();
}
async function deleteScheduledQuestion(questionId) {
	if (!window.confirm('Delete this scheduled question and its participant answers?')) return;
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions/scheduled/${encodeURIComponent(questionId)}`, {
		method: 'DELETE',
		headers: authHeaders,
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		showToast(data.detail || 'Unable to delete the scheduled question.', 'error');
		return;
	}
	await loadScheduledQuestions();
}
async function activateScheduledQuestion(questionId) {
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions/scheduled/${encodeURIComponent(questionId)}/activate`, {
		method: 'POST',
		headers: authHeaders,
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		showToast(data.detail || 'Unable to activate the scheduled question.', 'error');
		return;
	}
	await loadScheduledQuestions();
}
async function moveScheduledQuestion(questionId, direction) {
	const ids = scheduledQuestions.map((item) => item.id);
	const index = ids.indexOf(questionId);
	const target = index + direction;
	if (index < 0 || target < 0 || target >= ids.length) return;
	[ids[index], ids[target]] = [ids[target], ids[index]];
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions/scheduled/reorder`, {
		method: 'PATCH',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify({ question_ids: ids }),
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		showToast(data.detail || 'Unable to reorder the questions.', 'error');
		return;
	}
	await loadScheduledQuestions();
}
async function submitScheduledAnswer(questionId, answer) {
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions/scheduled/${encodeURIComponent(questionId)}/answer`, {
		method: 'POST',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		body: JSON.stringify({ answer }),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		showToast(data.detail || 'Unable to submit your answer.', 'error');
		await loadScheduledQuestions();
		return;
	}
	await loadScheduledQuestions();
}
function updateQuestionTimer() { const node = document.querySelector('#questionTimer'); if (!node || !questionTimerEndsAt) return; const remaining = Math.max(0, Math.ceil((questionTimerEndsAt - Date.now()) / 1000)); node.textContent = remaining ? `Timer ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Time is up'; if (!remaining) { window.clearInterval(questionTimer); questionTimer = null; questionTimerEndsAt = null; } }
function startQuestionTimer(seconds, broadcast = true) { questionTimerEndsAt = Date.now() + seconds * 1000; window.clearInterval(questionTimer); updateQuestionTimer(); questionTimer = window.setInterval(updateQuestionTimer, 1000); if (broadcast) realtime?.send('MEETING_EVENT', { name: 'question-timer-started', duration_seconds: seconds }); }
function renderNoteList() { const list = document.querySelector('#notesList'); if (!list) return; list.innerHTML = notes.length ? notes.map((note) => `<button class="note-list-item ${note.id === activeNoteId ? 'selected' : ''}" data-note-id="${note.id}"><b>${escapeHtml(note.title || 'Untitled note')}</b><small>${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(note.updated_at))}</small></button>`).join('') : '<p class="notes-empty">No notes yet. Start writing below.</p>'; }
function selectNote(note) { activeNoteId = note?.id || null; document.querySelector('#notesTitle').value = note?.title || ''; document.querySelector('#notesBody').value = note?.content || ''; updateSaveState(note ? `Last saved ${formatDate(note.updated_at)}` : 'New note'); renderNoteList(); }
async function loadNotes() {
	if (!document.querySelector('.notes-panel') || isHost()) return;
	try {
		const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/notes`, { headers: authHeaders });
		if (!response.ok) throw new Error('Unable to load your personal notes.');
		const loadedNotes = await response.json();
		if (!document.querySelector('.notes-panel') || isHost()) return;
		notes = loadedNotes;
		selectNote(notes[0] || null);
	} catch (error) {
		if (!isHost()) updateSaveState(error.message);
	}
	if (!document.querySelector('.notes-panel') || isHost()) return;
	document.querySelector('#notesTitle')?.addEventListener('input', queueNoteSave);
	document.querySelector('#notesBody')?.addEventListener('input', queueNoteSave);
}
function queueNoteSave() { updateSaveState('Saving...'); window.clearTimeout(noteSaveTimer); noteSaveTimer = window.setTimeout(saveNote, 650); }
async function saveNote() { const title = document.querySelector('#notesTitle').value.trim() || null; const content = document.querySelector('#notesBody').value; if (!title && !content.trim() && !activeNoteId) { updateSaveState('New note'); return; } const method = activeNoteId ? 'PUT' : 'POST'; const url = activeNoteId ? `${API_URL}/api/notes/${activeNoteId}` : `${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/notes`; try { const response = await fetch(url, { method, headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }) }); if (!response.ok) throw new Error('Unable to save note.'); const saved = await response.json(); if (!activeNoteId) notes.unshift(saved); else notes = notes.map((note) => note.id === saved.id ? saved : note); activeNoteId = saved.id; updateSaveState(`Last saved ${formatDate(saved.updated_at)}`); renderNoteList(); } catch (error) { updateSaveState(error.message); } }
async function deleteNote() { if (!activeNoteId) { selectNote(null); return; } try { const response = await fetch(`${API_URL}/api/notes/${activeNoteId}`, { method: 'DELETE', headers: authHeaders }); if (!response.ok) throw new Error('Unable to delete note.'); notes = notes.filter((note) => note.id !== activeNoteId); selectNote(notes[0] || null); } catch (error) { updateSaveState(error.message); } }
function downloadNotes() { const title = document.querySelector('#notesTitle').value || 'Meeting notes'; const body = document.querySelector('#notesBody').value || 'No notes yet.'; const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([`${title}\n\n${body}`], { type: 'text/plain' })); link.download = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.txt`; link.click(); URL.revokeObjectURL(link.href); }
function exportPdf() { const title = document.querySelector('#notesTitle').value || 'Meeting notes'; const body = document.querySelector('#notesBody').value || 'No notes yet.'; const printWindow = window.open('', '_blank', 'width=800,height=700'); if (!printWindow) { showToast('Allow pop-ups to export a PDF.'); return; } printWindow.document.write(`<html><head><title>${escapeHtml(title)}</title><style>body{font:14px Arial;max-width:760px;margin:50px auto;line-height:1.6}h1{font:24px Georgia}pre{white-space:pre-wrap;font:14px Arial}</style></head><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(body)}</pre></body></html>`); printWindow.document.close(); printWindow.focus(); printWindow.print(); }
function stopLocalMedia() {
	window.clearInterval(scheduledQuestionRefresh);
	window.clearInterval(scheduledQuestionClock);
	scheduledQuestionRefresh = null;
	scheduledQuestionClock = null;
	stopMicrophoneTranscription();
	for (const selector of ['#localVideo', '#lobbyVideo']) {
		const video = document.querySelector(selector);
		if (!video) continue;
		video.pause();
		video.srcObject = null;
	}
	localStream.getTracks().forEach((track) => track.stop());
	microphoneStream = null;
	cameraStream = null;
	localStream = new MediaStream();
	mediaProvider?.disconnect();
}
function renderEndedMeeting(message = 'This meeting has ended.') { stopLocalMedia(); realtime?.close(); document.querySelector('#workspaceHeader').innerHTML = `<a class="workspace-brand" href="../dashboard/index.html"><span>✦</span><span>meetmind <small>AI</small></span></a>`; document.querySelector('#workspaceGrid').innerHTML = `<section class="ended-card"><span class="ended-mark">✓</span><p class="panel-kicker">MEETING COMPLETE</p><h1>Thanks for meeting with MeetMind</h1><p>${escapeHtml(message)}</p><a class="control-button" href="../dashboard/index.html">Back to dashboard</a></section>`; document.querySelector('#controls').innerHTML = ''; }
function confirmEndOrLeave() { const modal = document.createElement('div'); modal.className = 'modal-backdrop'; modal.innerHTML = `<section class="modal-card"><h2>Leave this meeting?</h2><p>${isHost() ? 'You can leave while the meeting continues, or end it for everyone.' : 'You will leave this meeting.'}</p><div class="modal-actions"><button class="small-button" data-lifecycle="leave">Leave meeting</button>${isHost() ? '<button class="small-button" data-lifecycle="end">End meeting for everyone</button>' : ''}<button class="small-button" data-lifecycle="cancel">Stay</button></div></section>`; document.body.appendChild(modal); }
async function leaveMeeting() {
	try {
		const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/leave`, {
			method: 'POST',
			headers: authHeaders,
		});
		if (response.status === 401) {
			sessionStorage.removeItem(TOKEN_KEY);
			window.location.replace('../login/index.html');
			return;
		}
		const result = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(result.detail || 'Unable to leave this meeting.');
		stopLocalMedia();
		realtime?.close();
		window.location.replace('../dashboard/index.html');
	} catch (error) {
		showToast(error.message, 'error');
	}
}
async function updateMeetingLifecycle(action) { const endpoint = action === 'start' ? 'start' : 'end'; const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/${endpoint}`, { method: 'POST', headers: authHeaders }); if (!response.ok) { const detail = await response.json().catch(() => ({})); showToast(detail.detail || `Unable to ${endpoint} meeting.`); return; } window.location.reload(); }
async function toggleFullscreen() { try { const stage = document.querySelector('#mediaGrid'); if (!stage) return; if (document.fullscreenElement) await document.exitFullscreen(); else await stage.requestFullscreen(); } catch { showToast('Fullscreen could not be started. Check browser fullscreen permissions.'); } }
function handleAction(action, target) { if (action === 'microphone' || action === 'mute') return toggleMicrophone(); if (action === 'camera') return toggleCamera(); if (action === 'meeting-settings') return openMeetingSettings(); if (action === 'prejoin-allow' || action === 'prejoin-retry') return completePreJoin(); if (action === 'prejoin-leave') return leaveMeeting(); if (action === 'settings-close') return document.querySelector('#settingsModal')?.remove(); if (action === 'fullscreen') return toggleFullscreen(); if (action === 'start-timer') { const minutes = Number(document.querySelector('#timerMinutes')?.value) || 2; return startQuestionTimer(minutes * 60); } if (action === 'start') return updateMeetingLifecycle('start'); if (action === 'end') return confirmEndOrLeave(); if (action === 'delete-note') return deleteNote(); if (action === 'download-notes') return downloadNotes(); if (action === 'export-pdf') return exportPdf(); }
async function manageParticipant(action, userId, role) {
	const url = `${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(userId)}`;
	const response = await fetch(url, {
		method: action === 'remove' ? 'DELETE' : 'PATCH',
		headers: { ...authHeaders, 'Content-Type': 'application/json' },
		...(action === 'role' ? { body: JSON.stringify({ role }) } : {}),
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		showToast(data.detail || 'Unable to update participant.', 'error');
		return;
	}
	meetingState = data;
	renderParticipantPanel();
	showToast(action === 'remove' ? 'Participant removed.' : 'Participant role updated.');
}
async function transferHost(userId, name) {
	if (!window.confirm(`Make ${name} the host? You will lose host controls.`)) return;
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(userId)}/host`, {
		method: 'POST',
		headers: authHeaders,
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) {
		showToast(data.detail || 'Unable to transfer host access.', 'error');
		return;
	}
	applyHostTransfer({
		host_user_id: data.host_user_id,
		host_name: data.participants?.find((person) => person.user_id === data.host_user_id)?.name,
	});
}
function applyHostTransfer(payload) {
	const panelOpen = document.querySelector('.support-panel.panel-open')?.dataset.panel;
	const hostId = payload.host_user_id;
	if (!hostId || !meetingState || meetingState.host_user_id === hostId) return;
	meetingState.host_user_id = hostId;
	meetingState.participants.forEach((participant) => {
		if (participant.user_id === hostId) participant.role = 'host';
		else if (participant.role === 'host') participant.role = 'participant';
	});
	participantsState.forEach((participant, userId) => {
		if (userId === hostId) participant.role = 'host';
		else if (participant.role === 'host') participant.role = 'participant';
	});

	const sidebar = document.querySelector('#roomSidebar');
	const notesPanel = sidebar?.querySelector('.notes-panel');
	if (isHost()) {
		if (panelOpen === 'notes') setActivePanel(null, false);
		notesPanel?.remove();
		notes = [];
		activeNoteId = null;
		window.clearTimeout(noteSaveTimer);
	} else if (sidebar && !notesPanel) {
		sidebar.insertAdjacentHTML('beforeend', NotesPanel());
		loadNotes();
	}
	const transcriptPanel = sidebar?.querySelector('.transcript-panel');
	if (isHost()) {
		if (panelOpen === 'transcript') setActivePanel(null, false);
		transcriptPanel?.remove();
		transcriptEntries.clear();
		transcriptHistoryLoaded = false;
	} else if (sidebar && !transcriptPanel) {
		sidebar.insertAdjacentHTML('beforeend', TranscriptPanel());
		renderTranscriptEntries();
		loadTranscriptHistory();
	}

	document.querySelector('#controls').innerHTML = MeetingControls(meetingState);
	renderParticipantPanel();
	for (const panelName of ['questions', 'tasks', 'topics']) {
		const panel = sidebar?.querySelector(`[data-panel="${panelName}"]`);
		if (!panel) continue;
		const wasOpen = panel.classList.contains('panel-open');
		const html = panelName === 'questions'
			? QAPanel(meetingState)
			: panelName === 'tasks' ? TaskPanel() : TopicsPanel();
		const replacement = new DOMParser().parseFromString(html, 'text/html').body.firstElementChild;
		replacement.classList.toggle('panel-open', wasOpen);
		panel.replaceWith(replacement);
	}
	document.querySelectorAll('.media-tile').forEach((tile) => {
		const existingBadge = tile.querySelector('.host-badge');
		const isCurrentHost = tile.dataset.userId === hostId;
		if (isCurrentHost && !existingBadge) {
			const badge = document.createElement('span');
			badge.className = 'host-badge';
			badge.textContent = 'Host';
			tile.appendChild(badge);
		} else if (!isCurrentHost) {
			existingBadge?.remove();
		}
	});
	if (panelOpen && !(panelOpen === 'notes' && isHost())) setActivePanel(panelOpen, false);
	updateMediaControls();
	renderQuestions();
	renderScheduledQuestions();
	loadScheduledQuestions();
	loadTasks();
	loadTopics();
	if (payload.host_name) showToast(`${payload.host_name} is now the host.`, 'success');
}
async function boot() { if (!meetingId) { document.querySelector('#loading').textContent = 'No meeting ID was provided.'; return; } try { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}`, { headers: authHeaders }); if (response.status === 401) { sessionStorage.removeItem(TOKEN_KEY); window.location.replace('../login/index.html'); return; } const meeting = await response.json(); if (!response.ok) throw new Error(meeting.detail || 'Meeting not found or you do not have access.'); meetingState = meeting; document.querySelector('#loading').remove(); if (meeting.status === 'completed' || meeting.status === 'cancelled') { renderEndedMeeting(meeting.status === 'cancelled' ? 'This meeting was cancelled.' : 'This meeting has ended.'); return; } await loadIceServers(); renderWorkspace(meeting); } catch (error) { document.querySelector('#loading').textContent = error.message; } }
document.addEventListener('click', (event) => { const noteTarget = event.target.closest('[data-note-id]'); if (noteTarget) { const note = notes.find((item) => item.id === noteTarget.dataset.noteId); if (note) selectNote(note); return; } const target = event.target.closest('[data-action]'); if (target) handleAction(target.dataset.action, target); });
document.addEventListener('click', (event) => { const action = event.target.closest('[data-lifecycle]')?.dataset.lifecycle; if (!action) return; event.target.closest('.modal-backdrop')?.remove(); if (action === 'cancel') { modalReturnFocus?.focus?.({ preventScroll: true }); modalReturnFocus = null; } if (action === 'leave') leaveMeeting(); if (action === 'end') updateMeetingLifecycle('end'); });
document.addEventListener('keydown', (event) => { if (event.target.matches('#chatForm textarea') && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.target.form.requestSubmit(); } });
document.addEventListener('click', (event) => { const tile = event.target.closest('.media-tile'); if (tile && !event.target.closest('button')) { const wasPinned = tile.classList.contains('pinned'); document.querySelectorAll('.media-tile').forEach((item) => item.classList.remove('pinned')); if (!wasPinned) tile.classList.add('pinned'); document.querySelector('#mediaGrid')?.classList.toggle('spotlight', !wasPinned); } });
document.addEventListener('change', (event) => { const target = event.target.closest('[data-participant-action="role"]'); if (target) manageParticipant('role', target.dataset.userId, target.value); });
document.addEventListener('click', (event) => { const target = event.target.closest('[data-participant-action="remove"]'); if (target) manageParticipant('remove', target.dataset.userId); });
document.addEventListener('click', (event) => {
	const target = event.target.closest('[data-participant-action="host"]');
	if (target) transferHost(target.dataset.userId, target.dataset.participantName || 'this participant');
});
document.addEventListener('click', (event) => {
	const edit = event.target.closest('[data-task-edit]');
	if (edit) {
		editTask(edit.dataset.taskEdit);
		return;
	}
	const target = event.target.closest('[data-task-delete]');
	if (target) deleteTask(target.dataset.taskDelete);
});
document.addEventListener('click', (event) => {
	const target = event.target.closest('[data-scheduled-action]');
	if (!target) return;
	const questionId = target.dataset.questionId;
	if (target.dataset.scheduledAction === 'activate') activateScheduledQuestion(questionId);
	if (target.dataset.scheduledAction === 'delete') deleteScheduledQuestion(questionId);
	if (target.dataset.scheduledAction === 'up') moveScheduledQuestion(questionId, -1);
	if (target.dataset.scheduledAction === 'down') moveScheduledQuestion(questionId, 1);
});
document.addEventListener('click', (event) => {
	const edit = event.target.closest('[data-topic-edit]');
	if (edit) {
		const topic = meetingTopics.find((item) => item.id === edit.dataset.topicEdit);
		if (!topic) return;
		const title = window.prompt('Edit topic title', topic.title);
		if (title === null) return;
		const description = window.prompt('Edit topic description', topic.description || '');
		if (description === null) return;
		updateTopic(topic.id, { title: title.trim(), description: description.trim() || null });
		return;
	}
	const publish = event.target.closest('[data-topic-publish]');
	if (publish) {
		const topic = meetingTopics.find((item) => item.id === publish.dataset.topicPublish);
		if (topic) updateTopic(topic.id, { is_published: !topic.is_published });
		return;
	}
	const remove = event.target.closest('[data-topic-delete]');
	if (remove) deleteTopic(remove.dataset.topicDelete);
});
document.addEventListener('fullscreenchange', () => { const button = document.querySelector('[data-action="fullscreen"]'); if (button) button.dataset.tooltip = document.fullscreenElement ? 'Exit fullscreen (F)' : 'Fullscreen (F)'; });
document.addEventListener('submit', (event) => {
	if (event.target.id === 'qaForm') {
		event.preventDefault();
		const question = new FormData(event.target).get('question')?.toString().trim();
		if (question) submitQuestion(question);
		event.target.reset();
	}
	if (event.target.id === 'scheduledQuestionForm') {
		event.preventDefault();
		return saveScheduledQuestion(event.target);
	}
	if (event.target.matches('[data-scheduled-edit]')) {
		event.preventDefault();
		return saveScheduledQuestion(event.target, event.target.dataset.scheduledEdit);
	}
	if (event.target.classList.contains('scheduled-answer-form')) {
		event.preventDefault();
		const answer = new FormData(event.target).get('answer')?.toString().trim();
		if (answer) submitScheduledAnswer(event.target.dataset.questionId, answer);
	}
	if (event.target.classList.contains('answer-form')) {
		event.preventDefault();
		const answer = new FormData(event.target).get('answer')?.toString().trim();
		if (answer) answerQuestion(event.target.dataset.questionId, answer);
	}
	if (event.target.id === 'chatForm') {
		event.preventDefault();
		const content = new FormData(event.target).get('content')?.toString().trim();
		if (content) sendChatMessage(content);
		event.target.reset();
	}
});
document.addEventListener('submit', (event) => {
	if (event.target.id !== 'taskForm') return;
	event.preventDefault();
	const form = new FormData(event.target);
	const title = form.get('title')?.toString().trim();
	if (!title) return;
	const localDeadline = form.get('due_at')?.toString();
	createTask({
		title,
		description: form.get('description')?.toString().trim() || null,
		assignee_id: form.get('assignee_id')?.toString() || null,
		due_at: localDeadline ? new Date(localDeadline).toISOString() : null,
	});
	event.target.reset();
});
document.addEventListener('submit', (event) => {
	if (event.target.id !== 'topicForm') return;
	event.preventDefault();
	const form = new FormData(event.target);
	const title = form.get('title')?.toString().trim();
	if (!title) return;
	createTopic({
		title,
		description: form.get('description')?.toString().trim() || null,
		is_important: form.get('is_important') === 'on',
		is_published: form.get('is_published') === 'on',
	});
	event.target.reset();
});
document.addEventListener('submit', (event) => { if (event.target.id === 'settingsForm') { event.preventDefault(); saveMeetingSettings(event.target); } });
document.addEventListener('change', (event) => { const task = event.target.closest('[data-task-id]'); if (task) updateTaskStatus(task.dataset.taskId, task.value); });
let roomPanelReturnFocus = null;
let selectedCameraId = '';
let selectedMicrophoneId = '';
let meetingClockTimer;
let fullscreenIdleTimer;
let fullscreenLastActivity = 0;
let modalReturnFocus = null;

const roomPanelTitles = {
	participants: 'Participants',
	chat: 'Chat',
	questions: 'Questions',
	transcript: 'Transcript',
	notes: 'Notes',
	tasks: 'Tasks',
	topics: 'Topics',
};

function roomIcon(name, size = 20) {
	const aliases = { '◉': 'camera', '◌': 'camera', 'Q': 'question', '✓': 'check', '文': 'captions', '·': 'message', '✧': 'topics', '◆': 'topics' };
	return window.MMIcons?.[aliases[name] || name]?.(size) || '';
}
function roomStatus(meeting) {
	if (meeting.status === 'scheduled') return 'Scheduled';
	if (['live', 'in_progress', 'started'].includes(meeting.status)) return 'Live';
	return 'Ended';
}
function applyRoomTheme(theme) {
	const root = document.querySelector('#roomShell');
	if (!root) return;
	root.dataset.theme = theme === 'light' ? 'light' : 'dark';
	const button = document.querySelector('#themeToggle');
	if (button) {
		button.innerHTML = roomIcon(theme === 'light' ? 'moon' : 'sun');
		button.setAttribute('aria-label', `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`);
		button.dataset.tooltip = `Switch to ${theme === 'light' ? 'dark' : 'light'} theme`;
	}
}
function initializeRoomTheme() {
	let theme = 'light';
	try { theme = localStorage.getItem('meetmind-theme') || localStorage.getItem('meetmind-room-theme') || 'light'; } catch { }
	applyRoomTheme(theme);
}
function MeetingHeader(meeting) {
	const status = roomStatus(meeting);
	const when = status === 'Scheduled'
		? `Starts ${formatDate(meeting.start_time)}`
		: status === 'Live' && meeting.started_at
			? '00:00'
			: status;
	return `<a class="workspace-brand" href="../dashboard/index.html" aria-label="MeetMind dashboard">${roomIcon('logo', 26)}</a>
		<div class="header-meeting-copy"><h1>${escapeHtml(meeting.title)}</h1><p>${escapeHtml(meeting.meeting_type)} · ${escapeHtml(meeting.privacy_mode)}</p></div>
		<div class="header-live-meta"><span class="meeting-clock" id="meetingClock">${escapeHtml(when)}</span><span class="meeting-status status-${status.toLowerCase()}" id="meetingStatus">${status}</span><span class="connection-status" id="connectionStatus" data-status="connecting"><i></i><span>Connecting</span></span></div>
		<div class="header-right"><button class="icon-button theme-toggle" id="themeToggle" type="button" data-action="theme-toggle" aria-label="Switch to light theme" data-tooltip="Switch theme">${roomIcon('sun')}</button><button class="participant-count-chip" type="button" data-panel-open="participants" aria-expanded="false" aria-label="Open participants"><span class="count-icon">${roomIcon('users', 17)}</span><span id="headerParticipantCount">${participantsState.size || meeting.participants.length}</span></button><span class="language-badge" aria-label="Meeting language">${escapeHtml((meeting.language || 'en').toUpperCase())}</span><button class="profile-button" type="button" data-action="dashboard" aria-label="Back to dashboard" data-tooltip="Dashboard">${escapeHtml(initials(currentParticipant()?.name || 'MeetMind'))}</button></div>`;
}
function EmptyPanel({ icon = 'info', title, message = '', className = '' }) {
	return `<div class="empty-panel ${className}"><span class="empty-panel-icon">${roomIcon(icon, 19)}</span><p>${escapeHtml(title || '')}${message ? ` <span>${escapeHtml(message)}</span>` : ''}</p></div>`;
}
function setTranscriptStatus(message, state = 'live') {
	const status = document.querySelector('#transcriptLiveStatus');
	if (!status) return;
	status.dataset.state = state;
	status.querySelector('span').textContent = message;
}
function updateTranscriptConnectionStatus(status) {
	if (isHost()) return;
	if (status === 'connected') {
		setTranscriptStatus('Live · waiting for speech');
		return;
	}
	if (status === 'disconnected') {
		clearOwnTranscriptInterims();
		renderTranscriptEntries();
	}
	setTranscriptStatus(status === 'disconnected' ? 'Reconnecting to meeting…' : 'Connecting to meeting audio…', 'connecting');
}
function transcriptEntryKey(entry) {
	return String(entry.transcript_id || entry.id || `${entry.speaker_id || ''}:${entry.timestamp || ''}:${entry.text || ''}`);
}
function transcriptUtteranceKey(entry) {
	return `${entry.speaker_id || ''}:${entry.utterance_id}`;
}
function createTranscriptEntryNode(entry) {
	const item = document.createElement('article');
	item.className = `transcript-entry${entry.is_interim ? ' is-interim' : ''}`;
	item.dataset.transcriptId = transcriptEntryKey(entry);
	if (entry.is_interim) item.dataset.utteranceKey = transcriptUtteranceKey(entry);
	const heading = document.createElement('div');
	heading.className = 'transcript-entry-heading';
	const speaker = document.createElement('b');
	speaker.textContent = entry.speaker_name || entry.speaker || 'Speaker';
	const timestamp = document.createElement('time');
	const date = new Date(entry.timestamp || entry.ended_at || entry.created_at || Number.NaN);
	timestamp.dateTime = Number.isNaN(date.getTime()) ? '' : date.toISOString();
	timestamp.textContent = Number.isNaN(date.getTime())
		? ''
		: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
	heading.append(speaker, timestamp);
	const text = document.createElement('p');
	text.textContent = entry.text || '';
	item.append(heading, text);
	return item;
}
function clearOwnTranscriptInterims() {
	transcriptInterims.forEach((entry, key) => {
		if (entry.speaker_id === currentUserId) transcriptInterims.delete(key);
	});
}
function renderTranscriptEntries() {
	const output = document.querySelector('#transcriptContent');
	if (!output) return;
	const wasNearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 36;
	const oldScrollTop = output.scrollTop;
	const entries = [...transcriptEntries.values(), ...transcriptInterims.values()].sort((left, right) => {
		const sequenceDifference = Number(left.sequence_number) - Number(right.sequence_number);
		if (Number.isFinite(sequenceDifference) && sequenceDifference !== 0) return sequenceDifference;
		return new Date(left.timestamp || 0) - new Date(right.timestamp || 0);
	}).slice(-500);
	if (!entries.length) {
		output.innerHTML = EmptyPanel({ icon: 'captions', title: transcriptHistoryLoaded ? 'Transcript will appear here when someone speaks.' : 'Loading transcript history…' });
		return;
	}
	output.replaceChildren();
	for (const entry of entries) output.append(createTranscriptEntryNode(entry));
	output.scrollTop = wasNearBottom ? output.scrollHeight : oldScrollTop;
}
function addTranscriptEntry(entry) {
	if (isHost() || !entry?.text) return;
	const utteranceKey = entry.utterance_id === undefined ? null : transcriptUtteranceKey(entry);
	if (utteranceKey) transcriptInterims.delete(utteranceKey);
	const key = transcriptEntryKey(entry);
	if (transcriptEntries.has(key)) return;
	transcriptEntries.set(key, entry);
	const output = document.querySelector('#transcriptContent');
	if (output) {
		const wasNearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 36;
		const interim = utteranceKey
			? output.querySelector(`[data-utterance-key="${CSS.escape(utteranceKey)}"]`)
			: null;
		const item = createTranscriptEntryNode(entry);
		if (interim) interim.replaceWith(item);
		else {
			if (output.querySelector('.empty-panel')) output.replaceChildren();
			output.append(item);
		}
		while (output.querySelectorAll('.transcript-entry').length > 500) output.firstElementChild?.remove();
		output.scrollTop = wasNearBottom ? output.scrollHeight : output.scrollTop;
	}
	setTranscriptStatus('Live · transcript updated');
}
function addTranscriptInterim(entry) {
	if (isHost() || !entry?.text || entry.utterance_id === undefined) return;
	const utteranceKey = transcriptUtteranceKey(entry);
	transcriptInterims.set(utteranceKey, { ...entry, is_interim: true });
	const output = document.querySelector('#transcriptContent');
	if (output) {
		const wasNearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 36;
		const interim = output.querySelector(`[data-utterance-key="${CSS.escape(utteranceKey)}"]`);
		const item = createTranscriptEntryNode({ ...entry, is_interim: true });
		if (interim) interim.replaceWith(item);
		else {
			if (output.querySelector('.empty-panel')) output.replaceChildren();
			output.append(item);
		}
		while (output.querySelectorAll('.transcript-entry').length > 500) output.firstElementChild?.remove();
		output.scrollTop = wasNearBottom ? output.scrollHeight : output.scrollTop;
	}
	setTranscriptStatus('Live · recognizing speech');
}
async function loadTranscriptHistory(force = false) {
	if (isHost() || transcriptHistoryPromise || (transcriptHistoryLoaded && !force)) return transcriptHistoryPromise;
	const output = document.querySelector('#transcriptContent');
	if (output && !transcriptEntries.size) {
		output.innerHTML = EmptyPanel({ icon: 'captions', title: 'Loading transcript history…' });
	}
	transcriptHistoryPromise = (async () => {
		try {
			const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/transcripts`, { headers: authHeaders });
			const result = await response.json().catch(() => ({}));
			if (!response.ok) throw new Error(result.detail || 'Unable to load transcript history.');
			if (isHost()) return true;
			result.forEach((entry) => transcriptEntries.set(transcriptEntryKey(entry), entry));
			transcriptHistoryLoaded = true;
			renderTranscriptEntries();
			return true;
		} catch (error) {
			if (output && !transcriptEntries.size) {
				output.innerHTML = EmptyPanel({ icon: 'captions', title: 'Transcript history is temporarily unavailable.', message: error.message });
			}
			return false;
		} finally {
			transcriptHistoryPromise = null;
		}
	})();
	return transcriptHistoryPromise;
}
function setLiveCaptionStatus(message, isError = false) {
	const status = document.querySelector('#liveCaptionStatus');
	if (status) {
		status.textContent = message;
		status.classList.toggle('is-error', isError);
	}
}
function connectLiveCaptionSocket() {
	if (!liveCaptionState.active) return;
	const socketUrl = new URL('/ws/live', API_URL);
	socketUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	socketUrl.searchParams.set('src', liveCaptionState.source);
	socketUrl.searchParams.set('tgt', liveCaptionState.target);
	const generation = ++liveCaptionState.socketGeneration;
	const socket = new WebSocket(socketUrl);
	liveCaptionState.socket = socket;
	socket.binaryType = 'arraybuffer';
	socket.addEventListener('open', () => {
		if (!liveCaptionState.active || liveCaptionState.socket !== socket) {
			socket.close();
			return;
		}
		liveCaptionState.reconnectDelay = 1000;
		setLiveCaptionStatus('Listening');
	});
	socket.addEventListener('message', (event) => {
		if (!liveCaptionState.active || liveCaptionState.socket !== socket) return;
		let message;
		try { message = JSON.parse(event.data); } catch { return; }
		if (message.type === 'status') setLiveCaptionStatus('Listening');
		if (message.type === 'error') setLiveCaptionStatus(message.message || 'Live translation failed.', true);
		if (message.type !== 'caption') return;

		const output = document.querySelector('#liveCaptionOutput');
		if (!output) return;
		const captionKey = `${generation}:${message.id}`;
		let line = liveCaptionState.captions.get(captionKey);
		if (!line) {
			if (output.querySelector('.empty-panel')) output.replaceChildren();
			line = document.createElement('article');
			line.className = 'live-caption-line';
			line.dataset.captionId = String(message.id);
			const translated = document.createElement('p');
			translated.className = 'live-caption-translated';
			const original = document.createElement('small');
			original.className = 'live-caption-original';
			line.append(translated, original);
			output.append(line);
			liveCaptionState.captions.set(captionKey, line);
		}
		if (line.dataset.final === 'true' && !message.final) return;
		line.dataset.final = String(Boolean(message.final));
		line.classList.toggle('is-interim', !message.final);
		line.querySelector('.live-caption-translated').textContent = message.translated || '';
		line.querySelector('.live-caption-original').textContent = message.original || '';
		output.scrollTop = output.scrollHeight;
	});
	socket.addEventListener('error', () => {
		if (liveCaptionState.active && liveCaptionState.socket === socket) {
			setLiveCaptionStatus('Connection error; reconnecting…', true);
		}
	});
	socket.addEventListener('close', () => {
		if (!liveCaptionState.active || liveCaptionState.socket !== socket) return;
		setLiveCaptionStatus('Reconnecting…');
		clearTimeout(liveCaptionState.reconnectTimer);
		liveCaptionState.reconnectTimer = setTimeout(connectLiveCaptionSocket, liveCaptionState.reconnectDelay);
		liveCaptionState.reconnectDelay = Math.min(liveCaptionState.reconnectDelay * 2, 10000);
	});
}
async function startLiveCaptionCapture() {
	const startButton = document.querySelector('[data-live-action="toggle"]');
	const sourceSelect = document.querySelector('#liveSpeakingLanguage');
	const targetSelect = document.querySelector('#liveCaptionLanguage');
	const audioSource = document.querySelector('#liveAudioSource')?.value || 'microphone';
	if (!navigator.mediaDevices || !window.AudioWorkletNode || !window.AudioContext) {
		throw new Error('This browser does not support live audio capture.');
	}
	let capturedStream;
	if (audioSource === 'tab') {
		if (!navigator.mediaDevices.getDisplayMedia) throw new Error('Tab audio capture is not supported in this browser.');
		capturedStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
		capturedStream.getVideoTracks().forEach((track) => track.stop());
	} else {
		capturedStream = await navigator.mediaDevices.getUserMedia({ audio: true });
	}
	const audioTrack = capturedStream.getAudioTracks()[0];
	if (!audioTrack) {
		capturedStream.getTracks().forEach((track) => track.stop());
		throw new Error('The selected audio source did not provide an audio track.');
	}
	liveCaptionState.stream = new MediaStream([audioTrack]);
	liveCaptionState.source = sourceSelect?.value || 'en';
	liveCaptionState.target = targetSelect?.value || 'ml';
	liveCaptionState.captions.clear();
	document.querySelector('#liveCaptionOutput')?.replaceChildren();
	const context = new AudioContext({ sampleRate: 16000 });
	liveCaptionState.context = context;
	await context.audioWorklet.addModule(new URL('./live-audio-worklet.js', window.location.href));
	const source = context.createMediaStreamSource(liveCaptionState.stream);
	const worklet = new AudioWorkletNode(context, 'live-pcm-processor');
	const silentGain = context.createGain();
	silentGain.gain.value = 0;
	worklet.port.onmessage = ({ data }) => {
		if (!liveCaptionState.active || liveCaptionState.socket?.readyState !== WebSocket.OPEN || data?.type !== 'audio' || !data.samples?.length) return;
		const samples = data.samples;
		const pcm = new Int16Array(samples.length);
		for (let index = 0; index < samples.length; index += 1) {
			const sample = Math.max(-1, Math.min(1, samples[index]));
			pcm[index] = sample < 0 ? sample * 32768 : sample * 32767;
		}
		liveCaptionState.socket.send(pcm.buffer);
	};
	source.connect(worklet);
	worklet.connect(silentGain);
	silentGain.connect(context.destination);
	liveCaptionState.worklet = worklet;
	await context.resume();
	liveCaptionState.active = true;
	if (startButton) startButton.textContent = 'Stop';
	if (sourceSelect) sourceSelect.disabled = true;
	if (targetSelect) targetSelect.disabled = true;
	const audioSourceSelect = document.querySelector('#liveAudioSource');
	if (audioSourceSelect) audioSourceSelect.disabled = true;
	setLiveCaptionStatus('Connecting…');
	connectLiveCaptionSocket();
	audioTrack.addEventListener('ended', () => {
		if (liveCaptionState.active) stopLiveCaptionCapture('Audio source ended.');
	}, { once: true });
}
function stopLiveCaptionCapture(message = 'Stopped') {
	liveCaptionState.active = false;
	clearTimeout(liveCaptionState.reconnectTimer);
	liveCaptionState.reconnectTimer = null;
	liveCaptionState.socket?.close(1000, 'Capture stopped');
	liveCaptionState.socket = null;
	liveCaptionState.worklet?.port.close();
	liveCaptionState.worklet?.disconnect();
	liveCaptionState.worklet = null;
	liveCaptionState.stream?.getTracks().forEach((track) => track.stop());
	liveCaptionState.stream = null;
	if (liveCaptionState.context && liveCaptionState.context.state !== 'closed') {
		liveCaptionState.context.close().catch((error) => console.warn('Unable to close audio context:', error));
	}
	liveCaptionState.context = null;
	const startButton = document.querySelector('[data-live-action="toggle"]');
	if (startButton) startButton.textContent = 'Start';
	['#liveSpeakingLanguage', '#liveCaptionLanguage', '#liveAudioSource'].forEach((selector) => {
		const control = document.querySelector(selector);
		if (control) control.disabled = false;
	});
	setLiveCaptionStatus(message);
}
async function toggleLiveCaptionCapture(button) {
	if (liveCaptionState.active) {
		stopLiveCaptionCapture();
		return;
	}
	button.disabled = true;
	setLiveCaptionStatus('Connecting…');
	try {
		await startLiveCaptionCapture();
	} catch (error) {
		stopLiveCaptionCapture(`Error: ${error.message || 'Unable to start live captions.'}`);
		setLiveCaptionStatus(`Error: ${error.message || 'Unable to start live captions.'}`, true);
	} finally {
		button.disabled = false;
	}
}
function VideoStage() {
	const hostName = meetingState?.participants?.find((person) => person.user_id === meetingHostId())?.name || 'the host';
	return `<section class="video-stage" aria-label="Meeting video stage">
		<div class="stage-topline"><span class="stage-live-mark"><i></i>Meeting room</span><button class="icon-button stage-fullscreen-button" type="button" data-action="fullscreen" aria-label="Enter fullscreen" data-tooltip="Fullscreen (F)">${roomIcon('fullscreen')}</button></div>
		<div class="media-grid" id="mediaGrid" data-count="1" aria-label="Participant video grid">
			<article class="media-tile local-tile" data-stage-tile data-user-id="${escapeHtml(currentUserId || '')}"><video id="localVideo" autoplay muted playsinline></video><div class="remote-avatar tile-avatar">${escapeHtml(initials(currentParticipant()?.name || 'You'))}</div><div class="media-placeholder" id="mediaPlaceholder"><span class="placeholder-avatar">${escapeHtml(initials(currentParticipant()?.name || 'You'))}</span><b>Camera is off</b></div><div class="media-label"><span class="tile-name">You</span><span class="tile-mic-state" id="localMicState">${roomIcon('micOff', 15)}</span></div><span class="host-badge" ${isHost() ? '' : 'hidden'}>Host</span><span class="connection-badge">${roomIcon('connection', 14)}<span>Connected</span></span><div class="tile-hover-actions"><button type="button" data-action="pin-tile" aria-label="Spotlight your tile" data-tooltip="Spotlight">${roomIcon('pin')}</button><button type="button" disabled aria-label="More tile actions unavailable" data-tooltip="Available soon">${roomIcon('more')}</button></div><span class="media-state" id="mediaState">Camera off · Mic off</span></article>
			<div id="remoteTiles"></div>
		</div>
		<section class="stage-empty" id="stageEmpty" aria-live="polite"><span class="stage-empty-avatar">${escapeHtml(initials(currentParticipant()?.name || 'You'))}</span><h2 id="stageEmptyTitle">You're the only one here</h2><p id="stageEmptyText">${isHost() ? 'Copy the meeting link and invite people to join.' : `Waiting for ${escapeHtml(hostName)} and others to join.`}</p><button class="copy-link-button" id="copyMeetingLink" type="button" data-action="copy-meeting-link" ${isHost() ? '' : 'hidden'}>${roomIcon('copy', 16)}Copy meeting link</button></section>
		<div class="reaction-layer" id="reactionLayer" aria-live="polite"></div>
		<p class="admission-status hidden" id="admissionStatus">Waiting for required camera/microphone</p>
	</section>`;
}
function TranscriptPanel() {
	return `<section class="panel support-panel transcript-panel" data-panel="transcript"><div class="panel-heading"><div><p class="panel-kicker">LIVE</p><h2>Live Transcript</h2></div></div><p class="transcript-live-status" id="transcriptLiveStatus" data-state="connecting" role="status" aria-live="polite"><i></i><span>Connecting to meeting audio…</span></p><div class="panel-content transcript-content" id="transcriptContent" role="log" aria-live="polite" aria-relevant="additions text">${EmptyPanel({ icon: 'captions', title: 'Loading transcript history…' })}</div><div class="live-caption-controls"><label>Speaking language<select id="liveSpeakingLanguage" aria-label="Speaking language"><option value="en" selected>English</option><option value="ml">Malayalam</option><option value="te">Telugu</option><option value="hi">Hindi</option><option value="ta">Tamil</option><option value="kn">Kannada</option></select></label><label>Caption language<select id="liveCaptionLanguage" aria-label="Caption language"><option value="ml" selected>Malayalam</option><option value="en">English</option><option value="te">Telugu</option><option value="hi">Hindi</option><option value="ta">Tamil</option><option value="kn">Kannada</option></select></label><label>Audio source<select id="liveAudioSource" aria-label="Audio source"><option value="microphone">Microphone</option><option value="tab">Meeting / tab audio</option></select></label><button class="small-button" type="button" data-live-action="toggle">Start</button></div><p class="live-caption-status" id="liveCaptionStatus" role="status" aria-live="polite">Stopped</p><div class="live-caption-output" id="liveCaptionOutput" aria-live="polite">${EmptyPanel({ icon: 'captions', title: 'Translated live captions appear here.' })}</div></section>`;
}
function NotesPanel() {
	return `<section class="panel support-panel notes-panel" data-panel="notes"><div class="panel-heading"><div><p class="panel-kicker">PERSONAL</p><h2>Meeting notes</h2></div></div><div class="notes-list" id="notesList"></div><div class="notes-editor"><input class="notes-title" id="notesTitle" placeholder="Untitled note" aria-label="Note title"/><textarea class="notes-textarea" id="notesBody" placeholder="Start writing your thoughts..." aria-label="Meeting notes"></textarea><div class="notes-footer"><span id="saveState">New note</span><div class="notes-actions"><button class="small-button" data-action="delete-note">Delete</button><button class="small-button" data-action="download-notes">Text</button><button class="small-button" data-action="export-pdf">PDF</button></div></div></div></section>`;
}
function QAPanel(meeting) {
	const host = isHost();
	return `<section class="panel support-panel qa-panel" data-panel="questions"><div class="panel-heading"><div><p class="panel-kicker">${host ? 'HOST QUESTION SCHEDULE' : 'MEETING QUESTIONS'}</p><h2>Questions</h2></div></div>${host ? `<form class="scheduled-question-form" id="scheduledQuestionForm"><label>Question<textarea name="question" maxlength="2000" placeholder="Add a question for participants" required></textarea></label><div class="scheduled-question-form-grid"><label>Start after meeting start (seconds; blank = manual)<input name="scheduled_offset_seconds" type="number" min="0" max="86400" value="0"/></label><label>Answer duration (seconds; blank = no timer)<input name="answer_duration_seconds" type="number" min="10" max="3600" value="120"/></label></div><label class="scheduled-question-check"><input name="show_before_active" type="checkbox"/> Allow participants to preview before activation</label><button class="small-button" type="submit">Add to schedule</button><p class="schedule-help">Questions activate relative to the meeting start. Use “Activate now” for an immediate manual start.</p></form><div class="scheduled-question-workspace" id="scheduledQuestionWorkspace">${EmptyPanel({ icon: 'question', title: 'Loading schedule…' })}</div>` : `<div class="scheduled-question-workspace" id="scheduledQuestionWorkspace">${EmptyPanel({ icon: 'question', title: 'Loading current question…' })}</div>`}<div class="question-timer"><strong id="questionTimer">No active timer</strong>${host ? '<input id="timerMinutes" type="number" min="1" max="60" value="2" aria-label="Timer minutes"/><button class="small-button" data-action="start-timer">Start timer</button>' : ''}</div><div class="panel-heading question-list-heading"><div><p class="panel-kicker">OPEN Q&A</p><h2>Questions from the room</h2></div></div><div class="question-list" id="questionList">${EmptyPanel({ icon: 'Q', title: 'No questions yet.' })}</div><form class="qa-input-wrap" id="qaForm"><input class="qa-input" name="question" placeholder="Ask a question" aria-label="Ask a question" maxlength="2000" required/><button class="qa-send" type="submit" aria-label="Send question">${roomIcon('message')}</button></form></section>`;
}
function ChatPanel() {
	return `<section class="panel support-panel chat-panel" data-panel="chat"><div class="panel-heading"><div><p class="panel-kicker">MEETING CHAT</p><h2>Messages</h2></div></div><div class="chat-list" id="chatList">${EmptyPanel({ icon: 'message', title: 'No messages yet.' })}</div><form class="chat-form" id="chatForm"><textarea name="content" maxlength="2000" placeholder="Write a message..." aria-label="Chat message" required></textarea><button type="submit" aria-label="Send chat message">Send</button></form></section>`;
}
function TaskPanel() {
	const host = isHost();
	const assignees = [...participantsState.keys()]
		.map((userId) => meetingState?.participants?.find((participant) => participant.user_id === userId))
		.filter(Boolean);
	return `<section class="panel support-panel task-panel" data-panel="tasks">
		<div class="panel-heading">
			<div>
				<p class="panel-kicker">${host ? 'Host management' : 'Follow-ups'}</p>
				<h2>Tasks</h2>
			</div>
		</div>
		<div class="panel-content" id="taskList">${EmptyPanel({ icon: 'task', title: 'No tasks yet.' })}</div>
		${host ? `<form class="task-form" id="taskForm">
			<div class="task-form-grid">
				<input name="title" placeholder="Task title" aria-label="Task title" maxlength="255" required />
				<textarea name="description" placeholder="Description (optional)" aria-label="Task description" maxlength="5000"></textarea>
				<label>Assign to<select name="assignee_id" aria-label="Assign task"><option value="">All participants</option>${assignees.map((person) => `<option value="${escapeHtml(person.user_id)}">${escapeHtml(person.name || 'Participant')}</option>`).join('')}</select></label>
				<label>Deadline<input name="due_at" type="datetime-local" aria-label="Task deadline" /></label>
			</div>
			<div class="task-form-actions">
				<button class="small-button" type="button" data-action="close-panel">Cancel</button>
				<button type="submit">Add task</button>
			</div>
		</form>` : ''}
	</section>`;
}
function TopicsPanel() {
	return `<section class="panel support-panel topics-panel" data-panel="topics"><div class="panel-heading"><div><p class="panel-kicker">${isHost() ? 'HOST MANAGEMENT' : 'MEETING TOPICS'}</p><h2>Important topics</h2></div></div><div class="topics-content" id="topicsList"></div>${isHost() ? '<form class="topic-form" id="topicForm"><input name="title" placeholder="Topic title" aria-label="Topic title" maxlength="255" required/><textarea name="description" placeholder="Short description (optional)" aria-label="Topic description" maxlength="5000"></textarea><label><input type="checkbox" name="is_important"/> Mark important</label><label><input type="checkbox" name="is_published"/> Publish to participants</label><button type="submit">Add topic</button></form>' : ''}</section>`;
}
function ParticipantList(meeting) {
	const hostId = meeting.host_user_id || meeting.created_by;
	const host = isHost();
	const people = [...participantsState].map(([userId, state]) => ({
		...(meeting.participants.find((person) => person.user_id === userId) || {}),
		...state,
		user_id: userId,
	}));
	const rows = people.map((participant) => {
		const userId = participant.user_id;
		const state = participantsState.get(userId) || participant;
		const meetingHost = userId === hostId || participant.role === 'host';
		const isSelf = userId === currentUserId;
		const role = meetingHost ? '<span class="role-badge">Host</span>' : participant.role === 'viewer' ? '<span class="role-badge viewer">Viewer</span>' : '';
		const controls = host && !meetingHost ? `<span class="participant-actions"><button type="button" data-participant-action="host" data-user-id="${escapeHtml(userId)}" data-participant-name="${escapeHtml(participant.name || 'participant')}">Make host</button><select data-participant-action="role" data-user-id="${escapeHtml(userId)}" aria-label="Role for ${escapeHtml(participant.name || 'participant')}"><option value="participant" ${participant.role === 'participant' ? 'selected' : ''}>Participant</option><option value="viewer" ${participant.role === 'viewer' ? 'selected' : ''}>Viewer</option></select><button type="button" data-participant-action="remove" data-user-id="${escapeHtml(userId)}" aria-label="Remove ${escapeHtml(participant.name || 'participant')}" data-tooltip="Remove participant">${roomIcon('close', 16)}</button></span>` : '';
		const mic = typeof state.audio_enabled === 'boolean' ? roomIcon(state.audio_enabled ? 'mic' : 'micOff', 15) : '';
		const camera = typeof state.video_enabled === 'boolean' ? roomIcon(state.video_enabled ? 'camera' : 'videoOff', 15) : '';
		return `<article class="participant-row" data-user-id="${escapeHtml(userId)}"><span class="participant-avatar">${escapeHtml(initials(participant.name || 'MeetMind user'))}</span><span class="participant-copy"><b>${escapeHtml(participant.name || 'MeetMind user')}${isSelf ? ' <small>(You)</small>' : ''}</b><span class="participant-subline">${role}<i class="participant-connection ${escapeHtml(state.connectionState || 'connecting')}" aria-label="${escapeHtml(state.connectionState || 'connecting')}"></i>${mic}<span class="camera-state-icon">${camera}</span></span></span>${controls}</article>`;
	}).join('');
	return `<section class="panel support-panel participant-panel" data-panel="participants"><div class="panel-heading"><div><p class="panel-kicker">IN THIS MEETING</p><h2>Participants <span class="panel-count">${people.length}</span></h2></div></div><label class="participant-search">${roomIcon('search', 17)}<input type="search" id="participantSearch" placeholder="Search people" aria-label="Search participants"/></label><div class="mini-list">${rows || EmptyPanel({ icon: 'users', title: 'No participants yet.' })}</div></section>`;
}
function MeetingControls(meeting) {
	const host = isHost();
	const controls = [
		['participants', 'users', 'Participants'], ['chat', 'message', 'Chat'], ['questions', 'question', 'Questions'],
		...(!host ? [['notes', 'note', 'Notes'], ['transcript', 'captions', 'Transcript']] : []),
		['tasks', 'task', 'Tasks'], ['topics', 'topics', 'Topics'],
	];
	const panelButtons = controls.map(([panel, icon, label]) => `<button class="control-button panel-control" type="button" data-panel-open="${panel}" aria-label="Open ${label}" aria-expanded="false" data-tooltip="${label}${panel === 'participants' ? ' (P)' : panel === 'chat' || panel === 'questions' ? ' (C)' : ''}"><span>${roomIcon(icon)}</span><i class="unread-dot" data-unread="${panel}" hidden></i></button>`).join('');
	const morePanels = controls.filter(([panel]) => panel !== 'participants').map(([panel, icon, label]) => `<button type="button" data-panel-open="${panel}" aria-expanded="false">${roomIcon(icon, 16)}<span>${label}</span></button>`).join('');
	const reactions = ['👍', '👏', '❤️', '🎉', '😂', '❓'].map((reaction) => `<button type="button" data-reaction="${reaction}" aria-label="Send ${reaction}" data-tooltip="Send reaction">${reaction}</button>`).join('');
	return `<nav class="control-bar" role="toolbar" aria-label="Meeting controls">
		<div class="control-group control-group-left">${panelButtons}</div>
		<div class="control-group control-group-center">
			<div class="split-control"><button class="control-button media-control" id="micButton" type="button" data-action="microphone" data-media-control="microphone" aria-label="Enable microphone" aria-pressed="false" data-tooltip="Microphone (M)">${roomIcon('micOff')}</button><button class="split-chevron" type="button" data-action="toggle-mic-devices" aria-label="Choose microphone" data-tooltip="Microphone settings" hidden>${roomIcon('chevron', 14)}</button><div class="device-popover" id="micDeviceMenu" hidden><label>Microphone<select data-device-select="microphone" aria-label="Microphone device"></select></label></div></div>
			<div class="split-control"><button class="control-button media-control" id="cameraButton" type="button" data-action="camera" data-media-control="camera" aria-label="Enable camera" aria-pressed="false" data-tooltip="Camera (V)">${roomIcon('videoOff')}</button><button class="split-chevron" type="button" data-action="toggle-camera-devices" aria-label="Choose camera" data-tooltip="Camera settings" hidden>${roomIcon('chevron', 14)}</button><div class="device-popover" id="cameraDeviceMenu" hidden><label>Camera<select data-device-select="camera" aria-label="Camera device"></select></label></div></div>
			<button class="control-button share-control" type="button" disabled aria-label="Screen sharing coming soon" data-tooltip="Coming soon">${roomIcon('monitorUp')}</button>
			<div class="popover-anchor"><button class="control-button" type="button" data-action="toggle-reactions" aria-label="Open reactions" aria-expanded="false" data-tooltip="Reactions">${roomIcon('smile')}</button><div class="reaction-picker" id="reactionPicker" role="group" aria-label="Send reaction" hidden>${reactions}</div></div>
			<div class="mobile-panel-controls">${panelButtons}</div>
			<div class="popover-anchor more-anchor"><button class="control-button" type="button" data-action="toggle-more" aria-label="More meeting options" aria-expanded="false" data-tooltip="More">${roomIcon('more')}</button><div class="more-menu" id="moreMenu" hidden>${morePanels}<button type="button" data-action="bookmark" disabled data-tooltip="Available soon">${roomIcon('bookmark')}<span>Bookmark moment</span></button><button type="button" id="recordButton" data-action="record" disabled data-tooltip="Available soon"><span class="record-dot"></span><span>Recording unavailable</span></button><button type="button" data-action="fullscreen">${roomIcon('fullscreen')}<span>Fullscreen</span><kbd>F</kbd></button>${host ? `<button type="button" data-action="meeting-settings">${roomIcon('settings')}<span>Meeting settings</span></button>` : ''}<label class="menu-select">Caption language<select class="control-language" id="displayLanguage" aria-label="Caption language"><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="hi">Hindi</option></select></label><button type="button" data-action="shortcuts">${roomIcon('info')}<span>Keyboard shortcuts</span><kbd>?</kbd></button><button type="button" class="legacy-mute-action" id="muteButton" data-action="mute">Mute</button></div></div>
		</div>
		<div class="control-group control-group-right"><button class="leave-button" type="button" data-action="end" aria-label="Leave meeting">${roomIcon('phoneOff')}<span>Leave</span></button>${host ? `<button class="leave-chevron" type="button" data-action="toggle-leave" aria-label="More leave options" aria-expanded="false">${roomIcon('chevron', 15)}</button><div class="leave-menu" id="leaveMenu" hidden><button type="button" data-lifecycle="leave">Leave meeting</button><button type="button" data-action="end-for-all" class="danger-menu-item">End meeting for all</button></div>` : ''}</div>
	</nav>`;
}
function renderWorkspace(meeting) {
	const status = roomStatus(meeting);
	participantsState.clear();
	const self = meeting.participants.find((participant) => participant.user_id === currentUserId);
	if (self) participantsState.set(currentUserId, { ...self, connectionState: 'connected' });
	document.querySelector('#workspaceHeader').innerHTML = MeetingHeader(meeting);
	document.querySelector('#workspaceGrid').innerHTML = `<div class="room-layout"><div class="stage-column">${VideoStage()}</div><aside class="room-sidebar" id="roomSidebar" aria-label="Meeting panel" aria-hidden="true"><div class="drawer-heading"><h2 id="drawerTitle">Participants</h2><button class="icon-button" type="button" data-action="close-panel" aria-label="Close panel">${roomIcon('close')}</button></div>${ParticipantList(meeting)}${ChatPanel()}${QAPanel(meeting)}${!isHost() ? `${TranscriptPanel()}${NotesPanel()}` : ''}${TaskPanel()}${TopicsPanel()}</aside></div><button class="panel-backdrop" id="panelBackdrop" type="button" aria-label="Close meeting panel" hidden></button><section class="lobby-screen" id="lobbyScreen" aria-labelledby="lobbyTitle"><div class="lobby-card"><div class="lobby-preview"><video id="lobbyVideo" autoplay muted playsinline></video><div class="lobby-preview-placeholder" id="lobbyPreviewPlaceholder"><span>${roomIcon('camera', 26)}</span><b>Your camera is off</b><small>Turn it on when you're ready</small></div><span class="preview-label">Preview</span></div><div class="lobby-details"><p class="panel-kicker">${escapeHtml(meeting.meeting_type || 'MEETING')}</p><h1 id="lobbyTitle">${escapeHtml(meeting.title)}</h1><p class="lobby-host">Hosted by ${escapeHtml(meeting.participants.find((person) => person.user_id === (meeting.host_user_id || meeting.created_by))?.name || 'MeetMind host')}</p><p class="lobby-time">${escapeHtml(status === 'Scheduled' ? formatDate(meeting.start_time) : status)}</p><div class="lobby-participants" id="lobbyParticipants" aria-label="Participants already in the room"></div><div class="lobby-devices"><div class="lobby-device-row"><button class="lobby-toggle" type="button" data-action="microphone" data-media-control="microphone" aria-label="Turn microphone on" aria-pressed="false">${roomIcon('micOff')}<span>Microphone</span></button><select data-device-select="microphone" aria-label="Microphone device" hidden></select><div class="mic-meter" role="meter" aria-label="Microphone level" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="microphoneLevelFill"></i></div></div><div class="lobby-device-row"><button class="lobby-toggle" type="button" data-action="camera" data-media-control="camera" aria-label="Turn camera on" aria-pressed="false">${roomIcon('videoOff')}<span>Camera</span></button><select data-device-select="camera" aria-label="Camera device" hidden></select></div></div><div class="lobby-alert" id="preJoinModal" role="alert" hidden></div><div class="lobby-actions">${isHost() && status === 'Scheduled' ? '<button class="primary-button" type="button" data-action="start">Start meeting</button>' : '<button class="primary-button" type="button" data-action="join-now">Join now</button>'}<button class="lobby-back" type="button" data-action="end">Leave</button></div></div></div></section>`;
	document.querySelector('#controls').innerHTML = MeetingControls(meeting);
	document.querySelector('.lobby-back').dataset.action = 'prejoin-leave';
	participantsState.forEach((participant, userId) => { if (userId !== currentUserId) ensureRemoteTile(userId, participant); });
	initializeRoomTheme();
	setupWebRTC();
	updateMediaControls();
	updateStageLayout();
	renderLobbyParticipants();
	loadNotes();
	loadQuestions();
	loadScheduledQuestions();
	startScheduledQuestionPolling();
	loadChat();
	loadTasks();
	loadTopics();
	refreshDeviceOptions();
	updateParticipantCount();
	const root = document.querySelector('#roomShell');
	root.classList.remove('is-joined');
	try {
		const rememberedPanel = sessionStorage.getItem('meetmind-room-panel');
		if (roomPanelTitles[rememberedPanel]) setActivePanel(rememberedPanel, false);
	} catch { }
	if (meeting.started_at) startMeetingClock(meeting.started_at);
	if (settingsRequireMedia()) showPreJoinModal();
}
function updateParticipantCount() {
	const count = participantsState.size;
	const node = document.querySelector('#headerParticipantCount');
	if (node) node.textContent = String(count);
	const panelCount = document.querySelector('.participant-panel .panel-count');
	if (panelCount) panelCount.textContent = String(count);
}
function renderLobbyParticipants() {
	const list = document.querySelector('#lobbyParticipants');
	if (!list) return;
	list.innerHTML = [...participantsState].map(([userId, state]) => {
		const participant = meetingState?.participants?.find((person) => person.user_id === userId) || state;
		return `<span class="participant-avatar" title="${escapeHtml(participant.name || 'Participant')}">${escapeHtml(initials(participant.name || 'Participant'))}</span>`;
	}).join('');
}
function renderTaskPanel() {
	const panel = document.querySelector('.task-panel');
	if (!panel) return;
	const wasOpen = panel.classList.contains('panel-open');
	const replacement = new DOMParser().parseFromString(TaskPanel(), 'text/html').body.firstElementChild;
	replacement.classList.toggle('panel-open', wasOpen);
	panel.replaceWith(replacement);
}
function renderParticipantPanel() {
	const panel = document.querySelector('.participant-panel');
	if (!panel || !meetingState) return;
	const wasOpen = panel.classList.contains('panel-open');
	const replacement = new DOMParser().parseFromString(ParticipantList(meetingState), 'text/html').body.firstElementChild;
	replacement.classList.toggle('panel-open', wasOpen);
	panel.replaceWith(replacement);
}
function updateStageLayout() {
	const grid = document.querySelector('#mediaGrid');
	if (!grid) return;
	const remote = document.querySelector('#remoteTiles')?.children.length || 0;
	const count = 1 + remote;
	grid.dataset.count = String(count);
	const empty = document.querySelector('#stageEmpty');
	if (empty) empty.hidden = count > 1;
	updateParticipantCount();
}
function startMeetingClock(startedAt) {
	window.clearInterval(meetingClockTimer);
	const start = new Date(startedAt).getTime();
	if (!Number.isFinite(start)) return;
	const update = () => {
		const elapsed = Math.max(0, Math.floor((Date.now() - start) / 1000));
		const hours = Math.floor(elapsed / 3600);
		const minutes = Math.floor((elapsed % 3600) / 60);
		const seconds = elapsed % 60;
		const clock = document.querySelector('#meetingClock');
		if (clock) clock.textContent = hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
	};
	update();
	meetingClockTimer = window.setInterval(update, 1000);
}
function setActivePanel(panelName, moveFocus = true) {
	const sidebar = document.querySelector('#roomSidebar');
	if (!sidebar) return;
	if (panelName === 'transcript' && isHost()) {
		try { sessionStorage.removeItem('meetmind-room-panel'); } catch { }
		return;
	}
	const nextPanel = panelName && roomPanelTitles[panelName] ? panelName : null;
	const isSamePanel = panelState.active === nextPanel;
	const active = isSamePanel ? null : nextPanel;
	panelState.active = active;
	closeRoomPopovers();
	if (active && moveFocus) roomPanelReturnFocus = document.activeElement;
	document.querySelectorAll('.support-panel').forEach((panel) => panel.classList.toggle('panel-open', panel.dataset.panel === active));
	document.querySelectorAll('[data-panel-open]').forEach((button) => {
		const selected = button.dataset.panelOpen === active;
		button.classList.toggle('selected', selected);
		button.setAttribute('aria-expanded', String(selected));
	});
	sidebar.classList.toggle('is-open', Boolean(active));
	sidebar.setAttribute('aria-hidden', String(!active));
	document.querySelector('#drawerTitle').textContent = active ? roomPanelTitles[active] : 'Meeting panel';
	document.querySelector('#panelBackdrop').hidden = !active;
	document.querySelector('#roomShell').classList.toggle('panel-open', Boolean(active));
	if (active) {
		if (active === 'transcript') loadTranscriptHistory();
		if (active === 'chat') {
			chatUnreadCount = 0;
			document.querySelectorAll('[data-unread="chat"]').forEach((dot) => { dot.hidden = true; });
			const list = document.querySelector('#chatList');
			if (list) list.scrollTop = list.scrollHeight;
		}
		try { sessionStorage.setItem('meetmind-room-panel', active); } catch { }
		if (moveFocus) window.setTimeout(() => sidebar.querySelector('.panel-open input, .panel-open textarea, .panel-open button, .panel-open select')?.focus({ preventScroll: true }), 0);
	} else {
		try { sessionStorage.removeItem('meetmind-room-panel'); } catch { }
		if (moveFocus) roomPanelReturnFocus?.focus?.({ preventScroll: true });
		roomPanelReturnFocus = null;
	}
}
function closeRoomPopovers() {
	['moreMenu', 'reactionPicker', 'micDeviceMenu', 'cameraDeviceMenu', 'leaveMenu'].forEach((id) => {
		const popover = document.getElementById(id);
		if (popover) popover.hidden = true;
	});
	document.querySelectorAll('[data-action^="toggle-"]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
}
function updateMediaControls() {
	const settings = meetingState?.settings || {};
	const cameraOn = localMediaState().video_enabled;
	const microphoneOn = localMediaState().audio_enabled;
	const cameraLocked = !isHost() && settings.allow_camera_toggle === false && cameraOn;
	const microphoneLocked = !isHost() && settings.allow_microphone_toggle === false && microphoneOn;
	const controls = [
		['camera', document.querySelector('#cameraButton'), cameraOn, cameraLocked, 'Camera'],
		['microphone', document.querySelector('#micButton'), microphoneOn, microphoneLocked, 'Microphone'],
	];
	controls.forEach(([kind, button, enabled, locked, label]) => {
		if (button) {
			button.innerHTML = `${roomIcon(kind === 'camera' ? (enabled ? 'video' : 'videoOff') : (enabled ? 'mic' : 'micOff'))}${locked ? `<span class="lock-badge">${roomIcon('lock', 12)}</span>` : ''}`;
			button.classList.toggle('is-off', !enabled);
			button.classList.toggle('active', enabled);
			button.dataset.locked = String(locked);
			button.setAttribute('aria-pressed', String(enabled));
			button.setAttribute('aria-label', locked ? `The host does not allow you to turn off your ${label.toLowerCase()}` : `${enabled ? 'Turn off' : 'Turn on'} ${label.toLowerCase()}`);
			button.dataset.tooltip = locked ? `Locked by host · ${label}` : `${enabled ? 'Turn off' : 'Turn on'} ${label.toLowerCase()} (${kind === 'camera' ? 'V' : 'M'})`;
		}
		document.querySelectorAll(`[data-media-control="${kind}"]:not(#${kind === 'camera' ? 'cameraButton' : 'micButton'})`).forEach((control) => {
			control.classList.toggle('is-off', !enabled);
			control.classList.toggle('active', enabled);
			control.setAttribute('aria-pressed', String(enabled));
			control.setAttribute('aria-label', `${enabled ? 'Turn off' : 'Turn on'} ${label.toLowerCase()}`);
			control.innerHTML = `${roomIcon(kind === 'camera' ? (enabled ? 'video' : 'videoOff') : (enabled ? 'mic' : 'micOff'))}<span>${label}</span>`;
		});
	});
	const muteButton = document.querySelector('#muteButton');
	if (muteButton) muteButton.textContent = microphoneOn ? 'Mute microphone' : 'Unmute microphone';
}
function updateMediaState(broadcast = true) {
	const { video_enabled: cameraOn, audio_enabled: micOn } = localMediaState();
	const state = document.querySelector('#mediaState');
	if (state) state.textContent = `Camera ${cameraOn ? 'on' : 'off'} · Mic ${micOn ? 'on' : 'off'}`;
	const micState = document.querySelector('#localMicState');
	if (micState) micState.innerHTML = roomIcon(micOn ? 'mic' : 'micOff', 15);
	if (broadcast) realtime?.sendMediaState({ audio_enabled: micOn, video_enabled: cameraOn });
	if (!micOn && (microphoneAudioWorklet || microphoneAudioStarting)) stopMicrophoneTranscription();
	else if (micOn && document.querySelector('#connectionStatus')?.dataset.status === 'connected') startMicrophoneTranscription();
	const placeholder = document.querySelector('#mediaPlaceholder');
	if (placeholder) placeholder.classList.toggle('hidden', cameraOn);
	const video = document.querySelector('#localVideo');
	if (video) video.classList.toggle('visible', cameraOn);
	const lobbyVideo = document.querySelector('#lobbyVideo');
	if (lobbyVideo) lobbyVideo.classList.toggle('visible', cameraOn);
	const lobbyPlaceholder = document.querySelector('#lobbyPreviewPlaceholder');
	if (lobbyPlaceholder) lobbyPlaceholder.hidden = cameraOn;
	updateMediaControls();
}
function setLobbyError(message) {
	const alert = document.querySelector('#preJoinModal');
	if (!alert) return;
	alert.innerHTML = `<p>${escapeHtml(message)}</p><button type="button" data-action="prejoin-retry">Try again</button>`;
	alert.hidden = false;
}
function attachLocalPreview() {
	for (const selector of ['#localVideo', '#lobbyVideo']) {
		const video = document.querySelector(selector);
		if (!video) continue;
		video.autoplay = true;
		video.playsInline = true;
		video.muted = true;
		video.srcObject = localStream;
		video.play().catch((error) => {
			if (!['NotAllowedError', 'AbortError'].includes(error.name)) console.warn('Unable to play local camera preview:', error);
		});
	}
}
async function disableCamera() {
	const stream = cameraStream;
	if (!stream) return;
	const tracks = stream.getVideoTracks();
	let connectionError;
	try {
		await mediaProvider?.unpublishTrack('video');
	} catch (error) {
		connectionError = new Error(`Unable to detach camera from the meeting connection: ${error.message}`);
	} finally {
		tracks.forEach((track) => {
			localStream.removeTrack(track);
			track.stop();
		});
		cameraStream = null;
		for (const selector of ['#localVideo', '#lobbyVideo']) {
			const video = document.querySelector(selector);
			if (!video) continue;
			video.pause();
			video.srcObject = null;
		}
		try {
			await mediaProvider?.setLocalStream(localStream);
		} catch (error) {
			connectionError ||= new Error(`Unable to update the meeting media connection: ${error.message}`);
		}
		updateMediaState();
	}
	if (connectionError) throw connectionError;
}
async function enableCamera() {
	const currentTrack = cameraStream?.getVideoTracks().find((track) => track.readyState === 'live');
	if (currentTrack) {
		currentTrack.enabled = true;
		attachLocalPreview();
		return true;
	}
	let acquiredStream;
	try {
		acquiredStream = await navigator.mediaDevices.getUserMedia({
			video: selectedCameraId ? { deviceId: { exact: selectedCameraId } } : true,
		});
		const track = acquiredStream.getVideoTracks()[0];
		if (!track) throw new Error('No camera track was returned. Check that a camera is connected and available.');
		cameraStream = acquiredStream;
		localStream.addTrack(track);
		track.addEventListener('ended', () => {
			if (cameraStream !== acquiredStream) return;
			localStream.removeTrack(track);
			cameraStream = null;
			for (const selector of ['#localVideo', '#lobbyVideo']) {
				const video = document.querySelector(selector);
				if (video) video.srcObject = null;
			}
			mediaProvider?.unpublishTrack('video').catch((error) => {
				showToast(`Unable to update the meeting camera state: ${error.message}`, 'error');
			});
			updateMediaState();
			showToast('Camera disconnected. Reconnect it or choose another camera.', 'error');
		}, { once: true });
		attachLocalPreview();
		await mediaProvider?.publishTrack(track, localStream, 'video');
		updateMediaState(false);
		return true;
	} catch (error) {
		if (cameraStream === acquiredStream) cameraStream = null;
		acquiredStream?.getTracks().forEach((track) => {
			localStream.removeTrack(track);
			track.stop();
		});
		for (const selector of ['#localVideo', '#lobbyVideo']) {
			const video = document.querySelector(selector);
			if (video) video.srcObject = null;
		}
		const message = error.name === 'Error' ? error.message : mediaError(error, 'Camera');
		setLobbyError(message);
		showToast(message, 'error');
		return false;
	}
}
async function enableMicrophone() {
	const currentTrack = microphoneStream?.getAudioTracks().find((track) => track.readyState === 'live');
	if (currentTrack) {
		currentTrack.enabled = true;
		return true;
	}
	microphoneStream?.getAudioTracks().forEach((track) => localStream.removeTrack(track));
	microphoneStream?.getTracks().forEach((track) => track.stop());
	try {
		microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: selectedMicrophoneId ? { deviceId: { exact: selectedMicrophoneId } } : true });
		const track = microphoneStream.getAudioTracks()[0];
		if (!track) throw new Error('No microphone track was returned. Check that a microphone is connected and available.');
		track.addEventListener('ended', () => {
			if (microphoneStream?.getAudioTracks().includes(track)) {
				localStream.removeTrack(track);
				microphoneStream = null;
				stopMicrophoneTranscription();
				updateMediaState();
				showToast('Microphone disconnected. Reconnect it to resume transcription.', 'error');
			}
		}, { once: true });
		localStream.addTrack(track);
		await mediaProvider?.publishTrack(track, localStream, 'audio');
		attachAudioMeter(microphoneStream, document.querySelector('.local-tile'), document.querySelector('#microphoneLevelFill'));
		updateMediaState(false);
		return true;
	} catch (error) {
		microphoneStream?.getAudioTracks().forEach((track) => localStream.removeTrack(track));
		microphoneStream?.getTracks().forEach((track) => track.stop());
		microphoneStream = null;
		const message = error.name === 'Error' ? error.message : mediaError(error, 'Microphone');
		setLobbyError(message);
		showToast(message, 'error');
		return false;
	}
}
async function completePreJoin() {
	const settings = meetingState.settings || {};
	let success = true;
	if (settings.camera_required && !localMediaState().video_enabled) success = await enableCamera() && success;
	if (settings.microphone_required && !localMediaState().audio_enabled) success = await enableMicrophone() && success;
	if (!success || (settings.camera_required && !localMediaState().video_enabled) || (settings.microphone_required && !localMediaState().audio_enabled)) {
		setLobbyError(requiredMediaText());
		return;
	}
	document.querySelector('#preJoinModal').hidden = true;
	enterMeeting();
}
function showPreJoinModal() {
	if (isMediaExempt()) return;
	const alert = document.querySelector('#preJoinModal');
	if (!alert) return;
	document.querySelector('#roomShell').classList.remove('is-joined');
	const required = requiredMediaText();
	const action = meetingState.settings?.camera_required && meetingState.settings?.microphone_required ? 'camera and microphone' : meetingState.settings?.camera_required ? 'camera' : 'microphone';
	alert.innerHTML = `<p>${escapeHtml(required)}</p><button type="button" data-action="prejoin-allow">Turn on ${action}</button><button type="button" data-action="prejoin-retry">Try again</button>`;
	alert.hidden = false;
	document.querySelector('#admissionStatus')?.classList.remove('hidden');
}
function enterMeeting() {
	if (settingsRequireMedia() && ((meetingState.settings?.camera_required && !localMediaState().video_enabled) || (meetingState.settings?.microphone_required && !localMediaState().audio_enabled))) {
		showPreJoinModal();
		return;
	}
	document.querySelector('#preJoinModal').hidden = true;
	document.querySelector('#admissionStatus')?.classList.add('hidden');
	document.querySelector('#roomShell').classList.add('is-joined');
	if (!realtime) connectRealtime();
	updateMediaState();
}
function showToast(message, type = 'info') {
	if (!message) return;
	const now = Date.now();
	if (showToast.last === message && now - (showToast.at || 0) < 4000) return;
	showToast.last = message;
	showToast.at = now;
	const stack = document.querySelector('#toast');
	if (!stack) return;
	const toast = document.createElement('div');
	toast.className = `toast-item toast-${type}`;
	toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
	const icon = { success: 'check', info: 'info', warning: 'topics', error: 'close' }[type] || 'info';
	toast.innerHTML = `<span class="toast-icon">${roomIcon(icon, 17)}</span><span>${escapeHtml(message)}</span><button type="button" aria-label="Dismiss notification">${roomIcon('close', 15)}</button>`;
	toast.querySelector('button').addEventListener('click', () => toast.remove());
	stack.appendChild(toast);
	while (stack.children.length > 3) stack.firstElementChild.remove();
	window.setTimeout(() => toast.remove(), 4000);
}
function showReaction(reaction, name = 'Participant') {
	const layer = document.querySelector('#reactionLayer') || document.body;
	const item = document.createElement('div');
	item.className = 'reaction-pop';
	item.innerHTML = `<span>${escapeHtml(reaction)}</span><b>${escapeHtml(name)}</b>`;
	layer.appendChild(item);
	window.setTimeout(() => item.remove(), 2600);
}
function attachAudioMeter(stream, tile, meterFill) {
	if (!stream?.getAudioTracks().length || !window.AudioContext) return;
	try {
		const context = new AudioContext();
		const source = context.createMediaStreamSource(stream);
		const analyser = context.createAnalyser();
		analyser.fftSize = 256;
		source.connect(analyser);
		const values = new Uint8Array(analyser.frequencyBinCount);
		let speaking = false;
		const sample = () => {
			analyser.getByteFrequencyData(values);
			const level = Math.min(1, values.reduce((sum, value) => sum + value, 0) / (values.length * 100));
			if (meterFill) meterFill.style.transform = `scaleX(${Math.max(.03, level)})`;
			const nextSpeaking = level > .12;
			if (tile && nextSpeaking !== speaking) {
				tile.classList.toggle('speaking', nextSpeaking);
				speaking = nextSpeaking;
			}
			if (tile?.isConnected || meterFill?.isConnected) tile.__audioFrame = requestAnimationFrame(sample);
		};
		context.resume().catch(() => { });
		tile && (tile.__audioContext = context);
		sample();
	} catch { }
}
function ensureRemoteTile(userId, participant = {}) {
	const tiles = document.querySelector('#remoteTiles');
	if (!tiles || !userId || userId === currentUserId) return null;
	let tile = tiles.querySelector(`[data-user-id="${CSS.escape(userId)}"]`);
	if (tile) return tile;
	const state = participantsState.get(userId) || participant;
	tile = document.createElement('article');
	tile.className = 'media-tile remote-tile';
	tile.classList.toggle('camera-off', state.video_enabled === false);
	tile.dataset.userId = userId;
	tile.dataset.stageTile = '';
	tile.innerHTML = `<div class="remote-avatar tile-avatar">${escapeHtml(initials(participant.name || 'Participant'))}</div><video autoplay playsinline></video><audio autoplay></audio><div class="media-label"><span class="tile-name">${escapeHtml(participant.name || 'Participant')}</span><span class="tile-mic-state">${roomIcon(state.audio_enabled ? 'mic' : 'micOff', 15)}</span></div>${userId === meetingHostId() ? '<span class="host-badge">Host</span>' : ''}<span class="connection-badge">${roomIcon('connection', 14)}<span>${escapeHtml(state.connectionState || 'Connecting')}</span></span><div class="tile-hover-actions"><button type="button" data-action="pin-tile" aria-label="Spotlight participant" data-tooltip="Spotlight">${roomIcon('pin')}</button><button type="button" disabled aria-label="More tile actions unavailable" data-tooltip="Available soon">${roomIcon('more')}</button></div><span class="media-state">${state.video_enabled === false ? 'Camera off' : 'Camera on'} · ${state.audio_enabled ? 'Mic on' : 'Mic off'}</span>`;
	tiles.appendChild(tile);
	updateStageLayout();
	return tile;
}
function renderRemoteStream(userId, stream) {
	const tiles = document.querySelector('#remoteTiles');
	if (!tiles) return;
	const participant = meetingState?.participants?.find((item) => item.user_id === userId) || participantsState.get(userId) || {};
	const tile = ensureRemoteTile(userId, participant);
	if (!tile) return;
	const video = tile.querySelector('video');
	const audio = tile.querySelector('audio');
	video.srcObject = stream;
	audio.srcObject = stream;
	tile.classList.toggle('camera-off', !stream.getVideoTracks().some((track) => track.enabled));
	video.play().catch(() => showToast('Click the page to enable participant video.'));
	audio.play().catch(() => showToast('Click the page to enable participant audio.'));
	tile.querySelector('.remote-avatar').classList.toggle('hidden', Boolean(stream.getVideoTracks().length));
	tile.querySelector('.connection-badge span').textContent = 'Connected';
	attachAudioMeter(stream, tile);
	updateStageLayout();
}
function removeRemoteTile(userId) {
	const tile = document.querySelector(`#remoteTiles [data-user-id="${CSS.escape(userId)}"]`);
	if (tile?.__audioFrame) cancelAnimationFrame(tile.__audioFrame);
	if (tile?.__audioContext) tile.__audioContext.close().catch(() => { });
	tile?.remove();
	updateStageLayout();
}
function updateConnectionStatus(status) {
	const node = document.querySelector('#connectionStatus');
	let banner = document.querySelector('#reconnectingBanner');
	if (!node) return;
	const normalized = status === 'connected' ? 'connected' : status === 'disconnected' || status === 'Unavailable' ? 'offline' : 'reconnecting';
	node.dataset.status = normalized;
	node.querySelector('span').textContent = normalized === 'connected' ? 'Connected' : normalized === 'offline' ? 'Offline' : 'Reconnecting...';
	if (!banner && normalized !== 'connected') {
		banner = document.createElement('div');
		banner.id = 'reconnectingBanner';
		banner.className = 'connection-banner';
		banner.setAttribute('role', 'status');
		document.querySelector('#roomShell')?.appendChild(banner);
	}
	if (banner) {
		banner.hidden = normalized === 'connected';
		banner.textContent = normalized === 'offline' ? 'Connection lost. Trying to reconnect...' : 'Reconnecting to the meeting...';
	}
}
async function refreshDeviceOptions() {
	if (!navigator.mediaDevices?.enumerateDevices) return;
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		for (const kind of ['microphone', 'camera']) {
			const deviceKind = kind === 'camera' ? 'videoinput' : 'audioinput';
			const available = devices.filter((device) => device.kind === deviceKind);
			const menuButton = document.querySelector(kind === 'camera' ? '[data-action="toggle-camera-devices"]' : '[data-action="toggle-mic-devices"]');
			if (menuButton) menuButton.hidden = available.length === 0;
			document.querySelectorAll(`[data-device-select="${kind}"]`).forEach((select) => {
				const selected = kind === 'camera' ? selectedCameraId : selectedMicrophoneId;
				select.innerHTML = available.map((device, index) => `<option value="${escapeHtml(device.deviceId)}" ${device.deviceId === selected ? 'selected' : ''}>${escapeHtml(device.label || `${kind === 'camera' ? 'Camera' : 'Microphone'} ${index + 1}`)}</option>`).join('');
				select.hidden = available.length === 0;
			});
		}
	} catch { }
}
async function switchMediaDevice(kind, deviceId) {
	if (!deviceId) return;
	if (kind === 'camera') {
		selectedCameraId = deviceId;
		if (!localMediaState().video_enabled) return;
		let nextStream;
		try {
			nextStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: deviceId } } });
			const nextTrack = nextStream.getVideoTracks()[0];
			if (!nextTrack) throw new Error('The selected camera did not provide a video track.');
			localStream.addTrack(nextTrack);
			await mediaProvider?.publishTrack(nextTrack, localStream, 'video');
			cameraStream?.getVideoTracks().forEach((track) => {
				localStream.removeTrack(track);
				track.stop();
			});
			cameraStream = nextStream;
			attachLocalPreview();
		} catch (error) {
			nextStream?.getTracks().forEach((track) => {
				localStream.removeTrack(track);
				track.stop();
			});
			showToast(`Unable to switch camera: ${error.message}`, 'error');
			return;
		}
	} else {
		selectedMicrophoneId = deviceId;
		if (!localMediaState().audio_enabled) return;
		let nextStream;
		try {
			nextStream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
			const nextTrack = nextStream.getAudioTracks()[0];
			if (!nextTrack) throw new Error('The selected microphone did not provide an audio track.');
			localStream.addTrack(nextTrack);
			await mediaProvider?.publishTrack(nextTrack, localStream, 'audio');
			stopMicrophoneTranscription();
			microphoneStream?.getAudioTracks().forEach((track) => {
				localStream.removeTrack(track);
				track.stop();
			});
			microphoneStream = nextStream;
			attachAudioMeter(microphoneStream, document.querySelector('.local-tile'), document.querySelector('#microphoneLevelFill'));
			if (document.querySelector('#connectionStatus')?.dataset.status === 'connected') startMicrophoneTranscription();
		} catch (error) {
			nextStream?.getTracks().forEach((track) => {
				localStream.removeTrack(track);
				track.stop();
			});
			showToast(`Unable to switch microphone: ${error.message}`, 'error');
			return;
		}
	}
	await mediaProvider?.setLocalStream(localStream);
	updateMediaState();
}
function toggleFullscreen() {
	const shell = document.querySelector('#roomShell');
	if (!shell) return;
	if (document.fullscreenElement) return document.exitFullscreen();
	return shell.requestFullscreen().catch(() => showToast('Fullscreen could not be started. Check browser fullscreen permissions.', 'error'));
}
function setFullscreenControlsVisible(visible) {
	const shell = document.querySelector('#roomShell');
	if (!shell || !document.fullscreenElement) return;
	shell.classList.toggle('controls-hidden', !visible);
	window.clearTimeout(fullscreenIdleTimer);
	if (visible) fullscreenIdleTimer = window.setTimeout(() => setFullscreenControlsVisible(false), 3000);
}
function confirmEndOrLeave() {
	modalReturnFocus = document.activeElement;
	const modal = document.createElement('div');
	modal.className = 'modal-backdrop';
	modal.id = 'leaveConfirmModal';
	modal.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="leaveConfirmTitle"><h2 id="leaveConfirmTitle">Leave this meeting?</h2><p>${isHost() ? 'You can leave while the meeting continues, or end it for everyone.' : 'You will leave this meeting.'}</p><div class="modal-actions"><button class="small-button" data-lifecycle="leave">Leave meeting</button>${isHost() ? '<button class="small-button danger-action" data-action="end-for-all">End meeting for everyone</button>' : ''}<button class="small-button" data-lifecycle="cancel">Stay</button></div></section>`;
	(document.querySelector('#roomShell') || document.body).appendChild(modal);
	modal.querySelector('button')?.focus();
}
function confirmEndForAll() {
	if (!modalReturnFocus) modalReturnFocus = document.activeElement;
	closeRoomPopovers();
	document.querySelector('#leaveConfirmModal')?.remove();
	const modal = document.createElement('div');
	modal.className = 'modal-backdrop';
	modal.id = 'endMeetingModal';
	modal.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="endMeetingTitle"><h2 id="endMeetingTitle">End the meeting for everyone?</h2><p>All participants will be disconnected from this meeting.</p><div class="modal-actions"><button class="small-button danger-action" data-lifecycle="end">End meeting for all</button><button class="small-button" data-lifecycle="cancel">Cancel</button></div></section>`;
	(document.querySelector('#roomShell') || document.body).appendChild(modal);
	modal.querySelector('button')?.focus();
}
function openShortcuts() {
	let modal = document.querySelector('#shortcutsModal');
	if (!modal) {
		modal = document.createElement('div');
		modal.id = 'shortcutsModal';
		modal.className = 'modal-backdrop';
		modal.innerHTML = `<section class="modal-card shortcuts-card" role="dialog" aria-modal="true" aria-labelledby="shortcutsTitle"><div class="modal-heading-row"><h2 id="shortcutsTitle">Keyboard shortcuts</h2><button class="icon-button" type="button" data-action="close-shortcuts" aria-label="Close shortcuts">${roomIcon('close')}</button></div><dl><div><dt>Mute or unmute</dt><dd><kbd>M</kbd></dd></div><div><dt>Camera</dt><dd><kbd>V</kbd></dd></div><div><dt>Participants</dt><dd><kbd>P</kbd></dd></div><div><dt>Chat or questions</dt><dd><kbd>C</kbd></dd></div><div><dt>Fullscreen</dt><dd><kbd>F</kbd></dd></div><div><dt>Close panel or menu</dt><dd><kbd>Esc</kbd></dd></div></dl></section>`;
		(document.querySelector('#roomShell') || document.body).appendChild(modal);
	}
	modalReturnFocus = document.activeElement;
	modal.hidden = false;
	modal.querySelector('button')?.focus();
}
function handleAction(action, actionTarget) {
	if (action === 'microphone' || action === 'mute') return toggleMicrophone();
	if (action === 'camera') return toggleCamera();
	if (action === 'meeting-settings') return openMeetingSettings();
	if (action === 'prejoin-allow' || action === 'prejoin-retry') return completePreJoin();
	if (action === 'prejoin-leave') return leaveMeeting();
	if (action === 'settings-close') return closeRoomModal('settingsModal');
	if (action === 'fullscreen') return toggleFullscreen();
	if (action === 'start-timer') return startQuestionTimer((Number(document.querySelector('#timerMinutes')?.value) || 2) * 60);
	if (action === 'start') return updateMeetingLifecycle('start');
	if (action === 'end') return confirmEndOrLeave();
	if (action === 'end-for-all') return confirmEndForAll();
	if (action === 'delete-note') return deleteNote();
	if (action === 'download-notes') return downloadNotes();
	if (action === 'export-pdf') return exportPdf();
	if (action === 'join-now') return enterMeeting();
	if (action === 'theme-toggle') {
		const theme = document.querySelector('#roomShell').dataset.theme === 'light' ? 'dark' : 'light';
		try {
			localStorage.setItem('meetmind-theme', theme);
			localStorage.setItem('meetmind-room-theme', theme);
		} catch { }
		return applyRoomTheme(theme);
	}
	if (action === 'dashboard') return window.location.assign('../dashboard/index.html');
	if (action === 'close-panel') return setActivePanel(null);
	if (action === 'toggle-more') {
		const menu = document.querySelector('#moreMenu');
		if (!menu) return;
		const isOpen = !menu.hidden;
		closeRoomPopovers();
		if (!isOpen) {
			menu.hidden = false;
			eventButtonExpanded(action, true);
		}
		return;
	}
	if (action === 'toggle-reactions') {
		const picker = document.querySelector('#reactionPicker');
		if (!picker) return;
		const isOpen = !picker.hidden;
		closeRoomPopovers();
		if (!isOpen) {
			picker.hidden = false;
			eventButtonExpanded(action, true);
		}
		return;
	}
	if (action === 'toggle-mic-devices' || action === 'toggle-camera-devices') {
		const id = action === 'toggle-camera-devices' ? 'cameraDeviceMenu' : 'micDeviceMenu';
		const menu = document.getElementById(id);
		if (!menu) return refreshDeviceOptions();
		const isOpen = !menu.hidden;
		closeRoomPopovers();
		if (!isOpen) {
			menu.hidden = false;
		}
		return refreshDeviceOptions();
	}
	if (action === 'toggle-leave') {
		const menu = document.querySelector('#leaveMenu');
		if (!menu) return;
		const isOpen = !menu.hidden;
		closeRoomPopovers();
		if (!isOpen) {
			menu.hidden = false;
			eventButtonExpanded(action, true);
		}
		return;
	}
	if (action === 'shortcuts') return openShortcuts();
	if (action === 'close-shortcuts') return closeRoomModal('shortcutsModal');
	if (action === 'copy-meeting-link') return navigator.clipboard?.writeText(window.location.href).then(() => showToast('Meeting link copied.', 'success')).catch(() => showToast('Unable to copy the meeting link.', 'error'));
	if (action === 'pin-tile') {
		const tile = actionTarget?.closest?.('.media-tile');
		if (tile) {
			document.querySelectorAll('.media-tile').forEach((item) => item.classList.toggle('pinned', item === tile && !item.classList.contains('pinned')));
			const grid = document.querySelector('#mediaGrid');
			grid?.classList.toggle('spotlight', Boolean(grid.querySelector('.pinned')));
		}
	}
}
function eventButtonExpanded(action, expanded) {
	const selector = action === 'toggle-more' ? '[data-action="toggle-more"]' : action === 'toggle-reactions' ? '[data-action="toggle-reactions"]' : action === 'toggle-leave' ? '[data-action="toggle-leave"]' : '';
	if (selector) document.querySelector(selector)?.setAttribute('aria-expanded', String(expanded));
}
function closeRoomModal(id) {
	document.getElementById(id)?.remove();
	modalReturnFocus?.focus?.({ preventScroll: true });
	modalReturnFocus = null;
}
function openMeetingSettings() {
	if (!isHost()) return;
	modalReturnFocus = document.activeElement;
	const settings = meetingState.settings || {};
	const modal = document.createElement('div');
	modal.id = 'settingsModal';
	modal.className = 'modal-backdrop';
	modal.innerHTML = `<section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="settingsTitle"><div class="modal-heading-row"><h2 id="settingsTitle">Meeting settings</h2><button class="icon-button" type="button" data-action="settings-close" aria-label="Close settings">${roomIcon('close')}</button></div><form id="settingsForm"><label><input type="checkbox" name="camera_required" ${settings.camera_required ? 'checked' : ''}/> Camera required</label><label><input type="checkbox" name="microphone_required" ${settings.microphone_required ? 'checked' : ''}/> Microphone required</label><label><input type="checkbox" name="allow_camera_toggle" ${settings.allow_camera_toggle ? 'checked' : ''}/> Participants can turn camera off</label><label><input type="checkbox" name="allow_microphone_toggle" ${settings.allow_microphone_toggle ? 'checked' : ''}/> Participants can mute themselves</label><div class="modal-actions"><button class="small-button" type="submit">Save settings</button><button class="small-button" type="button" data-action="settings-close">Cancel</button></div></form></section>`;
	document.querySelector('#roomShell').appendChild(modal);
	modal.querySelector('input')?.focus();
}
async function updateMeetingLifecycle(action) {
	const endpoint = action === 'start' ? 'start' : 'end';
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/${endpoint}`, { method: 'POST', headers: authHeaders });
	if (!response.ok) {
		const detail = await response.json().catch(() => ({}));
		showToast(detail.detail || `Unable to ${endpoint} meeting.`, 'error');
		return;
	}
	if (action !== 'start') { window.location.reload(); return; }
	const refreshed = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}`, { headers: authHeaders });
	if (refreshed.ok) meetingState = await refreshed.json();
	document.querySelector('#workspaceHeader').innerHTML = MeetingHeader(meetingState);
	document.querySelector('#controls').innerHTML = MeetingControls(meetingState);
	startMeetingClock(meetingState.started_at || new Date().toISOString());
	enterMeeting();
}
function renderEndedMeeting(message = 'This meeting has ended.') {
	stopLocalMedia();
	realtime?.close();
	document.querySelector('#workspaceHeader').innerHTML = `<a class="workspace-brand" href="../dashboard/index.html" aria-label="MeetMind dashboard">${roomIcon('logo', 26)}</a>`;
	document.querySelector('#workspaceGrid').innerHTML = `<section class="ended-card"><span class="ended-mark">${roomIcon('check', 24)}</span><p class="panel-kicker">MEETING COMPLETE</p><h1>Thanks for meeting with MeetMind</h1><p>${escapeHtml(message)}</p><a class="primary-button" href="../dashboard/index.html">Back to dashboard</a></section>`;
	document.querySelector('#controls').innerHTML = '';
}
async function manageParticipant(action, userId, role) {
	const url = `${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(userId)}`;
	const response = await fetch(url, { method: action === 'remove' ? 'DELETE' : 'PATCH', headers: { ...authHeaders, 'Content-Type': 'application/json' }, ...(action === 'role' ? { body: JSON.stringify({ role }) } : {}) });
	const data = await response.json().catch(() => ({}));
	if (!response.ok) { showToast(data.detail || 'Unable to update participant.', 'error'); return; }
	meetingState = data;
	if (action === 'remove') {
		participantsState.delete(userId);
		mediaProvider?.removePeer?.(userId);
		removeRemoteTile(userId);
	} else {
		const current = participantsState.get(userId) || {};
		const updated = meetingState.participants.find((participant) => participant.user_id === userId);
		if (updated) participantsState.set(userId, { ...current, ...updated });
	}
	const oldPanel = document.querySelector('.participant-panel');
	if (oldPanel) {
		const wasOpen = oldPanel.classList.contains('panel-open');
		const replacement = new DOMParser().parseFromString(ParticipantList(meetingState), 'text/html').body.firstElementChild;
		replacement.classList.toggle('panel-open', wasOpen);
		oldPanel.replaceWith(replacement);
	}
	updateParticipantCount();
	showToast(action === 'remove' ? 'Participant removed.' : 'Participant role updated.', 'success');
}

document.addEventListener('click', (event) => {
	const liveButton = event.target.closest('[data-live-action="toggle"]');
	if (liveButton) {
		toggleLiveCaptionCapture(liveButton);
		return;
	}
	const reactionTarget = event.target.closest('[data-reaction]');
	if (reactionTarget) {
		const reaction = reactionTarget.dataset.reaction;
		closeRoomPopovers();
		realtime?.send('REACTION', { reaction });
		showReaction(reaction, 'You');
		return;
	}
	const panelButton = event.target.closest('[data-panel-open]');
	if (panelButton) {
		const panel = document.querySelector(`.support-panel[data-panel="${panelButton.dataset.panelOpen}"]`);
		setActivePanel(panel?.classList.contains('panel-open') ? null : panelButton.dataset.panelOpen);
		return;
	}
	if (event.target.closest('#panelBackdrop')) { setActivePanel(null); return; }
	if (!event.target.closest('.more-menu, .reaction-picker, .leave-menu, .device-popover, .panel-control, .control-button, .support-panel, .modal-backdrop, .toast-item')) {
		closeRoomPopovers();
	}
	const dismiss = event.target.closest('.toast-item button');
	if (dismiss) dismiss.closest('.toast-item')?.remove();
});
window.addEventListener('pagehide', () => {
	stopMicrophoneTranscription();
	stopLiveCaptionCapture('Stopped');
});
document.addEventListener('change', (event) => {
	const select = event.target.closest('[data-device-select]');
	if (select) switchMediaDevice(select.dataset.deviceSelect, select.value);
});
document.addEventListener('input', (event) => {
	if (event.target.id !== 'participantSearch') return;
	const query = event.target.value.trim().toLowerCase();
	document.querySelectorAll('.participant-row').forEach((row) => { row.hidden = !row.textContent.toLowerCase().includes(query); });
});
document.addEventListener('keydown', (event) => {
	const typing = event.target.matches('input, textarea, select, [contenteditable="true"]');
	if (event.key === 'Escape') {
		closeRoomPopovers();
		setActivePanel(null);
		document.querySelectorAll('.modal-backdrop').forEach((modal) => modal.remove());
		modalReturnFocus?.focus?.({ preventScroll: true });
		modalReturnFocus = null;
		return;
	}
	if (typing) return;
	if (event.key === '?') { event.preventDefault(); openShortcuts(); return; }
	if (event.key.toLowerCase() === 'm') toggleMicrophone();
	if (event.key.toLowerCase() === 'v') toggleCamera();
	if (event.key.toLowerCase() === 'p') setActivePanel('participants');
	if (event.key.toLowerCase() === 'c') setActivePanel(chatMessages ? 'chat' : 'questions');
	if (event.key.toLowerCase() === 'f') toggleFullscreen();
});
document.addEventListener('fullscreenchange', () => {
	const fullscreen = Boolean(document.fullscreenElement);
	const shell = document.querySelector('#roomShell');
	if (!fullscreen) {
		window.clearTimeout(fullscreenIdleTimer);
		shell?.classList.remove('controls-hidden');
	} else setFullscreenControlsVisible(true);
	const button = document.querySelector('[data-action="fullscreen"]');
	if (button) {
		button.setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
		button.dataset.tooltip = fullscreen ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
	}
});
['pointermove', 'touchstart', 'focusin'].forEach((name) => document.addEventListener(name, () => {
	if (!document.fullscreenElement) return;
	const now = Date.now();
	if (now - fullscreenLastActivity < 120) return;
	fullscreenLastActivity = now;
	setFullscreenControlsVisible(true);
}, { passive: true }));
if (navigator.mediaDevices?.addEventListener) navigator.mediaDevices.addEventListener('devicechange', refreshDeviceOptions);
boot();
