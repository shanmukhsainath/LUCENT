const TOKEN_KEY = 'meetmind_access_token';
const API_URL = window.MEETMIND_API_URL || 'http://localhost:8000';
const accessToken = sessionStorage.getItem(TOKEN_KEY);

if (!accessToken) {
  window.location.href = 'login/index.html';
}

const modal = document.querySelector('#meetingModal');
const nameInput = document.querySelector('#meetingName');
const toast = document.querySelector('#toast');
const toastMessage = document.querySelector('#toastMessage');
let toastTimer;

async function loadCurrentUser() {
  try {
    const response = await fetch(`${API_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error('Session expired');
    const user = await response.json();
    document.querySelector('#profileName').textContent = user.name;
  } catch {
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem('meetmind_user');
    window.location.href = 'login/index.html';
  }
}

function showToast(message) {
  toastMessage.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}
function closeModal() {
  modal.classList.add('hidden');
}
document.querySelector('#newMeetingBtn').addEventListener('click', () => {
  modal.classList.remove('hidden');
  nameInput.focus();
});
document.querySelector('#closeModal').addEventListener('click', closeModal);
document.querySelector('#cancelModal').addEventListener('click', closeModal);
modal.addEventListener('click', (event) => {
  if (event.target === modal) closeModal();
});
document.querySelector('#startMeeting').addEventListener('click', () => {
  const name = nameInput.value.trim() || 'Untitled meeting';
  closeModal();
  nameInput.value = '';
  showToast(`${name} workspace is ready`);
});
document.querySelector('#joinBtn').addEventListener('click', () => showToast('Joining Product sync...'));
document.querySelector('#viewAllBtn').addEventListener('click', () => showToast('Showing all recent activity'));
document.querySelector('#logoutBtn').addEventListener('click', () => {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem('meetmind_user');
  window.location.href = 'login/index.html';
});
document.querySelector('.tip-close').addEventListener('click', (event) => event.currentTarget.closest('.sidebar-tip').remove());
document.querySelectorAll('.task-list input').forEach((checkbox) => {
  checkbox.addEventListener('change', () => showToast(checkbox.checked ? 'Task marked complete' : 'Task reopened'));
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModal();
});

if (accessToken) loadCurrentUser();
