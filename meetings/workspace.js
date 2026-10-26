const API_URL = window.MEETMIND_API_URL || (window.location.protocol.startsWith('http') ? window.location.origin : 'http://localhost:8000');
const TOKEN_KEY = 'meetmind_access_token';
const token = sessionStorage.getItem(TOKEN_KEY);
if (!token) window.location.replace('../login/index.html');
const meetingId = new URLSearchParams(window.location.search).get('id');
const currentUserId = (() => {
	try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch { return null; }
})();
const authHeaders = { Authorization: `Bearer ${token}` };
let realtime;
let microphoneRecorder;
let microphoneStream;
let cameraStream;
let localStream = new MediaStream();
let mediaProvider;
const participantsState = new Map();
let iceServers = [];
let meetingState;
let questions = [];
let tasks = [];
let topics = [];
let questionTimer;
let questionTimerEndsAt;

function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function initials(name = '') { return name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'MM'; }
function formatDate(value) { return value ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not scheduled'; }
function showToast(message) { if (!message || (showToast.last === message && Date.now() - showToast.at < 5000)) return; showToast.last = message; showToast.at = Date.now(); const toast = document.querySelector('#toast'); toast.textContent = message; toast.classList.remove('hidden'); window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 2600); }
function showReaction(reaction, name = 'Participant') { const item = document.createElement('div'); item.className = 'reaction-pop'; item.textContent = `${reaction} ${name}`; document.body.appendChild(item); window.setTimeout(() => item.remove(), 2400); }
function EmptyPanel({ icon, title, message, className = '' }) { return `<div class="empty-panel ${className}"><span class="empty-panel-icon">${icon}</span><h3>${title}</h3><p>${message}</p></div>`; }
function isHost() { return meetingState?.created_by === currentUserId; }
function currentParticipant() { return meetingState?.participants?.find((participant) => participant.user_id === currentUserId); }
function isMediaExempt() { return isHost() || currentParticipant()?.role === 'viewer'; }
function settingsRequireMedia() { return !isMediaExempt() && Boolean(meetingState?.settings?.camera_required || meetingState?.settings?.microphone_required); }
function localMediaState() { return { audio_enabled: localStream.getAudioTracks().some((track) => track.enabled), video_enabled: localStream.getVideoTracks().some((track) => track.enabled) }; }
function MeetingHeader(meeting) { const people = meeting.participants.slice(0, 4).map((participant) => `<span class="participant-avatar">${initials(participant.name)}</span>`).join(''); const isHost = meeting.created_by === currentUserId; return `<a class="workspace-brand" href="../dashboard/index.html"><span>✦</span><span>meetmind <small>AI</small></span></a><div class="meeting-header"><a class="back-link" href="../dashboard/index.html" aria-label="Back to dashboard">←</a><div class="meeting-header-copy"><h1>${escapeHtml(meeting.title)}</h1><p>${escapeHtml(meeting.meeting_type)} · ${meeting.privacy_mode} · ${formatDate(meeting.start_time)}</p></div><span class="meeting-status">${escapeHtml(meeting.status)}</span><span class="connection-status" id="connectionStatus">Connecting</span></div><div class="header-right"><span class="language-badge">◎ ${meeting.language.toUpperCase()}</span><div class="participant-stack">${people}</div><button class="header-end" data-action="end">${isHost ? 'End meeting' : 'Leave'}</button></div>`; }
function TranscriptPanel() { return `<section class="panel transcript-panel"><div class="panel-heading"><div><p class="panel-kicker">YOUR MEDIA</p><h2>Meeting video</h2><p>WebRTC media is ready for participant signaling.</p></div><span class="panel-icon coral">◉</span></div><div class="media-grid" id="mediaGrid"><article class="media-tile local-tile"><video id="localVideo" autoplay muted playsinline></video><div class="media-placeholder" id="mediaPlaceholder"><span class="empty-panel-icon">◌</span><b>Camera is off</b><small>Your local preview will appear here.</small></div><span class="media-label">You</span><span class="media-state" id="mediaState">Camera off · Mic off</span></article><div id="remoteTiles"></div><p class="admission-status hidden" id="admissionStatus">Waiting for required camera/microphone</p></div><div class="panel-heading transcript-heading"><div><p class="panel-kicker">LIVE CAPTIONS</p><h2>Live transcript</h2><p>Speech will appear here in real time.</p></div><span class="panel-icon coral">◉</span></div><div class="panel-content" id="transcriptContent">${EmptyPanel({ icon: '◌', title: 'Start the microphone to begin transcription.', message: 'No audio is being captured. Your transcript will stay empty until you enable the microphone.' })}</div></section>`; }
function NotesPanel() { return `<section class="panel notes-panel"><div class="panel-heading"><div><p class="panel-kicker">YOUR NOTES</p><h2>Digital notes</h2><p>Markdown or plain text, saved to this meeting.</p></div><span class="panel-icon">▤</span></div><div class="notes-list" id="notesList"></div><div class="notes-editor"><input class="notes-title" id="notesTitle" placeholder="Untitled note" aria-label="Note title"/><textarea class="notes-textarea" id="notesBody" placeholder="Start writing your thoughts..." aria-label="Meeting notes"></textarea><div class="notes-footer"><span id="saveState">New note</span><div class="notes-actions"><button class="small-button" data-action="delete-note">Delete</button><button class="small-button" data-action="download-notes">Text</button><button class="small-button" data-action="export-pdf">PDF</button></div></div></div></section>`; }
function TranslationPanel() { return `<section class="panel"><div class="panel-heading"><div><p class="panel-kicker">LANGUAGE SUPPORT</p><h2>Translation</h2><p>Translated captions will follow the transcript.</p></div><span class="panel-icon">文</span></div><div class="panel-content" id="translationContent">${EmptyPanel({ icon: '文', title: 'Translation is waiting for speech.', message: 'Choose a display language below. Live translation will activate with transcription.' })}</div></section>`; }
function QAPanel(meeting) { const isHost = meeting.created_by === currentUserId; return `<section class="panel qa-panel"><div class="panel-heading"><div><p class="panel-kicker">MEETING CONTEXT</p><h2>Questions</h2><p>Ask, answer, and keep timed prompts visible.</p></div><span class="panel-icon lavender">✧</span></div><div class="question-timer"><strong id="questionTimer">No active timer</strong>${isHost ? '<input id="timerMinutes" type="number" min="1" max="60" value="2" aria-label="Timer minutes"/><button class="small-button" data-action="start-timer">Start timer</button>' : ''}</div><div class="question-list" id="questionList">${EmptyPanel({ icon: 'Q', title: 'No questions yet.', message: 'Ask the first question about this meeting.' })}</div><form class="qa-input-wrap" id="qaForm"><input class="qa-input" name="question" placeholder="Ask about this meeting" aria-label="Ask a question" maxlength="2000" required/><button class="qa-send" type="submit" aria-label="Send question">→</button></form></section>`; }
function TaskPanel() { return `<section class="panel task-panel"><div class="panel-heading"><div><p class="panel-kicker">FOLLOW-UPS</p><h2>Tasks</h2><p>Track action items from the meeting.</p></div><span class="panel-icon">✓</span></div><div class="panel-content" id="taskList">${EmptyPanel({ icon: '✓', title: 'No tasks yet.', message: 'Add an action item for this meeting.' })}</div><form class="task-form" id="taskForm"><input name="title" placeholder="Add a task" aria-label="Task title" maxlength="255" required/><button type="submit">Add</button></form></section>`; }
function TopicsPanel() { return `<section class="panel"><div class="panel-heading"><div><p class="panel-kicker">SIGNALS</p><h2>Important topics</h2><p>Topics detected in the latest summary.</p></div><span class="panel-icon coral">◆</span></div><div class="topics" id="topicsList">${topics.length ? topics.map((topic) => `<span class="topic-chip">${escapeHtml(topic)}</span>`).join('') : 'Waiting for a summary'}</div></section>`; }
function ParticipantList(meeting) { const isHost = meeting.created_by === currentUserId; return `<section class="panel participant-panel"><div class="panel-heading"><div><p class="panel-kicker">IN THE ROOM</p><h2>Participants</h2></div><span class="panel-icon">◎</span></div><div class="mini-list">${meeting.participants.map((participant) => { const isMeetingHost = participant.user_id === meeting.created_by; const controls = isHost && !isMeetingHost ? `<span class="participant-actions"><select data-participant-action="role" data-user-id="${participant.user_id}" aria-label="Role for ${escapeHtml(participant.name || 'participant')}"><option value="participant" ${participant.role === 'participant' ? 'selected' : ''}>Participant</option><option value="viewer" ${participant.role === 'viewer' ? 'selected' : ''}>Viewer</option></select><button type="button" data-participant-action="remove" data-user-id="${participant.user_id}" aria-label="Remove ${escapeHtml(participant.name || 'participant')}">Remove</button></span>` : ''; return `<div class="participant-row"><span class="participant-avatar">${initials(participant.name)}</span><span class="participant-copy"><b>${escapeHtml(participant.name || 'MeetMind user')}</b><small>${participant.role}${isMeetingHost ? ' · host' : ''}</small></span>${controls}</div>`; }).join('')}</div></section>`; }
function MeetingControls(meeting) { const host = meeting.created_by === currentUserId; return `<div class="control-bar">${host ? '<button class="control-button" data-action="meeting-settings">Meeting settings</button>' : ''}<button class="control-button icon-only" id="micButton" data-action="microphone" aria-label="Enable microphone">♩</button><button class="control-button icon-only" id="cameraButton" data-action="camera" aria-label="Enable camera">▣</button><button class="control-button" id="recordButton" data-action="record" title="Not available yet" disabled>Start recording</button><button class="control-button" id="muteButton" data-action="mute">Mute</button><select class="control-language" id="displayLanguage" aria-label="Caption language"><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="hi">Hindi</option></select><div class="reaction-picker" aria-label="Send reaction">${['👍','👏','❤️','🎉','😂','❓'].map((reaction) => `<button type="button" data-reaction="${reaction}" aria-label="Send ${reaction}">${reaction}</button>`).join('')}</div><span class="control-separator"></span><button class="control-button" data-action="fullscreen">⛶ Fullscreen</button><button class="control-button" data-action="bookmark" title="Not available yet" disabled>☆ Bookmark moment</button>${host && meeting.status === 'scheduled' ? '<button class="control-button" data-action="start">Start meeting</button>' : ''}<button class="control-button end-button" data-action="end">${host ? 'End meeting' : 'Leave'}</button></div>`; }
function renderWorkspace(meeting) { meeting.participants.forEach((participant) => participantsState.set(participant.user_id, { ...participant, connectionState: participant.user_id === currentUserId ? 'connected' : 'connecting' })); document.querySelector('#workspaceHeader').innerHTML = MeetingHeader(meeting); document.querySelector('#workspaceGrid').innerHTML = `${TranscriptPanel()}${NotesPanel()}<div class="right-column">${QAPanel(meeting)}${TaskPanel()}${TopicsPanel()}${ParticipantList(meeting)}</div>`; document.querySelector('#controls').innerHTML = MeetingControls(meeting); setupWebRTC(); updateMediaControls(); loadNotes(); loadQuestions(); loadTasks(); loadTopics(); if (settingsRequireMedia()) showPreJoinModal(); else connectRealtime(); }
async function loadIceServers() {
	const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/ice-servers`, { headers: authHeaders });
	if (!response.ok) throw new Error('Unable to load media connection settings.');
	const data = await response.json();
	iceServers = data.ice_servers || [];
	if (!data.turn_configured) showToast('TURN is not configured; some networks may not connect.');
}
function renderRemoteStream(userId, stream) {
	const tiles = document.querySelector('#remoteTiles');
	if (!tiles) return;
	let tile = tiles.querySelector(`[data-user-id="${CSS.escape(userId)}"]`);
	if (!tile) {
		tile = document.createElement('article');
		tile.className = 'media-tile remote-tile';
		tile.dataset.userId = userId;
		const participant = meetingState?.participants?.find((item) => item.user_id === userId);
		tile.innerHTML = `<div class="remote-avatar">${escapeHtml(initials(participant?.name || 'Participant'))}</div><video autoplay playsinline></video><audio autoplay></audio><span class="media-label">${escapeHtml(participant?.name || 'Participant')}</span><span class="media-state"></span>`;
		tiles.appendChild(tile);
	}
	const video = tile.querySelector('video');
	const audio = tile.querySelector('audio');
	video.srcObject = stream;
	audio.srcObject = stream;
	video.play().catch(() => showToast('Click the page to enable participant audio.'));
	audio.play().catch(() => showToast('Click the page to enable participant audio.'));
	tile.querySelector('.remote-avatar').classList.toggle('hidden', Boolean(stream.getVideoTracks().length));
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
function updateConnectionStatus(status) { const node = document.querySelector('#connectionStatus'); if (!node) return; node.textContent = status; node.dataset.status = status; }
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
function handleRealtimeMessage(message) {
	if (message.type === 'TRANSCRIPT') appendStreamMessage('transcriptContent', message.payload, message.sender?.name || 'Speaker');
	if (message.type === 'TRANSLATION') appendStreamMessage('translationContent', message.payload, 'Translation');
	if (message.type === 'PARTICIPANT_ROSTER') {
		message.payload?.participants?.forEach(async (participant) => {
			participantsState.set(participant.user_id, { ...participant, connectionState: 'connecting' });
			await negotiateWith(participant.user_id);
		});
	}
	if (message.type === 'PARTICIPANT_JOINED') {
		const participant = message.payload || {};
		participantsState.set(participant.user_id, { ...participant, connectionState: 'connecting' });
		showToast(`${message.payload?.name || 'A participant'} joined the meeting.`);
	}
	if (message.type === 'PARTICIPANT_LEFT') {
		const userId = message.payload?.user_id;
		mediaProvider?.removePeer?.(userId);
		participantsState.delete(userId);
		removeRemoteTile(userId);
		showToast(`${message.payload?.name || 'A participant'} left the meeting.`);
	}
	if (['OFFER', 'ANSWER', 'ICE_CANDIDATE'].includes(message.type)) handleSignalingMessage(message);
	if (message.type === 'ERROR') showToast(message.payload?.message || 'Realtime message error.');
	if (message.type === 'MEETING_SETTINGS_UPDATED') {
		meetingState.settings = message.payload || meetingState.settings;
		updateMediaControls();
	}
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
		const audio = message.payload?.audio_enabled ? 'mic on' : 'muted';
		const video = message.payload?.video_enabled ? 'camera on' : 'camera off';
		showToast(`${message.sender.name}: ${audio}, ${video}.`);
	}
	if (message.type === 'MEETING_ENDED') {
		stopLocalMedia();
		realtime?.close();
		showToast(message.payload?.reason || 'The meeting has ended.');
		window.setTimeout(() => window.location.replace('../dashboard/index.html'), 700);
	}
	if (message.type === 'REACTION') showReaction(message.payload?.reaction || '', message.sender?.name || 'Participant');
	if (message.type === 'NOTIFICATION') showToast(message.payload?.message || 'Meeting notification');
	if (message.type === 'MEETING_EVENT' && message.payload?.name === 'question-timer-started') startQuestionTimer(Number(message.payload.duration_seconds) || 60, false);
	if (message.type === 'MEETING_EVENT' || message.type === 'TASK_CREATED' || message.type === 'BOOKMARK') showToast(`${message.type.replace('_', ' ').toLowerCase()} received.`);
}
function connectRealtime() {
	if (!window.MeetingWebSocketService) { updateConnectionStatus('Unavailable'); return; }
	realtime = new window.MeetingWebSocketService({
		meetingId,
		token,
		onStatus: (status) => {
			updateConnectionStatus(status);
			if (status === 'connected') {
				document.querySelector('#reconnectingBanner')?.remove();
				updateMediaState();
				if (microphoneStream && !microphoneRecorder) startMicrophoneRecorder();
			} else if (status === 'disconnected') {
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
	if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return `${device} permission denied. Change the browser permission for this site and try again.`;
	if (error.name === 'NotFoundError') return `No ${device.toLowerCase()} detected. Connect one and try again.`;
	if (error.name === 'NotReadableError') return `${device} is already in use by another application.`;
	return `Unable to access the ${device.toLowerCase()}.`;
}
async function enableCamera() {
	if (cameraStream) {
		cameraStream.getVideoTracks().forEach((track) => { track.enabled = true; });
		return true;
	}
	try {
		cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
		cameraStream.getTracks().forEach((track) => localStream.addTrack(track));
		document.querySelector('#localVideo').srcObject = localStream;
		await mediaProvider?.setLocalStream(localStream);
		updateMediaState(false);
		return true;
	} catch (error) {
		showToast(mediaError(error, 'Camera'));
		return false;
	}
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
	if (cameraStream) {
		if (button?.dataset.locked === 'true' && cameraStream.getVideoTracks().some((track) => track.enabled)) {
			showToast('The host does not allow you to turn off your camera.');
			return;
		}
		cameraStream.getVideoTracks().forEach((track) => { track.enabled = !track.enabled; });
		button.classList.toggle('active', cameraStream.getVideoTracks().some((track) => track.enabled));
		updateMediaState();
		showToast(cameraStream.getVideoTracks().some((track) => track.enabled) ? 'Camera enabled.' : 'Camera disabled.');
		return;
	}
	if (!navigator.mediaDevices?.getUserMedia) {
		showToast('This browser does not support camera capture.');
		return;
	}
	try {
		if (!await enableCamera()) return;
		button.classList.add('active');
		updateMediaState();
		showToast('Camera enabled.');
	} catch (error) { showToast(mediaError(error, 'Camera')); }
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
	if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
		showToast('This browser does not support microphone capture.');
		return;
	}
	try {
		if (!await enableMicrophone()) return;
		if (!mediaProvider) setupWebRTC();
		startMicrophoneRecorder();
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
		document.querySelector('#settingsModal')?.remove();
		showToast('Meeting settings saved.');
	} catch (error) { showToast(error.message); }
}
function startMicrophoneRecorder() {
	if (!microphoneStream || microphoneRecorder || !realtime || document.querySelector('#connectionStatus')?.dataset.status !== 'connected') return;
	const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
	microphoneRecorder = new MediaRecorder(microphoneStream, mimeType ? { mimeType } : undefined);
	microphoneRecorder.addEventListener('dataavailable', (event) => {
		if (event.data.size && !realtime.sendAudioChunk(event.data)) showToast('Audio is waiting for the realtime connection.');
	});
	microphoneRecorder.addEventListener('error', () => showToast('Audio capture failed. Please try the microphone again.'));
	microphoneRecorder.addEventListener('stop', () => { microphoneRecorder = null; });
	microphoneRecorder.start(1000);
}
let notes = [];
let activeNoteId = null;
let noteSaveTimer;
function updateSaveState(text) { document.querySelector('#saveState').textContent = text; }
function renderQuestions() { const list = document.querySelector('#questionList'); if (!list) return; list.innerHTML = questions.length ? questions.map((item) => `<article class="question-item"><small>${escapeHtml(item.asked_by_id === currentUserId ? 'You asked' : 'Participant question')}</small><p>${escapeHtml(item.question)}</p>${item.answer ? `<div class="question-answer"><b>Answer</b><p>${escapeHtml(item.answer)}</p></div>` : `<form class="answer-form" data-question-id="${item.id}"><input name="answer" placeholder="Add an answer" aria-label="Answer question" required/><button type="submit">Answer</button></form>`}</article>`).join('') : EmptyPanel({ icon: 'Q', title: 'No questions yet.', message: 'Ask the first question about this meeting.' }); }
async function loadQuestions() { try { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions`, { headers: authHeaders }); if (!response.ok) throw new Error('Unable to load questions.'); questions = await response.json(); renderQuestions(); } catch (error) { showToast(error.message); } }
function renderTasks() { const list = document.querySelector('#taskList'); if (!list) return; list.innerHTML = tasks.length ? tasks.map((task) => `<article class="task-item"><div><b>${escapeHtml(task.title)}</b><small>${task.priority} · ${task.status}</small></div><select data-task-id="${task.id}" aria-label="Task status"><option value="open" ${task.status === 'open' ? 'selected' : ''}>Open</option><option value="in_progress" ${task.status === 'in_progress' ? 'selected' : ''}>In progress</option><option value="completed" ${task.status === 'completed' ? 'selected' : ''}>Completed</option><option value="cancelled" ${task.status === 'cancelled' ? 'selected' : ''}>Cancelled</option></select></article>`).join('') : EmptyPanel({ icon: '✓', title: 'No tasks yet.', message: 'Add an action item for this meeting.' }); }
async function loadTasks() { try { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/tasks`, { headers: authHeaders }); if (!response.ok) throw new Error('Unable to load tasks.'); tasks = await response.json(); renderTasks(); } catch (error) { showToast(error.message); } }
async function createTask(title) { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/tasks`, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) }); const data = await response.json().catch(() => ({})); if (!response.ok) { showToast(data.detail || 'Unable to create task.'); return; } tasks.push(data); renderTasks(); }
async function updateTaskStatus(taskId, status) { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'PATCH', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) }); const data = await response.json().catch(() => ({})); if (!response.ok) { showToast(data.detail || 'Unable to update task.'); return; } tasks = tasks.map((task) => task.id === data.id ? data : task); renderTasks(); }
async function loadTopics() { try { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/summary`, { headers: authHeaders }); if (response.status === 404) return; if (!response.ok) throw new Error('Unable to load topics.'); const summary = await response.json(); topics = summary.topics || []; const list = document.querySelector('#topicsList'); if (list) list.innerHTML = topics.length ? topics.map((topic) => `<span class="topic-chip">${escapeHtml(topic)}</span>`).join('') : 'No topics detected yet.'; } catch (error) { showToast(error.message); } }
async function submitQuestion(question) { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions`, { method: 'POST', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) }); const data = await response.json().catch(() => ({})); if (!response.ok) { showToast(data.detail || 'Unable to ask question.'); return; } questions.push(data); renderQuestions(); realtime?.send('MEETING_EVENT', { name: 'question-created', question_id: data.id }); }
async function answerQuestion(questionId, answer) { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/questions/${encodeURIComponent(questionId)}/answer`, { method: 'PATCH', headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }) }); const data = await response.json().catch(() => ({})); if (!response.ok) { showToast(data.detail || 'Unable to answer question.'); return; } questions = questions.map((item) => item.id === data.id ? data : item); renderQuestions(); realtime?.send('MEETING_EVENT', { name: 'question-answered', question_id: data.id }); }
function updateQuestionTimer() { const node = document.querySelector('#questionTimer'); if (!node || !questionTimerEndsAt) return; const remaining = Math.max(0, Math.ceil((questionTimerEndsAt - Date.now()) / 1000)); node.textContent = remaining ? `Timer ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}` : 'Time is up'; if (!remaining) { window.clearInterval(questionTimer); questionTimer = null; questionTimerEndsAt = null; } }
function startQuestionTimer(seconds, broadcast = true) { questionTimerEndsAt = Date.now() + seconds * 1000; window.clearInterval(questionTimer); updateQuestionTimer(); questionTimer = window.setInterval(updateQuestionTimer, 1000); if (broadcast) realtime?.send('MEETING_EVENT', { name: 'question-timer-started', duration_seconds: seconds }); }
function renderNoteList() { const list = document.querySelector('#notesList'); if (!list) return; list.innerHTML = notes.length ? notes.map((note) => `<button class="note-list-item ${note.id === activeNoteId ? 'selected' : ''}" data-note-id="${note.id}"><b>${escapeHtml(note.title || 'Untitled note')}</b><small>${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(note.updated_at))}</small></button>`).join('') : '<p class="notes-empty">No notes yet. Start writing below.</p>'; }
function selectNote(note) { activeNoteId = note?.id || null; document.querySelector('#notesTitle').value = note?.title || ''; document.querySelector('#notesBody').value = note?.content || ''; updateSaveState(note ? `Last saved ${formatDate(note.updated_at)}` : 'New note'); renderNoteList(); }
async function loadNotes() { try { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/notes`, { headers: authHeaders }); if (!response.ok) throw new Error('Unable to load notes.'); notes = await response.json(); selectNote(notes[0] || null); } catch (error) { updateSaveState(error.message); } document.querySelector('#notesTitle').addEventListener('input', queueNoteSave); document.querySelector('#notesBody').addEventListener('input', queueNoteSave); }
function queueNoteSave() { updateSaveState('Saving...'); window.clearTimeout(noteSaveTimer); noteSaveTimer = window.setTimeout(saveNote, 650); }
async function saveNote() { const title = document.querySelector('#notesTitle').value.trim() || null; const content = document.querySelector('#notesBody').value; if (!title && !content.trim() && !activeNoteId) { updateSaveState('New note'); return; } const method = activeNoteId ? 'PUT' : 'POST'; const url = activeNoteId ? `${API_URL}/api/notes/${activeNoteId}` : `${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/notes`; try { const response = await fetch(url, { method, headers: { ...authHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content }) }); if (!response.ok) throw new Error('Unable to save note.'); const saved = await response.json(); if (!activeNoteId) notes.unshift(saved); else notes = notes.map((note) => note.id === saved.id ? saved : note); activeNoteId = saved.id; updateSaveState(`Last saved ${formatDate(saved.updated_at)}`); renderNoteList(); } catch (error) { updateSaveState(error.message); } }
async function deleteNote() { if (!activeNoteId) { selectNote(null); return; } try { const response = await fetch(`${API_URL}/api/notes/${activeNoteId}`, { method: 'DELETE', headers: authHeaders }); if (!response.ok) throw new Error('Unable to delete note.'); notes = notes.filter((note) => note.id !== activeNoteId); selectNote(notes[0] || null); } catch (error) { updateSaveState(error.message); } }
function downloadNotes() { const title = document.querySelector('#notesTitle').value || 'Meeting notes'; const body = document.querySelector('#notesBody').value || 'No notes yet.'; const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([`${title}\n\n${body}`], { type: 'text/plain' })); link.download = `${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.txt`; link.click(); URL.revokeObjectURL(link.href); }
function exportPdf() { const title = document.querySelector('#notesTitle').value || 'Meeting notes'; const body = document.querySelector('#notesBody').value || 'No notes yet.'; const printWindow = window.open('', '_blank', 'width=800,height=700'); if (!printWindow) { showToast('Allow pop-ups to export a PDF.'); return; } printWindow.document.write(`<html><head><title>${escapeHtml(title)}</title><style>body{font:14px Arial;max-width:760px;margin:50px auto;line-height:1.6}h1{font:24px Georgia}pre{white-space:pre-wrap;font:14px Arial}</style></head><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(body)}</pre></body></html>`); printWindow.document.close(); printWindow.focus(); printWindow.print(); }
function stopLocalMedia() { microphoneRecorder?.stop(); localStream.getTracks().forEach((track) => track.stop()); microphoneStream = null; cameraStream = null; localStream = new MediaStream(); mediaProvider?.disconnect(); }
function leaveMeeting() { stopLocalMedia(); realtime?.close(); fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/leave`, { method: 'POST', headers: authHeaders }).then((response) => { if (response.status === 401) { sessionStorage.removeItem(TOKEN_KEY); window.location.replace('../login/index.html'); } else if (response.ok) window.location.replace('../dashboard/index.html'); else showToast('Unable to leave this meeting'); }); }
async function updateMeetingLifecycle(action) { const endpoint = action === 'start' ? 'start' : 'end'; const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/${endpoint}`, { method: 'POST', headers: authHeaders }); if (!response.ok) { const detail = await response.json().catch(() => ({})); showToast(detail.detail || `Unable to ${endpoint} meeting.`); return; } window.location.reload(); }
async function toggleFullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.workspace-shell').requestFullscreen(); } catch { showToast('Fullscreen is not available in this browser.'); } }
function handleAction(action) { if (action === 'microphone' || action === 'mute') return toggleMicrophone(); if (action === 'camera') return toggleCamera(); if (action === 'meeting-settings') return openMeetingSettings(); if (action === 'prejoin-allow' || action === 'prejoin-retry') return completePreJoin(); if (action === 'prejoin-leave') return leaveMeeting(); if (action === 'settings-close') return document.querySelector('#settingsModal')?.remove(); if (action === 'fullscreen') return toggleFullscreen(); if (action === 'start-timer') { const minutes = Number(document.querySelector('#timerMinutes')?.value) || 2; return startQuestionTimer(minutes * 60); } if (action === 'start') return updateMeetingLifecycle('start'); if (action === 'end') return currentUserId && document.querySelector('.header-end')?.textContent === 'End meeting' ? updateMeetingLifecycle('end') : leaveMeeting(); if (action === 'delete-note') return deleteNote(); if (action === 'download-notes') return downloadNotes(); if (action === 'export-pdf') return exportPdf(); }
async function manageParticipant(action, userId, role) { const url = `${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(userId)}`; const response = await fetch(url, { method: action === 'remove' ? 'DELETE' : 'PATCH', headers: { ...authHeaders, 'Content-Type': 'application/json' }, ...(action === 'role' ? { body: JSON.stringify({ role }) } : {}) }); const data = await response.json().catch(() => ({})); if (!response.ok) { showToast(data.detail || 'Unable to update participant.'); return; } meetingState = data; document.querySelector('.participant-panel')?.replaceWith(new DOMParser().parseFromString(ParticipantList(meetingState), 'text/html').body.firstElementChild); showToast(action === 'remove' ? 'Participant removed.' : 'Participant role updated.'); }
async function boot() { if (!meetingId) { document.querySelector('#loading').textContent = 'No meeting ID was provided.'; return; } try { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}`, { headers: authHeaders }); if (response.status === 401) { sessionStorage.removeItem(TOKEN_KEY); window.location.replace('../login/index.html'); return; } const meeting = await response.json(); if (!response.ok) throw new Error(meeting.detail || 'Meeting not found or you do not have access.'); meetingState = meeting; await loadIceServers(); document.querySelector('#loading').remove(); renderWorkspace(meeting); } catch (error) { document.querySelector('#loading').textContent = error.message; } }
document.addEventListener('click', (event) => { const noteTarget = event.target.closest('[data-note-id]'); if (noteTarget) { const note = notes.find((item) => item.id === noteTarget.dataset.noteId); if (note) selectNote(note); return; } const target = event.target.closest('[data-action]'); if (target) handleAction(target.dataset.action); });
document.addEventListener('change', (event) => { const target = event.target.closest('[data-participant-action="role"]'); if (target) manageParticipant('role', target.dataset.userId, target.value); });
document.addEventListener('click', (event) => { const target = event.target.closest('[data-participant-action="remove"]'); if (target) manageParticipant('remove', target.dataset.userId); });
document.addEventListener('click', (event) => { const target = event.target.closest('[data-reaction]'); if (target) { const reaction = target.dataset.reaction; realtime?.send('REACTION', { reaction }); showReaction(reaction, 'You'); } });
document.addEventListener('fullscreenchange', () => { const button = document.querySelector('[data-action="fullscreen"]'); if (button) button.textContent = document.fullscreenElement ? '⛶ Exit fullscreen' : '⛶ Fullscreen'; });
document.addEventListener('submit', (event) => { if (event.target.id === 'qaForm') { event.preventDefault(); const question = new FormData(event.target).get('question')?.toString().trim(); if (question) submitQuestion(question); event.target.reset(); } if (event.target.classList.contains('answer-form')) { event.preventDefault(); const answer = new FormData(event.target).get('answer')?.toString().trim(); if (answer) answerQuestion(event.target.dataset.questionId, answer); } });
document.addEventListener('submit', (event) => { if (event.target.id === 'taskForm') { event.preventDefault(); const title = new FormData(event.target).get('title')?.toString().trim(); if (title) createTask(title); event.target.reset(); } });
document.addEventListener('submit', (event) => { if (event.target.id === 'settingsForm') { event.preventDefault(); saveMeetingSettings(event.target); } });
document.addEventListener('change', (event) => { const task = event.target.closest('[data-task-id]'); if (task) updateTaskStatus(task.dataset.taskId, task.value); });
boot();
