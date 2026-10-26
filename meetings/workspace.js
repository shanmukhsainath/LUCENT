const API_URL = window.MEETMIND_API_URL || 'http://localhost:8000';
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
let webrtc;
let meetingState;
let questions = [];
let tasks = [];
let topics = [];
let questionTimer;
let questionTimerEndsAt;

function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function initials(name = '') { return name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'MM'; }
function formatDate(value) { return value ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not scheduled'; }
function showToast(message) { const toast = document.querySelector('#toast'); toast.textContent = message; toast.classList.remove('hidden'); window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => toast.classList.add('hidden'), 2600); }
function showReaction(reaction, name = 'Participant') { const item = document.createElement('div'); item.className = 'reaction-pop'; item.textContent = `${reaction} ${name}`; document.body.appendChild(item); window.setTimeout(() => item.remove(), 2400); }
function EmptyPanel({ icon, title, message, className = '' }) { return `<div class="empty-panel ${className}"><span class="empty-panel-icon">${icon}</span><h3>${title}</h3><p>${message}</p></div>`; }
function MeetingHeader(meeting) { const people = meeting.participants.slice(0, 4).map((participant) => `<span class="participant-avatar">${initials(participant.name)}</span>`).join(''); const isHost = meeting.created_by === currentUserId; return `<a class="workspace-brand" href="../dashboard/index.html"><span>✦</span><span>meetmind <small>AI</small></span></a><div class="meeting-header"><a class="back-link" href="../dashboard/index.html" aria-label="Back to dashboard">←</a><div class="meeting-header-copy"><h1>${escapeHtml(meeting.title)}</h1><p>${escapeHtml(meeting.meeting_type)} · ${meeting.privacy_mode} · ${formatDate(meeting.start_time)}</p></div><span class="meeting-status">${escapeHtml(meeting.status)}</span><span class="connection-status" id="connectionStatus">Connecting</span></div><div class="header-right"><span class="language-badge">◎ ${meeting.language.toUpperCase()}</span><div class="participant-stack">${people}</div><button class="header-end" data-action="end">${isHost ? 'End meeting' : 'Leave'}</button></div>`; }
function TranscriptPanel() { return `<section class="panel transcript-panel"><div class="panel-heading"><div><p class="panel-kicker">YOUR MEDIA</p><h2>Meeting video</h2><p>WebRTC media is ready for participant signaling.</p></div><span class="panel-icon coral">◉</span></div><div class="media-grid" id="mediaGrid"><article class="media-tile local-tile"><video id="localVideo" autoplay muted playsinline></video><div class="media-placeholder" id="mediaPlaceholder"><span class="empty-panel-icon">◌</span><b>Camera is off</b><small>Your local preview will appear here.</small></div><span class="media-label">You</span><span class="media-state" id="mediaState">Camera off · Mic off</span></article><div class="remote-empty" id="remoteEmpty"><span class="empty-panel-icon">◎</span><b>Waiting for participants</b><small>Remote video will appear after WebRTC signaling is connected.</small></div><div id="remoteTiles"></div></div><div class="panel-heading transcript-heading"><div><p class="panel-kicker">LIVE CAPTIONS</p><h2>Live transcript</h2><p>Speech will appear here in real time.</p></div><span class="panel-icon coral">◉</span></div><div class="panel-content" id="transcriptContent">${EmptyPanel({ icon: '◌', title: 'Start the microphone to begin transcription.', message: 'No audio is being captured. Your transcript will stay empty until you enable the microphone.' })}</div></section>`; }
function NotesPanel() { return `<section class="panel notes-panel"><div class="panel-heading"><div><p class="panel-kicker">YOUR NOTES</p><h2>Digital notes</h2><p>Markdown or plain text, saved to this meeting.</p></div><span class="panel-icon">▤</span></div><div class="notes-list" id="notesList"></div><div class="notes-editor"><input class="notes-title" id="notesTitle" placeholder="Untitled note" aria-label="Note title"/><textarea class="notes-textarea" id="notesBody" placeholder="Start writing your thoughts..." aria-label="Meeting notes"></textarea><div class="notes-footer"><span id="saveState">New note</span><div class="notes-actions"><button class="small-button" data-action="delete-note">Delete</button><button class="small-button" data-action="download-notes">Text</button><button class="small-button" data-action="export-pdf">PDF</button></div></div></div></section>`; }
function TranslationPanel() { return `<section class="panel"><div class="panel-heading"><div><p class="panel-kicker">LANGUAGE SUPPORT</p><h2>Translation</h2><p>Translated captions will follow the transcript.</p></div><span class="panel-icon">文</span></div><div class="panel-content" id="translationContent">${EmptyPanel({ icon: '文', title: 'Translation is waiting for speech.', message: 'Choose a display language below. Live translation will activate with transcription.' })}</div></section>`; }
function QAPanel(meeting) { const isHost = meeting.created_by === currentUserId; return `<section class="panel qa-panel"><div class="panel-heading"><div><p class="panel-kicker">MEETING CONTEXT</p><h2>Questions</h2><p>Ask, answer, and keep timed prompts visible.</p></div><span class="panel-icon lavender">✧</span></div><div class="question-timer"><strong id="questionTimer">No active timer</strong>${isHost ? '<input id="timerMinutes" type="number" min="1" max="60" value="2" aria-label="Timer minutes"/><button class="small-button" data-action="start-timer">Start timer</button>' : ''}</div><div class="question-list" id="questionList">${EmptyPanel({ icon: 'Q', title: 'No questions yet.', message: 'Ask the first question about this meeting.' })}</div><form class="qa-input-wrap" id="qaForm"><input class="qa-input" name="question" placeholder="Ask about this meeting" aria-label="Ask a question" maxlength="2000" required/><button class="qa-send" type="submit" aria-label="Send question">→</button></form></section>`; }
function TaskPanel() { return `<section class="panel task-panel"><div class="panel-heading"><div><p class="panel-kicker">FOLLOW-UPS</p><h2>Tasks</h2><p>Track action items from the meeting.</p></div><span class="panel-icon">✓</span></div><div class="panel-content" id="taskList">${EmptyPanel({ icon: '✓', title: 'No tasks yet.', message: 'Add an action item for this meeting.' })}</div><form class="task-form" id="taskForm"><input name="title" placeholder="Add a task" aria-label="Task title" maxlength="255" required/><button type="submit">Add</button></form></section>`; }
function TopicsPanel() { return `<section class="panel"><div class="panel-heading"><div><p class="panel-kicker">SIGNALS</p><h2>Important topics</h2><p>Topics detected in the latest summary.</p></div><span class="panel-icon coral">◆</span></div><div class="topics" id="topicsList">${topics.length ? topics.map((topic) => `<span class="topic-chip">${escapeHtml(topic)}</span>`).join('') : 'Waiting for a summary'}</div></section>`; }
function ParticipantList(meeting) { const isHost = meeting.created_by === currentUserId; return `<section class="panel participant-panel"><div class="panel-heading"><div><p class="panel-kicker">IN THE ROOM</p><h2>Participants</h2></div><span class="panel-icon">◎</span></div><div class="mini-list">${meeting.participants.map((participant) => { const isMeetingHost = participant.user_id === meeting.created_by; const controls = isHost && !isMeetingHost ? `<span class="participant-actions"><select data-participant-action="role" data-user-id="${participant.user_id}" aria-label="Role for ${escapeHtml(participant.name || 'participant')}"><option value="participant" ${participant.role === 'participant' ? 'selected' : ''}>Participant</option><option value="viewer" ${participant.role === 'viewer' ? 'selected' : ''}>Viewer</option></select><button type="button" data-participant-action="remove" data-user-id="${participant.user_id}" aria-label="Remove ${escapeHtml(participant.name || 'participant')}">Remove</button></span>` : ''; return `<div class="participant-row"><span class="participant-avatar">${initials(participant.name)}</span><span class="participant-copy"><b>${escapeHtml(participant.name || 'MeetMind user')}</b><small>${participant.role}${isMeetingHost ? ' · host' : ''}</small></span>${controls}</div>`; }).join('')}</div></section>`; }
function MeetingControls(meeting) { const isHost = meeting.created_by === currentUserId; return `<div class="control-bar"><button class="control-button icon-only" id="micButton" data-action="microphone" aria-label="Enable microphone">♩</button><button class="control-button icon-only" id="cameraButton" data-action="camera" aria-label="Enable camera">▣</button><button class="control-button" id="recordButton" data-action="record">Start recording</button><button class="control-button" id="muteButton" data-action="mute">Mute</button><select class="control-language" id="displayLanguage" aria-label="Caption language"><option value="en">English</option><option value="es">Spanish</option><option value="fr">French</option><option value="de">German</option><option value="hi">Hindi</option></select><div class="reaction-picker" aria-label="Send reaction">${['👍','👏','❤️','🎉','😂','❓'].map((reaction) => `<button type="button" data-reaction="${reaction}" aria-label="Send ${reaction}">${reaction}</button>`).join('')}</div><span class="control-separator"></span><button class="control-button" data-action="fullscreen">⛶ Fullscreen</button><button class="control-button" data-action="bookmark">☆ Bookmark moment</button>${isHost && meeting.status === 'scheduled' ? '<button class="control-button" data-action="start">Start meeting</button>' : ''}<button class="control-button end-button" data-action="end">${isHost ? 'End meeting' : 'Leave'}</button></div>`; }
function renderWorkspace(meeting) { document.querySelector('#workspaceHeader').innerHTML = MeetingHeader(meeting); document.querySelector('#workspaceGrid').innerHTML = `${TranscriptPanel()}${NotesPanel()}<div class="right-column">${QAPanel(meeting)}${TaskPanel()}${TopicsPanel()}${ParticipantList(meeting)}</div>`; document.querySelector('#controls').innerHTML = MeetingControls(meeting); setupWebRTC(); loadNotes(); loadQuestions(); loadTasks(); loadTopics(); connectRealtime(); }
function renderRemoteStream(userId, stream) {
	const tiles = document.querySelector('#remoteTiles');
	if (!tiles) return;
	let tile = tiles.querySelector(`[data-user-id="${CSS.escape(userId)}"]`);
	if (!tile) {
		tile = document.createElement('article');
		tile.className = 'media-tile remote-tile';
		tile.dataset.userId = userId;
		tile.innerHTML = `<video autoplay playsinline></video><span class="media-label">Participant</span>`;
		tiles.appendChild(tile);
	}
	if (message.type === 'MEDIA_STATE' && message.sender?.name) {
		const audio = message.payload?.audio_enabled ? 'mic on' : 'muted';
		const video = message.payload?.video_enabled ? 'camera on' : 'camera off';
		showToast(`${message.sender.name}: ${audio}, ${video}.`);
	}
	tile.querySelector('video').srcObject = stream;
	document.querySelector('#remoteEmpty')?.classList.add('hidden');
}
function setupWebRTC() {
	if (!window.MeetingWebRTCService) return;
	webrtc = new window.MeetingWebRTCService({
		localStream: cameraStream || microphoneStream,
		onRemoteStream: renderRemoteStream,
		onConnectionState: (userId, state) => {
			if (state === 'connected') showToast('Participant media connected.');
		},
		onIceCandidate: (userId, candidate) => realtime?.sendIceCandidate(userId, candidate),
		onRemoteStreamRemoved: removeRemoteTile,
		onError: showToast,
	});
}
function updateConnectionStatus(status) { const node = document.querySelector('#connectionStatus'); if (!node) return; node.textContent = status; node.dataset.status = status; }
function appendStreamMessage(targetId, payload, fallbackTitle) { const target = document.querySelector(`#${targetId}`); if (!target || !payload) return; const text = payload.text || payload.content || payload.translated_text; if (!text) return; if (target.querySelector('.empty-panel')) target.innerHTML = '<div class="stream-list"></div>'; const list = target.querySelector('.stream-list'); const item = document.createElement('article'); item.className = 'stream-item'; item.innerHTML = `<small>${escapeHtml(payload.speaker_name || fallbackTitle)}</small><p>${escapeHtml(text)}</p>`; list.appendChild(item); list.scrollTop = list.scrollHeight; }
async function negotiateWith(userId) {
	if (!webrtc || !userId) return;
	try {
		const offer = await webrtc.createOffer(userId);
		if (!realtime?.sendOffer(userId, offer)) showToast('Participant signaling is not connected.');
	} catch (error) {
		showToast(`Unable to start participant connection: ${error.message}`);
	}
	async function renegotiatePeers() {
		if (!webrtc) return;
		for (const userId of webrtc.peers.keys()) await negotiateWith(userId);
	}
}
async function handleSignalingMessage(message) {
	const payload = message.payload || {};
	const senderId = payload.sender_user_id;
	if (!senderId || !webrtc) return;
	try {
		if (message.type === 'OFFER') {
			const answer = await webrtc.acceptOffer(senderId, payload.description);
			realtime?.sendAnswer(senderId, answer);
		} else if (message.type === 'ANSWER') {
			await webrtc.acceptAnswer(senderId, payload.description);
		} else if (message.type === 'ICE_CANDIDATE') {
			await webrtc.addIceCandidate(senderId, payload.candidate);
		}
	} catch (error) {
		showToast(`Participant connection failed: ${error.message}`);
	}
}
function removeRemoteTile(userId) {
	document.querySelector(`#remoteTiles [data-user-id="${CSS.escape(userId)}"]`)?.remove();
	if (!document.querySelector('#remoteTiles')?.children.length) document.querySelector('#remoteEmpty')?.classList.remove('hidden');
}
function handleRealtimeMessage(message) {
	if (message.type === 'TRANSCRIPT') appendStreamMessage('transcriptContent', message.payload, message.sender?.name || 'Speaker');
	if (message.type === 'TRANSLATION') appendStreamMessage('translationContent', message.payload, 'Translation');
	if (message.type === 'PARTICIPANT_ROSTER') message.payload?.participants?.forEach((participant) => webrtc?.createPeer(participant.user_id));
	if (message.type === 'PARTICIPANT_JOINED') {
		showToast(`${message.payload?.name || 'A participant'} joined the meeting.`);
		negotiateWith(message.payload?.user_id);
	}
	if (message.type === 'PARTICIPANT_LEFT') {
		const userId = message.payload?.user_id;
		webrtc?.removePeer(userId);
		removeRemoteTile(userId);
		showToast(`${message.payload?.name || 'A participant'} left the meeting.`);
	}
	if (['OFFER', 'ANSWER', 'ICE_CANDIDATE'].includes(message.type)) handleSignalingMessage(message);
	if (message.type === 'ERROR') showToast(message.payload?.message || 'Realtime message error.');
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
			if (status === 'connected' && microphoneStream && !microphoneRecorder) startMicrophoneRecorder();
		},
		onMessage: handleRealtimeMessage,
		onError: showToast,
	});
	realtime.connect();
}
function updateMediaState() {
	const cameraOn = Boolean(cameraStream?.getVideoTracks().some((track) => track.enabled));
	const micOn = Boolean(microphoneStream?.getAudioTracks().some((track) => track.enabled));
	const state = document.querySelector('#mediaState');
	if (state) state.textContent = `Camera ${cameraOn ? 'on' : 'off'} · Mic ${micOn ? 'on' : 'off'}`;
	realtime?.sendMediaState({ audio_enabled: micOn, video_enabled: cameraOn });
	const muteButton = document.querySelector('#muteButton');
	if (muteButton) {
		muteButton.textContent = micOn ? 'Mute' : 'Unmute';
		muteButton.classList.toggle('active', !micOn && Boolean(microphoneStream));
	}
	const placeholder = document.querySelector('#mediaPlaceholder');
	if (placeholder) placeholder.classList.toggle('hidden', cameraOn);
	const video = document.querySelector('#localVideo');
	if (video) video.classList.toggle('visible', cameraOn);
}
function mediaError(error, device) {
	if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return `${device} permission denied. Allow access in your browser settings and try again.`;
	if (error.name === 'NotFoundError') return `No ${device.toLowerCase()} detected. Connect a device and try again.`;
	if (error.name === 'NotReadableError') return `${device} is already in use by another application.`;
	return `Unable to access the ${device.toLowerCase()}.`;
}
async function toggleCamera() {
	const button = document.querySelector('#cameraButton');
	if (cameraStream) {
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
		cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
		document.querySelector('#localVideo').srcObject = cameraStream;
		webrtc?.setLocalStream(cameraStream);
		renegotiatePeers();
		button.classList.add('active');
		updateMediaState();
		showToast('Camera enabled.');
	} catch (error) {
		showToast(mediaError(error, 'Camera'));
	}
}
async function toggleMicrophone() {
	const button = document.querySelector('#micButton');
	if (microphoneStream) {
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
		microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
		if (!webrtc) setupWebRTC();
		else webrtc.setLocalStream(microphoneStream);
		renegotiatePeers();
		startMicrophoneRecorder();
		button.classList.add('active');
		updateMediaState();
		showToast('Microphone enabled. Listening for speech.');
	} catch (error) {
		microphoneStream?.getTracks().forEach((track) => track.stop());
		microphoneStream = null;
		showToast(mediaError(error, 'Microphone'));
	}
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
function leaveMeeting() { microphoneRecorder?.stop(); microphoneStream?.getTracks().forEach((track) => track.stop()); cameraStream?.getTracks().forEach((track) => track.stop()); webrtc?.close(); realtime?.close(); fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/leave`, { method: 'POST', headers: authHeaders }).then((response) => { if (response.status === 401) { sessionStorage.removeItem(TOKEN_KEY); window.location.replace('../login/index.html'); } else if (response.ok) window.location.replace('../dashboard/index.html'); else showToast('Unable to leave this meeting'); }); }
async function updateMeetingLifecycle(action) { const endpoint = action === 'start' ? 'start' : 'end'; const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/${endpoint}`, { method: 'POST', headers: authHeaders }); if (!response.ok) { const detail = await response.json().catch(() => ({})); showToast(detail.detail || `Unable to ${endpoint} meeting.`); return; } window.location.reload(); }
async function toggleFullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.querySelector('.workspace-shell').requestFullscreen(); } catch { showToast('Fullscreen is not available in this browser.'); } }
function handleAction(action) { if (action === 'microphone' || action === 'mute') return toggleMicrophone(); if (action === 'camera') return toggleCamera(); if (action === 'record') { const button = document.querySelector('#recordButton'); const recording = button.classList.toggle('recording'); button.textContent = recording ? 'Stop recording' : 'Start recording'; showToast(recording ? 'Recording control enabled for this workspace.' : 'Recording stopped.'); return; } if (action === 'fullscreen') return toggleFullscreen(); if (action === 'bookmark') return showToast('Bookmarks will be saved when meeting content is available.'); if (action === 'start-timer') { const minutes = Number(document.querySelector('#timerMinutes')?.value) || 2; return startQuestionTimer(minutes * 60); } if (action === 'start') return updateMeetingLifecycle('start'); if (action === 'end') return currentUserId && document.querySelector('.header-end')?.textContent === 'End meeting' ? updateMeetingLifecycle('end') : leaveMeeting(); if (action === 'delete-note') return deleteNote(); if (action === 'download-notes') return downloadNotes(); if (action === 'export-pdf') return exportPdf(); }
async function manageParticipant(action, userId, role) { const url = `${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/participants/${encodeURIComponent(userId)}`; const response = await fetch(url, { method: action === 'remove' ? 'DELETE' : 'PATCH', headers: { ...authHeaders, 'Content-Type': 'application/json' }, ...(action === 'role' ? { body: JSON.stringify({ role }) } : {}) }); const data = await response.json().catch(() => ({})); if (!response.ok) { showToast(data.detail || 'Unable to update participant.'); return; } meetingState = data; document.querySelector('.participant-panel')?.replaceWith(new DOMParser().parseFromString(ParticipantList(meetingState), 'text/html').body.firstElementChild); showToast(action === 'remove' ? 'Participant removed.' : 'Participant role updated.'); }
async function boot() { if (!meetingId) { document.querySelector('#loading').textContent = 'No meeting ID was provided.'; return; } try { const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}`, { headers: authHeaders }); if (response.status === 401) { sessionStorage.removeItem(TOKEN_KEY); window.location.replace('../login/index.html'); return; } const meeting = await response.json(); if (!response.ok) throw new Error(meeting.detail || 'Meeting not found or you do not have access.'); meetingState = meeting; document.querySelector('#loading').remove(); renderWorkspace(meeting); } catch (error) { document.querySelector('#loading').textContent = error.message; } }
document.addEventListener('click', (event) => { const noteTarget = event.target.closest('[data-note-id]'); if (noteTarget) { const note = notes.find((item) => item.id === noteTarget.dataset.noteId); if (note) selectNote(note); return; } const target = event.target.closest('[data-action]'); if (target) handleAction(target.dataset.action); });
document.addEventListener('change', (event) => { const target = event.target.closest('[data-participant-action="role"]'); if (target) manageParticipant('role', target.dataset.userId, target.value); });
document.addEventListener('click', (event) => { const target = event.target.closest('[data-participant-action="remove"]'); if (target) manageParticipant('remove', target.dataset.userId); });
document.addEventListener('click', (event) => { const target = event.target.closest('[data-reaction]'); if (target) { const reaction = target.dataset.reaction; realtime?.send('REACTION', { reaction }); showReaction(reaction, 'You'); } });
document.addEventListener('fullscreenchange', () => { const button = document.querySelector('[data-action="fullscreen"]'); if (button) button.textContent = document.fullscreenElement ? '⛶ Exit fullscreen' : '⛶ Fullscreen'; });
document.addEventListener('submit', (event) => { if (event.target.id === 'qaForm') { event.preventDefault(); const question = new FormData(event.target).get('question')?.toString().trim(); if (question) submitQuestion(question); event.target.reset(); } if (event.target.classList.contains('answer-form')) { event.preventDefault(); const answer = new FormData(event.target).get('answer')?.toString().trim(); if (answer) answerQuestion(event.target.dataset.questionId, answer); } });
document.addEventListener('submit', (event) => { if (event.target.id === 'taskForm') { event.preventDefault(); const title = new FormData(event.target).get('title')?.toString().trim(); if (title) createTask(title); event.target.reset(); } });
document.addEventListener('change', (event) => { const task = event.target.closest('[data-task-id]'); if (task) updateTaskStatus(task.dataset.taskId, task.value); });
boot();
