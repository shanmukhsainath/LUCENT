const API_URL = window.MEETMIND_API_URL || 'http://localhost:8000';
const TOKEN_KEY = 'meetmind_access_token';
const token = sessionStorage.getItem(TOKEN_KEY);

if (!token) window.location.replace('../login/index.html');

const userState = { user: null };

function initials(name = '') {
  return name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'MM';
}
function escapeHtml(value = '') {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}
function Sidebar() {
  return `<div class="brand"><span class="brand-mark">✦</span><span>meetmind <small>AI</small></span></div><div class="workspace-switcher"><span class="avatar avatar-teal">${initials(userState.user?.name)}</span><span><b>Personal workspace</b><small>${escapeHtml(userState.user?.preferred_language || 'en')} · Private</small></span><span class="chevron">⌄</span></div><nav class="nav" aria-label="Primary navigation"><a class="nav-item active" href="#overview"><span>◉</span>Overview</a><a class="nav-item" href="#meetings"><span>◌</span>Meetings</a><a class="nav-item" href="#tasks"><span>✓</span>Tasks</a><a class="nav-item" href="#library"><span>▧</span>Library</a></nav><div class="sidebar-bottom"><button class="nav-item settings-link" data-action="settings" type="button"><span>⚙</span>Settings</button><div class="sidebar-note"><span>✧</span><div><b>Private by design</b><small>Your content stays in your workspace.</small></div></div><div class="profile"><span class="avatar avatar-coral">${initials(userState.user?.name)}</span><span><b>${escapeHtml(userState.user?.name || 'MeetMind user')}</b><small>Workspace member</small></span><button class="logout-button" data-action="logout" type="button">Log out</button></div></div>`;
}
function Header() {
  return `<div class="breadcrumb"><span>Workspace</span><span>/</span><b>Dashboard</b></div><div class="header-profile"><span class="language-chip">◎ ${escapeHtml(userState.user?.preferred_language?.toUpperCase() || 'EN')}</span><button class="profile-button" type="button"><span class="avatar avatar-coral">${initials(userState.user?.name)}</span><span class="profile-name">${escapeHtml(userState.user?.name || 'MeetMind user')}</span><span class="chevron">⌄</span></button></div>`;
}
function DashboardStats(meetingCount = 0) {
  const stats = [['◌', 'Meetings', String(meetingCount), meetingCount ? 'Accessible meetings' : 'No meetings yet'], ['✓', 'Open tasks', '0', 'Nothing pending'], ['▤', 'Notes', '0', 'No notes yet'], ['◷', 'Minutes captured', '0', 'Ready to begin']];
  return stats.map(([icon, label, value, detail]) => `<article class="stat-card"><span class="stat-icon">${icon}</span><div><p>${label}</p><strong>${value}</strong><small>${detail}</small></div></article>`).join('');
}
function emptyState(title, message, actionLabel = '') {
  return `<div class="empty-state"><span class="empty-icon">○</span><h3>${title}</h3><p>${message}</p>${actionLabel ? `<button class="text-button" data-action="create-meeting">${actionLabel} →</button>` : ''}</div>`;
}
function MeetingCard({ id, title, meta, state = 'scheduled' }) {
  return `<article class="meeting-card"><div class="meeting-card-top"><span class="meeting-symbol">◌</span><span class="status-pill">${state}</span></div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(meta)}</p><a class="card-link" href="../meetings/detail.html?id=${encodeURIComponent(id)}">Open workspace <span>→</span></a></article>`;
}
function TaskCard({ title, meta }) {
  return `<article class="task-card"><span class="task-check">✓</span><div><h3>${title}</h3><p>${meta}</p></div><span class="task-arrow">→</span></article>`;
}
function renderUnavailableContent(meetings = []) {
  const recent = meetings.slice(0, 3).map((meeting) => MeetingCard({ id: meeting.id, title: meeting.title, state: meeting.status, meta: `${meeting.meeting_type} · ${meeting.language.toUpperCase()} · ${meeting.start_time ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(meeting.start_time)) : 'Not scheduled'}` })).join('');
  const upcoming = meetings.filter((meeting) => meeting.start_time && new Date(meeting.start_time) >= new Date()).slice(0, 3).map((meeting) => MeetingCard({ id: meeting.id, title: meeting.title, state: meeting.status, meta: `${meeting.meeting_type} · ${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(meeting.start_time))}` })).join('');
  document.querySelector('#recentMeetings').innerHTML = recent || emptyState('No meetings yet', 'Create your first meeting to start capturing conversation.', 'Create a meeting');
  document.querySelector('#upcomingMeetings').innerHTML = upcoming || emptyState('Your calendar is clear', 'Upcoming meetings will appear here when meeting scheduling is connected.');
  document.querySelector('#pendingTasks').innerHTML = emptyState('No pending tasks', 'Tasks extracted from meetings will show up here for follow-up.');
}
function renderQuickActions() {
  const actions = [['✧', 'Summarize a document', 'Upload a document to get a concise summary.'], ['Q', 'Ask about a meeting', 'Ask context-aware questions after a meeting is connected.'], ['↗', 'Translate notes', 'Translation becomes available when notes exist.'], ['▤', 'Generate action items', 'Turn meeting content into follow-ups.']];
  document.querySelector('#quickActions').innerHTML = actions.map(([icon, title, description]) => `<button class="ai-action" type="button" data-action="ai-placeholder"><span class="ai-icon">${icon}</span><span><b>${title}</b><small>${description}</small></span><span class="action-arrow">→</span></button>`).join('');
}
function openModal(title, message, icon = '✦') {
  document.querySelector('#modalTitle').textContent = title;
  document.querySelector('#modalMessage').textContent = message;
  document.querySelector('#modalIcon').textContent = icon;
  document.querySelector('#actionModal').classList.remove('hidden');
}
function closeModal() { document.querySelector('#actionModal').classList.add('hidden'); }
function openSettings() { const form = document.querySelector('#settingsForm'); form.elements.name.value = userState.user?.name || ''; form.elements.preferred_language.value = userState.user?.preferred_language || 'en'; form.elements.timezone.value = userState.user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; document.querySelector('#settingsState').textContent = 'Changes are saved to your account.'; document.querySelector('#settingsModal').classList.remove('hidden'); }
function closeSettings() { document.querySelector('#settingsModal').classList.add('hidden'); }
async function saveSettings(event) { event.preventDefault(); const form = event.target; const state = document.querySelector('#settingsState'); state.textContent = 'Saving...'; const response = await fetch(`${API_URL}/api/auth/me`, { method: 'PATCH', headers: { Authorization: `******, 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }); const data = await response.json().catch(() => ({})); if (!response.ok) { state.textContent = data.detail || 'Unable to save settings.'; return; } userState.user = data; sessionStorage.setItem('meetmind_user', JSON.stringify(data)); document.querySelector('#sidebar').innerHTML = Sidebar(); document.querySelector('#header').innerHTML = Header(); document.querySelector('#welcomeName').textContent = data.name.split(' ')[0]; state.textContent = 'Saved.'; }
function logout() { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem('meetmind_user'); window.location.replace('../login/index.html'); }
function handleAction(action) {
  if (action === 'logout') return logout();
  if (action === 'settings') return openSettings();
  if (action === 'close-settings') return closeSettings();
  if (action === 'create-meeting') return window.location.href = '../meetings/create/index.html';
  if (action === 'join-meeting') return window.location.href = '../meetings/join/index.html';
  if (action === 'calendar') return openModal('Calendar integration comes next.', 'Upcoming meeting data will appear here when scheduling is connected.', '◷');
  if (action === 'ai-placeholder') return openModal('AI tools need context.', 'This action will activate when meeting or document content is available. No AI results are being shown yet.', '✧');
  if (action === 'meeting-placeholder') return openModal('No meeting to open.', 'Create or connect a meeting first, then its transcript and workspace will appear here.', '◌');
}
async function loadUser() {
  try {
    const response = await fetch(`${API_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('Session expired');
    userState.user = await response.json();
    sessionStorage.setItem('meetmind_user', JSON.stringify(userState.user));
    document.querySelector('#sidebar').innerHTML = Sidebar();
    document.querySelector('#header').innerHTML = Header();
    document.querySelector('#welcomeName').textContent = userState.user.name.split(' ')[0];
    let meetings = [];
    const meetingsResponse = await fetch(`${API_URL}/api/meetings`, { headers: { Authorization: `Bearer ${token}` } });
    if (meetingsResponse.ok) meetings = await meetingsResponse.json();
    document.querySelector('#stats').innerHTML = DashboardStats(meetings.length);
    renderUnavailableContent(meetings);
    renderQuickActions();
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem('meetmind_user');
    window.location.replace('../login/index.html');
  }
}
document.querySelector('#dateLabel').textContent = new Intl.DateTimeFormat('en', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()).toUpperCase();
document.addEventListener('click', (event) => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) handleAction(actionTarget.dataset.action);
  if (event.target === document.querySelector('#actionModal') || event.target.closest('#closeModal') || event.target.closest('#modalDone')) closeModal();
  if (event.target === document.querySelector('#settingsModal')) closeSettings();
});
document.addEventListener('submit', (event) => { if (event.target.id === 'settingsForm') saveSettings(event); });
loadUser();
