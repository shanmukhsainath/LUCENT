const API_URL = window.MEETMIND_API_URL || 'http://localhost:8000';
const TOKEN_KEY = 'meetmind_access_token';

function getToken() {
  return sessionStorage.getItem(TOKEN_KEY);
}
function setAuthSession(data) {
  sessionStorage.setItem(TOKEN_KEY, data.access_token);
  sessionStorage.setItem('meetmind_user', JSON.stringify(data.user));
}
function clearAuthSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem('meetmind_user');
}
function goToDashboard() {
  window.location.href = '../dashboard/index.html';
}
function goToLogin() {
  window.location.href = '../login/index.html';
}
async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
  } catch {
    throw new Error(
      `Cannot reach the MeetMind API at ${API_URL}. Make sure the backend is running ` +
        '(uvicorn app.main:app --reload), then reload this page.'
    );
  }
  let data = {};
  try { data = await response.json(); } catch { /* non-JSON response */ }
  if (!response.ok) {
    const detail = Array.isArray(data.detail) ? data.detail.map((item) => item.msg).join('. ') : data.detail;
    throw new Error(detail || 'Something went wrong. Please try again.');
  }
  return data;
}
function field(label, type, name, placeholder, help = '') {
  const wrapper = document.createElement('div');
  wrapper.className = 'field';
  wrapper.innerHTML = `<label for="${name}">${label}</label><input id="${name}" name="${name}" type="${type}" placeholder="${placeholder}" required />${help ? `<small>${help}</small>` : ''}`;
  return wrapper;
}
function showFormError(message) {
  const error = document.querySelector('#formError');
  error.textContent = message;
  error.classList.add('visible');
}
function clearFormError() {
  document.querySelector('#formError').classList.remove('visible');
}
function setupAuthForm(mode) {
  const form = document.querySelector('#authForm');
  const fields = document.querySelector('#fields');
  if (mode === 'register') {
    fields.append(field('Your name', 'text', 'name', 'Alex Rivera'));
    fields.append(field('Email address', 'email', 'email', 'you@example.com'));
    fields.append(field('Password', 'password', 'password', 'Create a strong password', 'At least 8 characters, including upper, lower, and a number.'));
  } else {
    fields.append(field('Email address', 'email', 'username', 'you@example.com'));
    fields.append(field('Password', 'password', 'password', 'Your password'));
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearFormError();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = mode === 'register' ? 'Creating account...' : 'Signing in...';
    try {
      const values = Object.fromEntries(new FormData(form));
      const data = mode === 'login'
        ? await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: values.username, password: values.password }) })
        : await request('/api/auth/register', { method: 'POST', body: JSON.stringify(values) });
      setAuthSession(data);
      goToDashboard();
    } catch (error) {
      showFormError(error.message);
      button.disabled = false;
      button.textContent = mode === 'register' ? 'Create account →' : 'Sign in →';
    }
  });
}
