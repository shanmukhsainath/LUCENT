const TOKEN_KEY = 'meetmind_access_token';
const API_URL = window.MEETMIND_API_URL || ((window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') && window.location.port !== '8000' ? `${window.location.protocol}//${window.location.hostname}:8000` : (window.location.protocol.startsWith('http') ? window.location.origin : 'http://localhost:8000'));
const accessToken = sessionStorage.getItem(TOKEN_KEY);
if (!accessToken) window.location.href = 'login/index.html';

async function loadCurrentUser() {
  try {
    const response = await fetch(`${API_URL}/api/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!response.ok) throw new Error('Session expired');
    const user = await response.json();
    document.querySelector('#profileName')?.replaceChildren(document.createTextNode(user.name));
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem('meetmind_user');
    window.location.href = 'login/index.html';
  }
}

document.querySelector('#newMeetingBtn')?.addEventListener('click', () => { window.location.href = 'meetings/create/index.html'; });
document.querySelector('#joinBtn')?.addEventListener('click', () => { window.location.href = 'meetings/join/index.html'; });
document.querySelector('#logoutBtn')?.addEventListener('click', () => {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem('meetmind_user');
  window.location.href = 'login/index.html';
});
if (accessToken) loadCurrentUser();
