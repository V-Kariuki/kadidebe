// In local dev, Vite's proxy forwards relative /api and /ws to localhost:4000
// (see vite.config.js), so VITE_API_URL can be left unset.
// In production — e.g. frontend on Vercel, backend on Render/Railway/Fly —
// set VITE_API_URL to the backend's full origin (https://your-api.onrender.com)
// as an environment variable in the Vercel project settings.
const API_ORIGIN = import.meta.env.VITE_API_URL || '';
const BASE = API_ORIGIN + '/api';

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = getCookie('ncn_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  const res = await fetch(BASE + path, {
    ...options,
    method,
    credentials: 'include',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const e = new Error(err.error || 'Request failed');
    e.status = res.status;
    e.details = err.details;
    throw e;
  }
  if (res.status === 204) return null;
  return res.json();
}

async function uploadFile(path, file) {
  const formData = new FormData();
  formData.append('file', file);
  const csrf = getCookie('ncn_csrf');

  const res = await fetch(BASE + path, {
    method: 'POST',
    credentials: 'include',
    headers: csrf ? { 'X-CSRF-Token': csrf } : {},
    body: formData
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Upload failed');
  }
  return res.json();
}

async function downloadFile(path, filename) {
  const res = await fetch(BASE + path, { credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Download failed');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  login: (email, password) => request('/auth/login', { method: 'POST', body: { email, password } }),
  register: (name, email, password) => request('/auth/register', { method: 'POST', body: { name, email, password } }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
  overview: () => request('/overview'),
  wards: () => request('/wards'),
  createWard: (body) => request('/wards', { method: 'POST', body }),
  updateWard: (id, body) => request(`/wards/${id}`, { method: 'PATCH', body }),
  deleteWard: (id) => request(`/wards/${id}`, { method: 'DELETE' }),
  importWards: (file) => uploadFile('/wards/import', file),
  downloadWardTemplate: () => downloadFile('/wards/import-template', 'wards-template.csv'),
  constituencies: () => request('/constituencies'),
  createConstituency: (name) => request('/constituencies', { method: 'POST', body: { name } }),
  updateConstituency: (id, name) => request(`/constituencies/${id}`, { method: 'PATCH', body: { name } }),
  deleteConstituency: (id) => request(`/constituencies/${id}`, { method: 'DELETE' }),
  stations: () => request('/stations'),
  createStation: (body) => request('/stations', { method: 'POST', body }),
  updateStation: (id, body) => request(`/stations/${id}`, { method: 'PATCH', body }),
  deleteStation: (id) => request(`/stations/${id}`, { method: 'DELETE' }),
  assignStationAgent: (id, agentId) => request(`/stations/${id}/assign`, { method: 'PATCH', body: { agentId } }),
  submitResult: (id, body) => request(`/stations/${id}/result`, { method: 'POST', body }),
  agents: () => request('/agents'),
  setAgentStatus: (id, status) => request(`/agents/${id}`, { method: 'PATCH', body: { status } }),
  incidents: () => request('/incidents'),
  createIncident: (body) => request('/incidents', { method: 'POST', body }),
  resolveIncident: (id) => request(`/incidents/${id}`, { method: 'PATCH', body: { status: 'resolved' } }),
  activity: () => request('/activity'),
  users: () => request('/users'),
  approveUser: (id, role, wardId) => request(`/users/${id}/approve`, { method: 'POST', body: { role, wardId } }),
  declineUser: (id) => request(`/users/${id}/decline`, { method: 'POST' }),
  setUserWard: (id, wardId) => request(`/users/${id}/assignment`, { method: 'PATCH', body: { wardId } }),
  auditLog: () => request('/audit')
};

export function connectLiveSync(onMessage) {
  const wsOrigin = import.meta.env.VITE_WS_URL || '';
  let wsUrl;
  if (wsOrigin) {
    wsUrl = wsOrigin.replace(/^http/, 'ws') + '/ws';
  } else {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    wsUrl = `${protocol}://${window.location.host}/ws`;
  }
  const socket = new WebSocket(wsUrl);
  socket.onmessage = (event) => {
    try { onMessage(JSON.parse(event.data)); } catch { /* ignore malformed frames */ }
  };
  return socket;
}
