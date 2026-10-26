const API_URL = window.MEETMIND_API_URL || 'http://localhost:8000';
const TOKEN_KEY = 'meetmind_access_token';
const token = sessionStorage.getItem(TOKEN_KEY);
const loginPath = window.location.pathname.includes('/meetings/create/') || window.location.pathname.includes('/meetings/join/')
  ? '../../login/index.html'
  : '../login/index.html';
const detailPath = window.location.pathname.includes('/meetings/create/') || window.location.pathname.includes('/meetings/join/')
  ? '../../meetings/detail.html'
  : 'detail.html';
if (!token) window.location.replace(loginPath);
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

function initials(name = '') { return name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'MM'; }
function showError(message) { const node = document.querySelector('#formError'); node.textContent = message; node.classList.add('visible'); }
function clearError() { document.querySelector('#formError')?.classList.remove('visible'); }
function setLoading(button, loading, label) { button.disabled = loading; button.textContent = loading ? 'Please wait...' : label; }
function formatDate(value) { return value ? new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not scheduled'; }
function handleUnauthorized(response) { if (response.status === 401) { sessionStorage.removeItem(TOKEN_KEY); window.location.replace(loginPath); return true; } return false; }

async function createMeeting(event) {
  event.preventDefault(); clearError();
  const form = event.currentTarget; const button = form.querySelector('button[type="submit"]');
  setLoading(button, true, 'Create meeting →');
  const values = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch(`${API_URL}/api/meetings`, { method: 'POST', headers, body: JSON.stringify({ ...values, start_time: values.start_time || null, end_time: values.end_time || null }) });
    if (handleUnauthorized(response)) return;
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Unable to create meeting.');
    window.location.href = `${detailPath}?id=${data.id}`;
  } catch (error) { showError(error.message); setLoading(button, false, 'Create meeting →'); }
}
async function joinMeeting(event) {
  event.preventDefault(); clearError();
  const form = event.currentTarget; const button = form.querySelector('button[type="submit"]');
  setLoading(button, true, 'Joining meeting →');
  const values = Object.fromEntries(new FormData(form));
  try {
    const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(values.meeting_id)}/join`, { method: 'POST', headers, body: JSON.stringify({ role: values.role }) });
    if (handleUnauthorized(response)) return;
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Unable to join meeting.');
    window.location.href = `${detailPath}?id=${data.id}`;
  } catch (error) { showError(error.message); setLoading(button, false, 'Join meeting →'); }
}
async function loadMeeting() {
  const meetingId = new URLSearchParams(window.location.search).get('id');
  if (!meetingId) { showError('No meeting ID was provided.'); return; }
  try {
    const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}`, { headers });
    if (handleUnauthorized(response)) return;
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || 'Meeting not found or you do not have access.');
    document.querySelector('#detailContent').innerHTML = `<div class="detail-header"><div><p class="eyebrow">MEETING WORKSPACE</p><h1>${data.title}</h1><p>${data.meeting_type} · ${data.language.toUpperCase()} · ${formatDate(data.start_time)}</p></div><span class="status">${data.status}</span></div><div class="detail-grid"><section class="detail-section"><p class="eyebrow">ABOUT THIS MEETING</p><h2>${data.description || 'No description provided.'}</h2><p>The meeting workspace is ready. Live transcription and meeting intelligence will be connected in a later phase.</p><div class="empty-workspace">Transcript and live collaboration will appear here when the meeting engine is implemented.</div></section><section class="detail-section"><p class="eyebrow">PARTICIPANTS · ${data.participants.length}</p><div class="participant-list">${data.participants.map((participant) => `<div class="participant"><span class="avatar">${initials(participant.name)}</span><span><b>${participant.name || 'MeetMind user'}</b><small>${participant.joined_at ? 'Joined' : 'Invited'}</small></span><span class="role">${participant.role}</span></div>`).join('')}</div><div class="detail-actions"><button class="button button-secondary" id="leaveButton">Leave meeting</button><a class="button button-primary" href="../dashboard/index.html">Back to dashboard</a></div></section></div>`;
    document.querySelector('#leaveButton').addEventListener('click', () => leaveMeeting(meetingId));
  } catch (error) { document.querySelector('#detailContent').innerHTML = `<div class="empty-workspace">${error.message}</div>`; }
}
async function leaveMeeting(meetingId) {
  const response = await fetch(`${API_URL}/api/meetings/${encodeURIComponent(meetingId)}/leave`, { method: 'POST', headers });
  if (handleUnauthorized(response)) return;
  if (response.ok) window.location.href = '../dashboard/index.html';
}
window.MeetingPage = { createMeeting, joinMeeting, loadMeeting };
