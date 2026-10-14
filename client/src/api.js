// In local dev, Vite's proxy forwards relative /api and /ws to localhost:4000
// (see vite.config.js), so VITE_API_URL can be left unset.
// In production — e.g. frontend on Vercel, backend on Render/Railway/Fly —
// set VITE_API_URL to the backend's full origin as a Vercel env var.
const API_ORIGIN = import.meta.env.VITE_API_URL || '';
const BASE = API_ORIGIN + '/api';

// Superadmin "view as instance". A superadmin has no tenant of their own, so
// every tenant-scoped endpoint refuses them. When they open an instance, its
// id is attached to every request (X-Tenant-Id header, or ?tenantId= where a
// header can't be sent, e.g. <img src>); the server honours it for
// superadmins only.
let viewingTenantId = null;
export function setViewingTenantId(id) { viewingTenantId = id || null; }
export function getViewingTenantId() { return viewingTenantId; }

function getCookie(name) {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

// A 401 from any request means the session has expired or was never valid.
// Broadcasting this lets AuthContext clear its stale `user` in one place
// instead of every page needing its own expiry-handling logic.
function handleAuthExpiry(status) {
  if (status === 401) window.dispatchEvent(new Event('auth:expired'));
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const method = (options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = getCookie('ncn_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  if (viewingTenantId) headers['X-Tenant-Id'] = viewingTenantId;

  const res = await fetch(BASE + path, {
    ...options, method, credentials: 'include', headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    handleAuthExpiry(res.status);
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const e = new Error(err.error || 'Request failed');
    e.status = res.status;
    e.details = err.details;
    throw e;
  }
  if (res.status === 204) return null;
  return res.json();
}

// For multipart/form-data requests (file uploads) — no JSON content-type,
// FormData sets its own boundary header automatically.
async function requestForm(path, formData, method = 'POST') {
  const csrf = getCookie('ncn_csrf');
  const res = await fetch(BASE + path, {
    method, credentials: 'include',
    headers: { ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(viewingTenantId ? { 'X-Tenant-Id': viewingTenantId } : {}) },
    body: formData
  });
  if (!res.ok) {
    handleAuthExpiry(res.status);
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
  return requestForm(path, formData);
}

async function downloadFile(path, filename) {
  const res = await fetch(BASE + path, { credentials: 'include', headers: viewingTenantId ? { 'X-Tenant-Id': viewingTenantId } : {} });
  if (!res.ok) {
    handleAuthExpiry(res.status);
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

// Authenticated evidence/attachment file URL (image/video/audio), used
// directly in <img>/<video>/<audio> src — the browser sends the session
// cookie automatically since these stay same-origin (or credentialed via
// the Vercel proxy).
export function attachmentUrl(id) {
  return `${BASE}/attachments/${id}/file${viewingTenantId ? `?tenantId=${encodeURIComponent(viewingTenantId)}` : ''}`;
}

export const api = {
  login: (email, password, tenantSlug) => request('/auth/login', { method: 'POST', body: { email, password, ...(tenantSlug ? { tenantSlug } : {}) } }),
  register: (body) => request('/auth/register', { method: 'POST', body }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
  changePassword: (currentPassword, newPassword) => request('/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
  publicGeo: () => request('/public/geo'),
  publicInstances: () => request('/public/instances'),

  // Instance (tenant) configuration
  tenantConfig: () => request('/tenant/config'),

  // Platform console — superadmin only
  platformModules: () => request('/platform/modules'),
  tenants: () => request('/tenants'),
  tenant: (id) => request(`/tenants/${id}`),
  createTenant: (body) => request('/tenants', { method: 'POST', body }),
  updateTenant: (id, body) => request(`/tenants/${id}`, { method: 'PATCH', body }),
  setTenantModules: (id, modules) => request(`/tenants/${id}/modules`, { method: 'PUT', body: { modules } }),
  setTenantPositions: (id, positionIds) => request(`/tenants/${id}/positions`, { method: 'PUT', body: { positionIds } }),

  overview: (scopeType, scopeId) => {
    const params = scopeType ? new URLSearchParams({ scopeType, ...(scopeId ? { scopeId } : {}) }) : null;
    return request(`/overview${params ? `?${params.toString()}` : ''}`);
  },

  counties: () => request('/counties'),
  createCounty: (name) => request('/counties', { method: 'POST', body: { name } }),
  updateCounty: (id, name) => request(`/counties/${id}`, { method: 'PATCH', body: { name } }),
  deleteCounty: (id) => request(`/counties/${id}`, { method: 'DELETE' }),

  constituencies: () => request('/constituencies'),
  createConstituency: (name, countyId) => request('/constituencies', { method: 'POST', body: { name, countyId } }),
  updateConstituency: (id, body) => request(`/constituencies/${id}`, { method: 'PATCH', body }),
  deleteConstituency: (id) => request(`/constituencies/${id}`, { method: 'DELETE' }),

  wards: () => request('/wards'),
  createWard: (body) => request('/wards', { method: 'POST', body }),
  updateWard: (id, body) => request(`/wards/${id}`, { method: 'PATCH', body }),
  deleteWard: (id) => request(`/wards/${id}`, { method: 'DELETE' }),
  importWards: (file) => uploadFile('/wards/import', file),
  downloadWardTemplate: () => downloadFile('/wards/import-template', 'wards-template.csv'),
  importRegister: (file) => uploadFile('/register/import', file),
  downloadRegisterTemplate: () => downloadFile('/register/import-template', 'register-template.csv'),

  stations: () => request('/stations'),
  createStation: (body) => request('/stations', { method: 'POST', body }),
  updateStation: (id, body) => request(`/stations/${id}`, { method: 'PATCH', body }),
  deleteStation: (id) => request(`/stations/${id}`, { method: 'DELETE' }),

  streams: () => request('/streams'),
  streamDetail: (id) => request(`/streams/${id}`),
  createStream: (stationId, body) => request(`/stations/${stationId}/streams`, { method: 'POST', body }),
  deleteStream: (id) => request(`/streams/${id}`, { method: 'DELETE' }),
  addStreamAgent: (id, agentId) => request(`/streams/${id}/agents`, { method: 'POST', body: { agentId } }),
  removeStreamAgent: (id, agentId) => request(`/streams/${id}/agents/${agentId}`, { method: 'DELETE' }),

  logEvent: (streamId, body) => request(`/streams/${streamId}/events`, { method: 'POST', body }),
  logBallotBox: (streamId, body) => request(`/streams/${streamId}/ballot-boxes`, { method: 'POST', body }),
  confirmBallotBoxEmpty: (streamId, boxId) => request(`/streams/${streamId}/ballot-boxes/${boxId}/confirm`, { method: 'PATCH' }),
  sealBallotBox: (streamId, boxId, body) => request(`/streams/${streamId}/ballot-boxes/${boxId}/seal`, { method: 'PATCH', body }),
  closeSealBallotBox: (streamId, boxId, sealSerial) => request(`/streams/${streamId}/ballot-boxes/${boxId}/close-seal`, { method: 'PATCH', body: { sealSerial } }),
  confirmSealMatch: (streamId, boxId, sealsMatch, note) => request(`/streams/${streamId}/ballot-boxes/${boxId}/seal-match`, { method: 'PATCH', body: { sealsMatch, note } }),
  resealBallotBox: (streamId, boxId, sealSerial) => request(`/streams/${streamId}/ballot-boxes/${boxId}/reseal`, { method: 'PATCH', body: { sealSerial } }),
  logBooklet: (streamId, body) => request(`/streams/${streamId}/booklets`, { method: 'POST', body }),
  logTurnout: (streamId, votersProcessed) => request(`/streams/${streamId}/turnout`, { method: 'POST', body: { votersProcessed } }),

  // Full IEBC-style ballot accounting: every ballot taken from the box is
  // exactly one of valid (for a candidate), rejected, disputed, spoilt, or
  // stray. totalCast and remainingBallots feed the server-side
  // reconciliation checks, which return `anomalies` rather than blocking —
  // see the results form's handling of that field.
  submitResult: (streamId, { positionId, candidateVotes, rejectedVotes, disputedVotes, spoiltVotes, strayVotes, totalCast, remainingBallots, validVotes, formReference, photo }) => {
    const formData = new FormData();
    formData.append('positionId', positionId);
    formData.append('candidateVotes', JSON.stringify(candidateVotes));
    formData.append('rejectedVotes', String(rejectedVotes));
    formData.append('disputedVotes', String(disputedVotes || 0));
    formData.append('spoiltVotes', String(spoiltVotes || 0));
    formData.append('strayVotes', String(strayVotes || 0));
    formData.append('totalCast', String(totalCast));
    formData.append('remainingBallots', String(remainingBallots));
    formData.append('validVotes', String(validVotes));
    if (formReference) formData.append('formReference', formReference);
    if (photo) formData.append('photo', photo);
    return requestForm(`/streams/${streamId}/results`, formData);
  },
  resultsAggregate: (positionId, level, scopeId) => {
    const params = new URLSearchParams({ positionId, ...(level ? { level } : {}), ...(scopeId ? { scopeId } : {}) });
    return request(`/results/aggregate?${params.toString()}`);
  },

  positions: () => request('/positions'),
  addCandidate: (positionId, name, party) => request(`/positions/${positionId}/candidates`, { method: 'POST', body: { name, party } }),
  deleteCandidate: (id) => request(`/candidates/${id}`, { method: 'DELETE' }),

  agents: () => request('/agents'),
  setAgentStatus: (id, status) => request(`/agents/${id}`, { method: 'PATCH', body: { status } }),

  incidents: () => request('/incidents'),
  createIncident: ({ streamId, wardId, stationCode, wardName, note, severity, urgent, files }) => {
    const formData = new FormData();
    if (streamId) formData.append('streamId', streamId);
    if (wardId) formData.append('wardId', wardId);
    formData.append('stationCode', stationCode || '');
    formData.append('wardName', wardName || '');
    formData.append('note', note);
    formData.append('severity', severity || 'low');
    formData.append('urgent', urgent ? 'true' : 'false');
    (files || []).forEach((f) => formData.append('files', f));
    return requestForm('/incidents', formData);
  },
  resolveIncident: (id, resolutionNote) => request(`/incidents/${id}/resolve`, { method: 'PATCH', body: { resolutionNote } }),
  escalateIncident: (id, escalatedToType, urgent) => request(`/incidents/${id}/escalate`, { method: 'POST', body: { escalatedToType, urgent } }),

  activity: () => request('/activity'),

  users: () => request('/users'),
  approveUser: (id, body) => request(`/users/${id}/approve`, { method: 'POST', body }),
  declineUser: (id) => request(`/users/${id}/decline`, { method: 'POST' }),
  setUserJurisdiction: (id, jurisdictionType, jurisdictionId) => request(`/users/${id}/assignment`, { method: 'PATCH', body: { jurisdictionType, jurisdictionId } }),

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
  const socket = new WebSocket(viewingTenantId ? `${wsUrl}?tenantId=${encodeURIComponent(viewingTenantId)}` : wsUrl);
  socket.onmessage = (event) => {
    try { onMessage(JSON.parse(event.data)); } catch { /* ignore malformed frames */ }
  };
  return socket;
}
