const API_URL = window.MEETMIND_API_URL || 'http://localhost:8000';
const TOKEN_KEY = 'meetmind_access_token';
const token = sessionStorage.getItem(TOKEN_KEY);
if (!token) window.location.replace('../login/index.html');
const authHeaders = { Authorization: `Bearer ${token}` };

function initials(name = '') { return name.split(' ').filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'MM'; }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }
function meetingCard(meeting) { return `<article class="meeting-card"><div class="meeting-card-top"><span class="meeting-symbol">◌</span><span class="status-pill">${escapeHtml(meeting.status)}</span></div><h3>${escapeHtml(meeting.title)}</h3><p>${escapeHtml(meeting.meeting_type)}</p><a class="card-link" href="../meetings/detail.html?id=${encodeURIComponent(meeting.id)}">Open workspace <span>→</span></a></article>`; }
function render(meetings, user) {
  const userInitials = initials(user.name);
  document.querySelector('#sidebar').innerHTML = `<div class="brand"><span class="brand-mark">✦</span><span>meetmind <small>AI</small></span></div><nav class="nav" aria-label="Primary navigation"><a class="nav-item active" href="#overview"><span>◉</span>Dashboard</a><a class="nav-item" href="#meetings"><span>◌</span>Meetings</a><a class="nav-item" href="#tasks"><span>✓</span>Tasks</a><a class="nav-item" href="#notes"><span>▤</span>Notes</a></nav><div class="sidebar-bottom"><button class="logout-button" data-action="logout">Log out</button></div>`;
  document.querySelector('#header').innerHTML = `<button class="mobile-menu-button" data-action="toggle-menu" aria-label="Open navigation" aria-expanded="false">☰</button><div class="breadcrumb"><span>Workspace</span><span>/</span><b>Dashboard</b></div><div class="header-actions"><button class="icon-button notification-button" data-action="notifications" aria-label="Notifications" aria-expanded="false">♧</button><button class="button button-primary header-create" data-action="create-meeting"><span>＋</span> Create meeting</button><div class="profile-menu"><button class="profile-button" data-action="profile" aria-expanded="false" aria-haspopup="menu"><span class="avatar avatar-teal">${userInitials}</span><span class="profile-name">${escapeHtml(user.name)}</span><span class="chevron">⌄</span></button><div class="profile-dropdown hidden" role="menu"><div class="profile-summary"><span class="avatar avatar-teal">${userInitials}</span><span><b>${escapeHtml(user.name)}</b><small>Signed in</small></span></div><a href="#overview" role="menuitem">Dashboard</a><a href="#meetings" role="menuitem">Meetings</a><a href="#tasks" role="menuitem">Tasks</a><a href="#notes" role="menuitem">Notes</a><button data-action="logout" role="menuitem">Sign out</button></div></div></div>`;
  if (!document.querySelector('#notificationPopover')) {
    document.body.insertAdjacentHTML('beforeend', '<div class="notification-popover hidden" id="notificationPopover" role="status"><div class="popover-heading"><b>Notifications</b></div><p class="muted">Notifications will appear here when the notification service is available.</p></div>');
  }
  document.querySelector('#welcomeName').textContent = user.name.split(' ')[0];
  document.querySelector('#stats').innerHTML = `<article class="stat-card"><strong>${meetings.length}</strong><small>Accessible meetings</small></article>`;
  document.querySelector('#recentMeetings').innerHTML = meetings.length ? meetings.map(meetingCard).join('') : '<div class="empty-state"><h3>No meetings yet</h3><p>Create your first meeting.</p></div>';
  document.querySelector('#upcomingMeetings').innerHTML = '<p class="muted">Upcoming meetings will appear here.</p>';
  document.querySelector('#pendingTasks').innerHTML = '<p class="muted">No pending tasks.</p>';
  document.querySelector('#quickActions').innerHTML = '<p class="muted">Available with meeting content.</p>';
}
function logout() { sessionStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem('meetmind_user'); window.location.replace('../login/index.html'); }
function handleAction(action) {
  if (action === 'logout') logout();
  if (action === 'create-meeting') window.location.href = '../meetings/create/index.html';
  if (action === 'join-meeting') window.location.href = '../meetings/join/index.html';
}
document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (target) {
    handleAction(target.dataset.action);
    if (target.dataset.action === 'profile') {
      const dropdown = document.querySelector('.profile-dropdown');
      const open = dropdown.classList.toggle('hidden') === false;
      target.setAttribute('aria-expanded', String(open));
    }
    if (target.dataset.action === 'notifications') {
      document.querySelector('#notificationPopover').classList.toggle('hidden');
    }
    if (target.dataset.action === 'toggle-menu') {
      const sidebar = document.querySelector('#sidebar');
      const open = sidebar.classList.toggle('is-open');
      target.setAttribute('aria-expanded', String(open));
    }
  } else if (!event.target.closest('.profile-menu') && !event.target.closest('#notificationPopover')) {
    document.querySelector('.profile-dropdown')?.classList.add('hidden');
    document.querySelector('#notificationPopover')?.classList.add('hidden');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    document.querySelector('.profile-dropdown')?.classList.add('hidden');
    document.querySelector('#notificationPopover')?.classList.add('hidden');
    document.querySelector('#sidebar')?.classList.remove('is-open');
  }
});
function updateActiveNav() {
  const hash = window.location.hash || '#overview';
  document.querySelectorAll('.nav-item').forEach((item) => item.classList.toggle('active', item.getAttribute('href') === hash));
}
window.addEventListener('hashchange', updateActiveNav);
async function load() {
  try {
    const userResponse = await fetch(`${API_URL}/api/auth/me`, { headers: authHeaders });
    if (!userResponse.ok) throw new Error('Session expired');
    const meetingsResponse = await fetch(`${API_URL}/api/meetings`, { headers: authHeaders });
    if (!meetingsResponse.ok) throw new Error('Unable to load meetings');
    render(await meetingsResponse.json(), await userResponse.json());
    updateActiveNav();
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
    window.location.replace('../login/index.html');
  }
}
load();
