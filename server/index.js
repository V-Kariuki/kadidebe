import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import { parse as parseCsv } from 'csv-parse/sync';
import { mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { db, runMigrations } from './db.js';
import {
  JWT_SECRET, TOKEN_COOKIE, setAuthCookies, clearAuthCookies,
  requireAuth, requireCsrf, requireRole
} from './auth.js';
import { audit } from './audit.js';
import { inScope, canApprove, canReassign, wardIdsInScope, wardIdsForJurisdiction, jurisdictionContains, resolveWardChain, LEVEL } from './jurisdiction.js';
import {
  validate, loginSchema, registerSchema, approveUserSchema, changePasswordSchema, agentStatusSchema,
  incidentCreateSchema, incidentResolveSchema, incidentEscalateSchema,
  countyCreateSchema, countyUpdateSchema, constituencyCreateSchema, constituencyUpdateSchema,
  wardCreateSchema, wardUpdateSchema, stationCreateSchema, stationUpdateSchema,
  streamCreateSchema, streamAgentSchema, processEventSchema, ballotBoxSchema,
  ballotBoxSealSchema, ballotBoxClosingSealSchema, ballotBoxSealMatchSchema, ballotBoxResealSchema,
  ballotBookletSchema, turnoutUpdateSchema, resultSubmitSchema
} from './validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.join(__dirname, 'uploads');
if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });
const evidenceUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => cb(null, `${nanoid()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_')}`)
  }),
  limits: { fileSize: 15 * 1024 * 1024, files: 5 }
});

runMigrations();

const isProd = process.env.NODE_ENV === 'production';
const CORS_ORIGIN = (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(morgan(isProd ? 'combined' : 'dev'));
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
app.use(requireCsrf);

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) { socket.destroy(); return; }
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`${TOKEN_COOKIE}=([^;]+)`));
  if (!match) { socket.destroy(); return; }
  try {
    jwt.verify(decodeURIComponent(match[1]), JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function broadcast(type, payload) {
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(msg);
  });
}

function pushActivity(text, tone, actorId) {
  const item = { id: nanoid(), text, tone, actor_id: actorId, at: new Date().toISOString() };
  db.prepare('INSERT INTO activity (id, text, tone, actor_id, at) VALUES (@id, @text, @tone, @actor_id, @at)').run(item);
  broadcast('activity', item);
  return item;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' }
});
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many account requests from this device. Try again later.' }
});

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------

app.post('/api/auth/register', registerLimiter, validate(registerSchema), (req, res) => {
  const { name, email, phone, password, roleRequested, jurisdictionType, jurisdictionId } = req.body;
  const normalizedEmail = email.toLowerCase();

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  if (jurisdictionType !== 'national') {
    const table = jurisdictionType === 'ward' ? 'wards' : jurisdictionType === 'constituency' ? 'constituencies' : 'counties';
    const found = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(jurisdictionId);
    if (!found) return res.status(400).json({ error: 'Unknown jurisdiction' });
  }

  const user = {
    id: nanoid(), name, email: normalizedEmail, phone, password_hash: bcrypt.hashSync(password, 12),
    role: roleRequested, jurisdiction_type: jurisdictionType, jurisdiction_id: jurisdictionType === 'national' ? null : jurisdictionId,
    status: 'pending', last_check_in: null
  };
  db.prepare(`
    INSERT INTO users (id, name, email, phone, password_hash, role, jurisdiction_type, jurisdiction_id, status, last_check_in, created_at)
    VALUES (@id, @name, @email, @phone, @password_hash, @role, @jurisdiction_type, @jurisdiction_id, @status, @last_check_in, datetime('now'))
  `).run(user);

  audit({ req, action: 'user.register', entityType: 'user', entityId: user.id, after: { name, email: normalizedEmail, phone, roleRequested, jurisdictionType, jurisdictionId, status: 'pending' } });
  res.status(201).json({ message: 'Account requested. A coordinator or admin for that jurisdiction needs to approve it before you can sign in.' });
});

app.post('/api/auth/login', loginLimiter, validate(loginSchema), (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(423).json({ error: 'Account temporarily locked due to failed attempts. Try again later.' });
  }
  if (user?.status === 'disabled') return res.status(403).json({ error: 'This account has been disabled.' });
  if (user?.status === 'pending') return res.status(403).json({ error: 'Your account is awaiting approval.' });

  const valid = user && bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    if (user) {
      const count = user.failed_login_count + 1;
      const lockedUntil = count >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
      db.prepare('UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?').run(count, lockedUntil, user.id);
    }
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);
  setAuthCookies(res, user);
  req.user = { sub: user.id, email: user.email };
  audit({ req, action: 'login', entityType: 'user', entityId: user.id });

  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, jurisdictionType: user.jurisdiction_type, jurisdictionId: user.jurisdiction_id } });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  audit({ req, action: 'logout', entityType: 'user', entityId: req.user.sub });
  clearAuthCookies(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role, jurisdictionType: req.user.jurisdictionType, jurisdictionId: req.user.jurisdictionId } });
});

app.post('/api/auth/change-password', requireAuth, validate(changePasswordSchema), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user || !bcrypt.compareSync(req.body.currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.newPassword, 12), user.id);
  audit({ req, action: 'user.change_password', entityType: 'user', entityId: user.id });
  res.json({ ok: true });
});

app.get('/api/public/geo', (req, res) => {
  res.json({
    counties: db.prepare('SELECT id, name FROM counties ORDER BY name').all(),
    constituencies: db.prepare('SELECT id, name, county_id as countyId FROM constituencies ORDER BY name').all(),
    wards: db.prepare('SELECT id, name, constituency_id as constituencyId FROM wards ORDER BY name').all()
  });
});

// ---------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------

const EVENT_ORDER = [
  'materials_dispatched', 'materials_arrived', 'agent_arrived', 'boxes_confirmed_empty',
  'polling_opened', 'polling_closed', 'counting_started', 'counting_completed',
  'results_declared', 'materials_departed', 'materials_arrived_tally_centre'
];
const REPORTED_STATUSES = new Set(['counting_completed', 'results_declared', 'materials_departed', 'materials_arrived_tally_centre']);
const PRE_CLOSE_EVENTS = new Set(['materials_dispatched', 'materials_arrived', 'agent_arrived', 'boxes_confirmed_empty', 'polling_opened']);

function deriveStatus(streamId) {
  const rows = db.prepare('SELECT DISTINCT event_type FROM process_events WHERE stream_id = ?').all(streamId);
  let best = -1;
  rows.forEach((r) => { const idx = EVENT_ORDER.indexOf(r.event_type); if (idx > best) best = idx; });
  return best >= 0 ? EVENT_ORDER[best] : 'not_started';
}

function hasEvent(streamId, eventType) {
  return !!db.prepare('SELECT 1 FROM process_events WHERE stream_id = ? AND event_type = ?').get(streamId, eventType);
}

function latestTurnout(streamId) {
  const row = db.prepare('SELECT voters_processed FROM turnout_updates WHERE stream_id = ? ORDER BY reported_at DESC LIMIT 1').get(streamId);
  return row ? row.voters_processed : 0;
}

function resolveRequestedScope(viewer, scopeType, scopeId) {
  if (!scopeType) return { wardIds: wardIdsInScope(viewer) };
  if (!['ward', 'constituency', 'county', 'national'].includes(scopeType)) {
    throw { status: 400, message: 'Invalid scopeType' };
  }
  if (scopeType !== 'national' && !scopeId) throw { status: 400, message: 'scopeId is required unless scopeType is national' };
  if (!inScope(viewer, scopeType, scopeType === 'national' ? null : scopeId)) {
    throw { status: 403, message: 'That scope is outside your jurisdiction' };
  }
  return { wardIds: wardIdsForJurisdiction(scopeType, scopeId) };
}

app.get('/api/overview', requireAuth, (req, res) => {
  let wardIds;
  try {
    ({ wardIds } = resolveRequestedScope(req.user, req.query.scopeType, req.query.scopeId));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message || 'Invalid scope' });
  }

  const wards = wardIds === null ? db.prepare('SELECT * FROM wards').all() : (wardIds.length ? db.prepare(`SELECT * FROM wards WHERE id IN (${wardIds.map(() => '?').join(',')})`).all(...wardIds) : []);
  const wardIdSet = new Set(wards.map((w) => w.id));
  const stations = db.prepare('SELECT * FROM stations').all().filter((s) => wardIds === null || wardIdSet.has(s.ward_id));
  const stationIdSet = new Set(stations.map((s) => s.id));
  const streams = db.prepare('SELECT * FROM streams').all().filter((s) => stationIdSet.has(s.station_id));
  const agents = wardIds === null
    ? db.prepare("SELECT * FROM users WHERE role = 'agent'").all()
    : (wardIds.length ? db.prepare(`SELECT * FROM users WHERE role = 'agent' AND jurisdiction_id IN (${wardIds.map(() => '?').join(',')})`).all(...wardIds) : []);
  const allIncidents = db.prepare('SELECT * FROM incidents').all();
  const incidents = allIncidents.filter((i) => wardIds === null || (i.ward_id && wardIdSet.has(i.ward_id)));

  let reporting = 0;
  let votesCast = 0;
  streams.forEach((s) => {
    const status = deriveStatus(s.id);
    if (REPORTED_STATUSES.has(status)) reporting += 1;
    votesCast += latestTurnout(s.id);
  });

  const registered = wards.reduce((a, w) => a + w.registered_voters, 0);
  const turnout = registered ? Number(((votesCast / registered) * 100).toFixed(1)) : 0;

  let pendingApprovals = 0;
  if (req.user.role === 'admin' || req.user.role === 'coordinator') {
    const pending = db.prepare("SELECT * FROM users WHERE status = 'pending'").all();
    pendingApprovals = pending.filter((u) => req.user.role === 'admin' || inScope(req.user, u.jurisdiction_type, u.jurisdiction_id)).length;
  }

  res.json({
    stationsReporting: reporting,
    stationsTotal: streams.length,
    turnoutPct: turnout,
    registeredVoters: registered,
    votesCast,
    agentsActive: agents.filter((a) => a.status === 'active').length,
    agentsOffline: agents.filter((a) => a.status !== 'active').length,
    openIncidents: incidents.filter((i) => i.status === 'open').length,
    pendingApprovals,
    streamStatuses: streams.map((s) => ({ id: s.id, status: deriveStatus(s.id) })).reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {})
  });
});

// ---------------------------------------------------------------------
// Counties / Constituencies / Wards
// ---------------------------------------------------------------------

app.get('/api/counties', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM counties ORDER BY name').all().map((c) => ({ id: c.id, name: c.name })));
});

app.post('/api/counties', requireAuth, requireRole('admin'), validate(countyCreateSchema), (req, res) => {
  const existing = db.prepare('SELECT id FROM counties WHERE name = ?').get(req.body.name);
  if (existing) return res.status(409).json({ error: 'A county with that name already exists' });
  const county = { id: nanoid(), name: req.body.name };
  db.prepare('INSERT INTO counties (id, name) VALUES (@id, @name)').run(county);
  audit({ req, action: 'county.create', entityType: 'county', entityId: county.id, after: county });
  res.status(201).json(county);
});

app.patch('/api/counties/:id', requireAuth, requireRole('admin'), validate(countyUpdateSchema), (req, res) => {
  const existing = db.prepare('SELECT * FROM counties WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'County not found' });
  const nameTaken = db.prepare('SELECT id FROM counties WHERE name = ? AND id != ?').get(req.body.name, existing.id);
  if (nameTaken) return res.status(409).json({ error: 'A county with that name already exists' });
  db.prepare('UPDATE counties SET name = ? WHERE id = ?').run(req.body.name, existing.id);
  const dto = { id: existing.id, name: req.body.name };
  audit({ req, action: 'county.update', entityType: 'county', entityId: existing.id, before: { name: existing.name }, after: dto });
  res.json(dto);
});

app.delete('/api/counties/:id', requireAuth, requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM counties WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'County not found' });
  const count = db.prepare('SELECT COUNT(*) as n FROM constituencies WHERE county_id = ?').get(existing.id).n;
  if (count > 0) return res.status(409).json({ error: `Reassign or delete ${count} constituency(ies) in this county first` });
  db.prepare('DELETE FROM counties WHERE id = ?').run(existing.id);
  audit({ req, action: 'county.delete', entityType: 'county', entityId: existing.id, before: { name: existing.name } });
  res.status(204).end();
});

function toConstituencyDTO(c, countyName) {
  return { id: c.id, name: c.name, countyId: c.county_id, countyName: countyName || null };
}

app.get('/api/constituencies', requireAuth, (req, res) => {
  const counties = Object.fromEntries(db.prepare('SELECT id, name FROM counties').all().map((c) => [c.id, c.name]));
  res.json(db.prepare('SELECT * FROM constituencies ORDER BY name').all().map((c) => toConstituencyDTO(c, counties[c.county_id])));
});

app.post('/api/constituencies', requireAuth, requireRole('admin'), validate(constituencyCreateSchema), (req, res) => {
  const existing = db.prepare('SELECT id FROM constituencies WHERE name = ?').get(req.body.name);
  if (existing) return res.status(409).json({ error: 'A constituency with that name already exists' });
  if (req.body.countyId) {
    const county = db.prepare('SELECT id FROM counties WHERE id = ?').get(req.body.countyId);
    if (!county) return res.status(400).json({ error: 'Unknown county' });
  }
  const constituency = { id: nanoid(), name: req.body.name, county_id: req.body.countyId || null };
  db.prepare('INSERT INTO constituencies (id, name, county_id) VALUES (@id, @name, @county_id)').run(constituency);
  const dto = toConstituencyDTO(constituency, null);
  audit({ req, action: 'constituency.create', entityType: 'constituency', entityId: constituency.id, after: dto });
  res.status(201).json(dto);
});

app.patch('/api/constituencies/:id', requireAuth, requireRole('admin'), validate(constituencyUpdateSchema), (req, res) => {
  const existing = db.prepare('SELECT * FROM constituencies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Constituency not found' });
  const { name, countyId } = req.body;
  if (name && name !== existing.name) {
    const nameTaken = db.prepare('SELECT id FROM constituencies WHERE name = ? AND id != ?').get(name, existing.id);
    if (nameTaken) return res.status(409).json({ error: 'A constituency with that name already exists' });
  }
  if (countyId) {
    const county = db.prepare('SELECT id FROM counties WHERE id = ?').get(countyId);
    if (!county) return res.status(400).json({ error: 'Unknown county' });
  }
  const nextName = name !== undefined ? name : existing.name;
  const nextCountyId = countyId !== undefined ? countyId : existing.county_id;
  db.prepare('UPDATE constituencies SET name = ?, county_id = ? WHERE id = ?').run(nextName, nextCountyId, existing.id);
  const dto = toConstituencyDTO({ id: existing.id, name: nextName, county_id: nextCountyId }, null);
  audit({ req, action: 'constituency.update', entityType: 'constituency', entityId: existing.id, before: { name: existing.name, countyId: existing.county_id }, after: { name: nextName, countyId: nextCountyId } });
  res.json(dto);
});

app.delete('/api/constituencies/:id', requireAuth, requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM constituencies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Constituency not found' });
  const wardCount = db.prepare('SELECT COUNT(*) as n FROM wards WHERE constituency_id = ?').get(existing.id).n;
  if (wardCount > 0) return res.status(409).json({ error: `Reassign or delete ${wardCount} ward(s) in this constituency first` });
  db.prepare('DELETE FROM constituencies WHERE id = ?').run(existing.id);
  audit({ req, action: 'constituency.delete', entityType: 'constituency', entityId: existing.id, before: { name: existing.name } });
  res.status(204).end();
});

app.post('/api/wards', requireAuth, requireRole('admin'), validate(wardCreateSchema), (req, res) => {
  const { name, registeredVoters, constituencyId } = req.body;
  const existing = db.prepare('SELECT id FROM wards WHERE name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'A ward with that name already exists' });
  if (constituencyId) {
    const constituency = db.prepare('SELECT id FROM constituencies WHERE id = ?').get(constituencyId);
    if (!constituency) return res.status(400).json({ error: 'Unknown constituency' });
  }
  const ward = { id: nanoid(), name, registered_voters: registeredVoters, constituency_id: constituencyId || null };
  db.prepare('INSERT INTO wards (id, name, registered_voters, constituency_id) VALUES (@id, @name, @registered_voters, @constituency_id)').run(ward);
  const dto = { id: ward.id, name: ward.name, registeredVoters: ward.registered_voters, constituencyId: ward.constituency_id };
  audit({ req, action: 'ward.create', entityType: 'ward', entityId: ward.id, after: dto });
  res.status(201).json(dto);
});

function toWardDTO(w, constituencyName) {
  return { id: w.id, name: w.name, registeredVoters: w.registered_voters, constituencyId: w.constituency_id, constituencyName: constituencyName || null };
}

app.get('/api/wards', requireAuth, (req, res) => {
  const constituencies = Object.fromEntries(db.prepare('SELECT id, name FROM constituencies').all().map((c) => [c.id, c.name]));
  res.json(db.prepare('SELECT * FROM wards ORDER BY name').all().map((w) => toWardDTO(w, constituencies[w.constituency_id])));
});

app.patch('/api/wards/:id', requireAuth, requireRole('admin'), validate(wardUpdateSchema), (req, res) => {
  const existing = db.prepare('SELECT * FROM wards WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ward not found' });
  const { name, registeredVoters, constituencyId } = req.body;
  if (name && name !== existing.name) {
    const nameTaken = db.prepare('SELECT id FROM wards WHERE name = ? AND id != ?').get(name, existing.id);
    if (nameTaken) return res.status(409).json({ error: 'A ward with that name already exists' });
  }
  if (constituencyId) {
    const constituency = db.prepare('SELECT id FROM constituencies WHERE id = ?').get(constituencyId);
    if (!constituency) return res.status(400).json({ error: 'Unknown constituency' });
  }
  const nextName = name !== undefined ? name : existing.name;
  const nextRegistered = registeredVoters !== undefined ? registeredVoters : existing.registered_voters;
  const nextConstituencyId = constituencyId !== undefined ? constituencyId : existing.constituency_id;
  db.prepare('UPDATE wards SET name = ?, registered_voters = ?, constituency_id = ? WHERE id = ?').run(nextName, nextRegistered, nextConstituencyId, existing.id);
  const constituency = nextConstituencyId ? db.prepare('SELECT name FROM constituencies WHERE id = ?').get(nextConstituencyId) : null;
  const dto = toWardDTO({ id: existing.id, name: nextName, registered_voters: nextRegistered, constituency_id: nextConstituencyId }, constituency?.name);
  audit({ req, action: 'ward.update', entityType: 'ward', entityId: existing.id, before: { name: existing.name, registeredVoters: existing.registered_voters, constituencyId: existing.constituency_id }, after: { name: nextName, registeredVoters: nextRegistered, constituencyId: nextConstituencyId } });
  res.json(dto);
});

app.delete('/api/wards/:id', requireAuth, requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM wards WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ward not found' });
  const stationCount = db.prepare('SELECT COUNT(*) as n FROM stations WHERE ward_id = ?').get(existing.id).n;
  const userCount = db.prepare("SELECT COUNT(*) as n FROM users WHERE jurisdiction_type = 'ward' AND jurisdiction_id = ?").get(existing.id).n;
  if (stationCount > 0 || userCount > 0) {
    const parts = [];
    if (stationCount > 0) parts.push(`${stationCount} station(s)`);
    if (userCount > 0) parts.push(`${userCount} assigned user(s)`);
    return res.status(409).json({ error: `Reassign or remove ${parts.join(' and ')} in this ward first` });
  }
  db.prepare('DELETE FROM wards WHERE id = ?').run(existing.id);
  audit({ req, action: 'ward.delete', entityType: 'ward', entityId: existing.id, before: { name: existing.name } });
  res.status(204).end();
});

app.get('/api/wards/import-template', requireAuth, requireRole('admin'), (req, res) => {
  const csv = 'constituency,ward,registeredVoters\nTharaka,Chuka,5400\nTharaka,Magutuni,4200\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="wards-template.csv"');
  res.send(csv);
});

app.post('/api/wards/import', requireAuth, requireRole('admin'), csvUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let rows;
  try {
    rows = parseCsv(req.file.buffer.toString('utf-8'), {
      columns: (header) => header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '')),
      skip_empty_lines: true, trim: true
    });
  } catch (err) {
    return res.status(400).json({ error: `Could not read that file as CSV: ${err.message}` });
  }
  if (rows.length === 0) return res.status(400).json({ error: 'The file has no data rows' });
  if (rows.length > 2000) return res.status(400).json({ error: 'That file has too many rows (max 2000 per import)' });

  const summary = { constituenciesCreated: 0, wardsCreated: 0, wardsUpdated: 0, skipped: [] };
  const runImport = db.transaction(() => {
    rows.forEach((row, i) => {
      const lineNumber = i + 2;
      const wardName = (row.ward || row.wardname || '').trim();
      if (!wardName) { summary.skipped.push({ row: lineNumber, reason: 'Missing ward name' }); return; }

      const registeredRaw = row.registeredvoters ?? row.registered ?? '';
      let registeredVoters = null;
      if (String(registeredRaw).trim() !== '') {
        const n = Number(registeredRaw);
        if (!Number.isFinite(n) || n < 0) { summary.skipped.push({ row: lineNumber, reason: `Invalid registeredVoters "${registeredRaw}"` }); return; }
        registeredVoters = Math.round(n);
      }

      const constituencyName = (row.constituency || row.constituencyname || '').trim();
      let constituencyId = null;
      if (constituencyName) {
        const found = db.prepare('SELECT id FROM constituencies WHERE name = ?').get(constituencyName);
        if (found) { constituencyId = found.id; }
        else {
          constituencyId = nanoid();
          db.prepare('INSERT INTO constituencies (id, name) VALUES (?, ?)').run(constituencyId, constituencyName);
          summary.constituenciesCreated += 1;
        }
      }

      const existingWard = db.prepare('SELECT * FROM wards WHERE name = ?').get(wardName);
      if (existingWard) {
        db.prepare('UPDATE wards SET registered_voters = ?, constituency_id = ? WHERE id = ?').run(
          registeredVoters !== null ? registeredVoters : existingWard.registered_voters,
          constituencyName ? constituencyId : existingWard.constituency_id,
          existingWard.id
        );
        summary.wardsUpdated += 1;
      } else {
        db.prepare('INSERT INTO wards (id, name, registered_voters, constituency_id) VALUES (?, ?, ?, ?)')
          .run(nanoid(), wardName, registeredVoters || 0, constituencyId);
        summary.wardsCreated += 1;
      }
    });
  });

  try { runImport(); } catch (err) { return res.status(400).json({ error: `Import failed: ${err.message}` }); }
  audit({ req, action: 'ward.import', entityType: 'ward', entityId: 'bulk', after: summary });
  res.json(summary);
});

// ---------------------------------------------------------------------
// Positions & candidates
// ---------------------------------------------------------------------

app.get('/api/positions', requireAuth, (req, res) => {
  const positions = db.prepare('SELECT * FROM positions').all();
  const candidates = db.prepare('SELECT * FROM candidates').all();
  res.json(positions.map((p) => ({
    id: p.id, name: p.name, scope: p.scope,
    candidates: candidates.filter((c) => c.position_id === p.id).map((c) => ({ id: c.id, name: c.name, party: c.party }))
  })));
});

app.post('/api/positions/:id/candidates', requireAuth, requireRole('admin'), (req, res) => {
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Candidate name is required' });
  const candidate = { id: nanoid(), position_id: position.id, name, party: (req.body?.party || '').trim() || null };
  db.prepare('INSERT INTO candidates (id, position_id, name, party) VALUES (@id, @position_id, @name, @party)').run(candidate);
  audit({ req, action: 'candidate.create', entityType: 'candidate', entityId: candidate.id, after: candidate });
  res.status(201).json({ id: candidate.id, name: candidate.name, party: candidate.party });
});

app.delete('/api/candidates/:id', requireAuth, requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM candidates WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Candidate not found' });
  db.prepare('DELETE FROM candidates WHERE id = ?').run(existing.id);
  audit({ req, action: 'candidate.delete', entityType: 'candidate', entityId: existing.id, before: existing });
  res.status(204).end();
});

// ---------------------------------------------------------------------
// Stations & Streams
// ---------------------------------------------------------------------

function toStationDTO(s, wardName) {
  return { id: s.id, code: s.code, name: s.name, wardId: s.ward_id, wardName, registered: s.registered, gpsLat: s.gps_lat, gpsLng: s.gps_lng };
}

app.get('/api/stations', requireAuth, (req, res) => {
  const scopeWardIds = wardIdsInScope(req.user);
  const wards = Object.fromEntries(db.prepare('SELECT id, name FROM wards').all().map((w) => [w.id, w.name]));
  let rows = db.prepare('SELECT * FROM stations').all();

  if (req.user.role === 'agent') {
    const myWardIds = db.prepare(`
      SELECT DISTINCT st.ward_id as wardId FROM stream_agents sa
      JOIN streams s ON s.id = sa.stream_id JOIN stations st ON st.id = s.station_id
      WHERE sa.agent_id = ?
    `).all(req.user.sub).map((r) => r.wardId);
    rows = rows.filter((s) => myWardIds.includes(s.ward_id));
  } else if (scopeWardIds !== null) {
    rows = rows.filter((s) => scopeWardIds.includes(s.ward_id));
  }
  res.json(rows.map((s) => toStationDTO(s, wards[s.ward_id])));
});

app.post('/api/stations', requireAuth, requireRole('admin'), validate(stationCreateSchema), (req, res) => {
  const { code, name, wardId, registered, gpsLat, gpsLng } = req.body;
  const ward = db.prepare('SELECT * FROM wards WHERE id = ?').get(wardId);
  if (!ward) return res.status(400).json({ error: 'Unknown ward' });
  const existing = db.prepare('SELECT id FROM stations WHERE code = ?').get(code);
  if (existing) return res.status(409).json({ error: 'A station with that code already exists' });

  const station = { id: nanoid(), code, name: name || null, ward_id: wardId, registered, gps_lat: gpsLat ?? null, gps_lng: gpsLng ?? null };
  db.prepare('INSERT INTO stations (id, code, name, ward_id, registered, gps_lat, gps_lng) VALUES (@id, @code, @name, @ward_id, @registered, @gps_lat, @gps_lng)').run(station);

  const dto = toStationDTO(station, ward.name);
  audit({ req, action: 'station.create', entityType: 'station', entityId: station.id, after: dto });
  res.status(201).json(dto);
});

app.patch('/api/stations/:id', requireAuth, requireRole('admin'), validate(stationUpdateSchema), (req, res) => {
  const existing = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Station not found' });
  const { code, name, wardId, registered, gpsLat, gpsLng } = req.body;
  if (code && code !== existing.code) {
    const codeTaken = db.prepare('SELECT id FROM stations WHERE code = ? AND id != ?').get(code, existing.id);
    if (codeTaken) return res.status(409).json({ error: 'A station with that code already exists' });
  }
  if (wardId) {
    const ward = db.prepare('SELECT id FROM wards WHERE id = ?').get(wardId);
    if (!ward) return res.status(400).json({ error: 'Unknown ward' });
  }
  const next = {
    code: code !== undefined ? code : existing.code,
    name: name !== undefined ? name : existing.name,
    ward_id: wardId !== undefined ? wardId : existing.ward_id,
    registered: registered !== undefined ? registered : existing.registered,
    gps_lat: gpsLat !== undefined ? gpsLat : existing.gps_lat,
    gps_lng: gpsLng !== undefined ? gpsLng : existing.gps_lng
  };
  db.prepare('UPDATE stations SET code = ?, name = ?, ward_id = ?, registered = ?, gps_lat = ?, gps_lng = ? WHERE id = ?')
    .run(next.code, next.name, next.ward_id, next.registered, next.gps_lat, next.gps_lng, existing.id);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(next.ward_id);
  const dto = toStationDTO({ id: existing.id, ...next }, ward?.name);
  audit({ req, action: 'station.edit', entityType: 'station', entityId: existing.id, before: { code: existing.code, wardId: existing.ward_id }, after: { code: next.code, wardId: next.ward_id } });
  res.json(dto);
});

app.delete('/api/stations/:id', requireAuth, requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Station not found' });
  const streamIds = db.prepare('SELECT id FROM streams WHERE station_id = ?').all(existing.id).map((r) => r.id);
  const runDelete = db.transaction(() => {
    streamIds.forEach((sid) => {
      db.prepare('DELETE FROM results WHERE stream_id = ?').run(sid);
      db.prepare('DELETE FROM ballot_boxes WHERE stream_id = ?').run(sid);
      db.prepare('DELETE FROM ballot_booklets WHERE stream_id = ?').run(sid);
      db.prepare('DELETE FROM process_events WHERE stream_id = ?').run(sid);
      db.prepare('DELETE FROM turnout_updates WHERE stream_id = ?').run(sid);
      db.prepare('DELETE FROM stream_agents WHERE stream_id = ?').run(sid);
    });
    db.prepare('DELETE FROM streams WHERE station_id = ?').run(existing.id);
    db.prepare('DELETE FROM stations WHERE id = ?').run(existing.id);
  });
  runDelete();
  audit({ req, action: 'station.delete', entityType: 'station', entityId: existing.id, before: { code: existing.code, wardId: existing.ward_id } });
  broadcast('station_delete', { id: existing.id });
  res.status(204).end();
});

function agentsForStream(streamId) {
  return db.prepare(`
    SELECT u.id, u.name FROM stream_agents sa JOIN users u ON u.id = sa.agent_id WHERE sa.stream_id = ?
  `).all(streamId);
}

function agentAssignedToStream(streamId, agentId) {
  return !!db.prepare('SELECT 1 FROM stream_agents WHERE stream_id = ? AND agent_id = ?').get(streamId, agentId);
}

function toStreamDTO(stream, station, wardName) {
  return {
    id: stream.id, label: stream.label, registered: stream.registered,
    stationId: stream.station_id, stationCode: station?.code, stationName: station?.name,
    wardId: station?.ward_id, wardName,
    agents: agentsForStream(stream.id),
    status: deriveStatus(stream.id),
    votersProcessed: latestTurnout(stream.id)
  };
}

function streamWithContext(streamId) {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId);
  if (!stream) return null;
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stream.station_id);
  const ward = station ? db.prepare('SELECT name FROM wards WHERE id = ?').get(station.ward_id) : null;
  return { stream, station, ward };
}

function canViewStream(user, stream, station) {
  if (user.role === 'admin' || user.role === 'coordinator' || user.role === 'aspirant') return inScope(user, 'ward', station.ward_id);
  if (user.role === 'agent') return agentAssignedToStream(stream.id, user.sub);
  return false;
}

function canEditStream(user, stream, station) {
  if (user.role === 'admin' || user.role === 'coordinator') return inScope(user, 'ward', station.ward_id);
  if (user.role === 'agent') return agentAssignedToStream(stream.id, user.sub);
  return false;
}

app.get('/api/streams', requireAuth, (req, res) => {
  const scopeWardIds = wardIdsInScope(req.user);
  let rows = db.prepare('SELECT * FROM streams').all();
  const stations = Object.fromEntries(db.prepare('SELECT * FROM stations').all().map((s) => [s.id, s]));
  const wards = Object.fromEntries(db.prepare('SELECT id, name FROM wards').all().map((w) => [w.id, w.name]));

  if (req.user.role === 'agent') {
    const myStreamIds = new Set(db.prepare('SELECT stream_id FROM stream_agents WHERE agent_id = ?').all(req.user.sub).map((r) => r.stream_id));
    rows = rows.filter((s) => myStreamIds.has(s.id));
  } else if (scopeWardIds !== null) {
    rows = rows.filter((s) => scopeWardIds.includes(stations[s.station_id]?.ward_id));
  }

  res.json(rows.map((s) => {
    const station = stations[s.station_id];
    return toStreamDTO(s, station, wards[station?.ward_id]);
  }));
});

function toBallotBoxDTO(b) {
  return {
    id: b.id, positionId: b.position_id, boxSerial: b.box_serial,
    confirmedEmptyAt: b.confirmed_empty_at,
    iebcSealSerial: b.iebc_seal_serial, agentSealSerials: JSON.parse(b.agent_seal_serials || '[]'), sealedAt: b.sealed_at,
    closingSealSerial: b.closing_seal_serial, closingSealedAt: b.closing_sealed_at,
    sealsMatchAtTally: b.seals_match_at_tally === null ? null : !!b.seals_match_at_tally, sealMatchNote: b.seal_match_note, sealMatchConfirmedAt: b.seal_match_confirmed_at,
    resealSerial: b.reseal_serial, resealedAt: b.resealed_at
  };
}

app.get('/api/streams/:id', requireAuth, (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canViewStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });

  const events = db.prepare('SELECT * FROM process_events WHERE stream_id = ? ORDER BY at ASC').all(ctx.stream.id);
  const boxes = db.prepare('SELECT * FROM ballot_boxes WHERE stream_id = ?').all(ctx.stream.id).map(toBallotBoxDTO);
  const booklets = db.prepare('SELECT * FROM ballot_booklets WHERE stream_id = ?').all(ctx.stream.id)
    .map((b) => ({ id: b.id, positionId: b.position_id, serialStart: b.serial_start, serialEnd: b.serial_end, quantity: b.quantity, openedAt: b.opened_at }));
  const results = db.prepare('SELECT * FROM results WHERE stream_id = ?').all(ctx.stream.id)
    .map((r) => ({
      id: r.id, positionId: r.position_id, candidateVotes: JSON.parse(r.candidate_votes || '{}'),
      rejectedVotes: r.rejected_votes, disputedVotes: r.disputed_votes, spoiltVotes: r.spoilt_votes, strayVotes: r.stray_votes,
      totalCast: r.total_cast, remainingBallots: r.remaining_ballots, validVotes: r.valid_votes,
      formReference: r.form_reference, submittedAt: r.submitted_at
    }));
  const turnout = db.prepare('SELECT * FROM turnout_updates WHERE stream_id = ? ORDER BY reported_at DESC').all(ctx.stream.id)
    .map((t) => ({ id: t.id, votersProcessed: t.voters_processed, reportedAt: t.reported_at }));
  const attachments = (entityIds) => db.prepare(`SELECT * FROM attachments WHERE entity_type = 'result' AND entity_id IN (${entityIds.map(() => '?').join(',') || "''"})`).all(...entityIds);

  res.json({
    ...toStreamDTO(ctx.stream, ctx.station, ctx.ward?.name),
    canEdit: canEditStream(req.user, ctx.stream, ctx.station),
    events: events.map((e) => ({ id: e.id, eventType: e.event_type, at: e.at, note: e.note, gpsLat: e.gps_lat, gpsLng: e.gps_lng, actorId: e.actor_id })),
    ballotBoxes: boxes,
    ballotBooklets: booklets,
    results,
    resultAttachments: results.length ? attachments(results.map((r) => r.id)).map((a) => ({ id: a.id, entityId: a.entity_id, fileType: a.file_type })) : [],
    turnoutHistory: turnout
  });
});

app.post('/api/stations/:id/streams', requireAuth, requireRole('admin'), validate(streamCreateSchema), (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station not found' });
  const dup = db.prepare('SELECT id FROM streams WHERE station_id = ? AND label = ?').get(station.id, req.body.label);
  if (dup) return res.status(409).json({ error: 'A stream with that label already exists at this station' });

  const stream = { id: nanoid(), station_id: station.id, label: req.body.label, registered: req.body.registered };
  db.prepare('INSERT INTO streams (id, station_id, label, registered) VALUES (@id, @station_id, @label, @registered)').run(stream);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(station.ward_id);
  const dto = toStreamDTO(stream, station, ward?.name);
  audit({ req, action: 'stream.create', entityType: 'stream', entityId: stream.id, after: dto });
  broadcast('stream_update', dto);
  res.status(201).json(dto);
});

app.delete('/api/streams/:id', requireAuth, requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Stream not found' });
  const runDelete = db.transaction(() => {
    db.prepare('DELETE FROM results WHERE stream_id = ?').run(existing.id);
    db.prepare('DELETE FROM ballot_boxes WHERE stream_id = ?').run(existing.id);
    db.prepare('DELETE FROM ballot_booklets WHERE stream_id = ?').run(existing.id);
    db.prepare('DELETE FROM process_events WHERE stream_id = ?').run(existing.id);
    db.prepare('DELETE FROM turnout_updates WHERE stream_id = ?').run(existing.id);
    db.prepare('DELETE FROM stream_agents WHERE stream_id = ?').run(existing.id);
    db.prepare('DELETE FROM streams WHERE id = ?').run(existing.id);
  });
  runDelete();
  audit({ req, action: 'stream.delete', entityType: 'stream', entityId: existing.id, before: { label: existing.label } });
  broadcast('stream_delete', { id: existing.id });
  res.status(204).end();
});

app.post('/api/streams/:id/agents', requireAuth, requireRole('coordinator', 'admin'), validate(streamAgentSchema), (req, res) => {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stream.station_id);
  if (!inScope(req.user, 'ward', station.ward_id)) return res.status(403).json({ error: 'This stream is outside your jurisdiction' });

  const agent = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent' AND status != 'pending'").get(req.body.agentId);
  if (!agent) return res.status(400).json({ error: 'Unknown agent' });
  if (agent.jurisdiction_type !== 'ward' || agent.jurisdiction_id !== station.ward_id) {
    return res.status(400).json({ error: "The agent's home ward must match the station's ward" });
  }

  db.prepare('INSERT OR IGNORE INTO stream_agents (stream_id, agent_id) VALUES (?, ?)').run(stream.id, agent.id);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(station.ward_id);
  const dto = toStreamDTO(stream, station, ward?.name);

  audit({ req, action: 'stream.agent_add', entityType: 'stream', entityId: stream.id, after: { agentId: agent.id } });
  broadcast('stream_update', dto);
  res.status(201).json(dto);
});

app.delete('/api/streams/:id/agents/:agentId', requireAuth, requireRole('coordinator', 'admin'), (req, res) => {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stream.station_id);
  if (!inScope(req.user, 'ward', station.ward_id)) return res.status(403).json({ error: 'This stream is outside your jurisdiction' });

  db.prepare('DELETE FROM stream_agents WHERE stream_id = ? AND agent_id = ?').run(stream.id, req.params.agentId);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(station.ward_id);
  const dto = toStreamDTO(stream, station, ward?.name);

  audit({ req, action: 'stream.agent_remove', entityType: 'stream', entityId: stream.id, after: { agentId: req.params.agentId } });
  broadcast('stream_update', dto);
  res.json(dto);
});

// ---------------------------------------------------------------------
// Process events
// ---------------------------------------------------------------------

const EVENT_LABEL = {
  materials_dispatched: 'Materials dispatched', materials_arrived: 'Materials arrived at station',
  agent_arrived: 'Agent arrived on site', boxes_confirmed_empty: 'Ballot boxes confirmed empty',
  polling_opened: 'Polling declared open', polling_closed: 'Polling declared closed',
  counting_started: 'Counting started', counting_completed: 'Counting completed',
  results_declared: 'Results declared', materials_departed: 'Materials departed station',
  materials_arrived_tally_centre: 'Materials arrived at tallying centre'
};

app.post('/api/streams/:id/events', requireAuth, validate(processEventSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });

  const eventType = req.body.eventType;
  if (hasEvent(ctx.stream.id, eventType)) return res.status(409).json({ error: `${EVENT_LABEL[eventType]} has already been logged for this stream` });
  if (PRE_CLOSE_EVENTS.has(eventType) && hasEvent(ctx.stream.id, 'polling_closed')) {
    return res.status(409).json({ error: 'Voting is closed — pre-close activities can no longer be logged or edited' });
  }

  const event = {
    id: nanoid(), stream_id: ctx.stream.id, event_type: eventType, actor_id: req.user.sub,
    gps_lat: req.body.gpsLat ?? null, gps_lng: req.body.gpsLng ?? null, note: req.body.note || null,
    at: new Date().toISOString()
  };
  db.prepare('INSERT INTO process_events (id, stream_id, event_type, actor_id, gps_lat, gps_lng, note, at) VALUES (@id, @stream_id, @event_type, @actor_id, @gps_lat, @gps_lng, @note, @at)').run(event);

  const dto = toStreamDTO(ctx.stream, ctx.station, ctx.ward?.name);
  audit({ req, action: 'stream.event', entityType: 'stream', entityId: ctx.stream.id, after: { eventType: event.event_type } });
  broadcast('stream_update', dto);
  pushActivity(`${ctx.ward?.name || 'Station'} — ${ctx.station.code} ${ctx.stream.label}: ${EVENT_LABEL[eventType] || eventType}`, 'info', req.user.sub);

  res.status(201).json({ event: { id: event.id, eventType, at: event.at }, stream: dto });
});

// ---------------------------------------------------------------------
// Ballot box & booklet custody
// ---------------------------------------------------------------------

app.post('/api/streams/:id/ballot-boxes', requireAuth, validate(ballotBoxSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (hasEvent(ctx.stream.id, 'polling_closed')) return res.status(409).json({ error: 'Voting is closed — ballot box records can no longer be edited' });

  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.body.positionId);
  if (!position) return res.status(400).json({ error: 'Unknown position' });

  const existing = db.prepare('SELECT * FROM ballot_boxes WHERE stream_id = ? AND position_id = ?').get(ctx.stream.id, position.id);
  const record = { id: existing?.id || nanoid(), stream_id: ctx.stream.id, position_id: position.id, box_serial: req.body.boxSerial };
  if (existing) {
    db.prepare('UPDATE ballot_boxes SET box_serial = ? WHERE id = ?').run(record.box_serial, existing.id);
  } else {
    db.prepare('INSERT INTO ballot_boxes (id, stream_id, position_id, box_serial) VALUES (@id, @stream_id, @position_id, @box_serial)').run(record);
  }

  audit({ req, action: 'ballot_box.log', entityType: 'ballot_box', entityId: record.id, after: { positionId: position.id, boxSerial: record.box_serial } });
  const saved = db.prepare('SELECT * FROM ballot_boxes WHERE id = ?').get(record.id);
  res.status(existing ? 200 : 201).json(toBallotBoxDTO(saved));
});

// Once every logged box for the stream is both confirmed empty AND sealed,
// the stream's timeline advances to boxes_confirmed_empty automatically —
// that milestone now represents the complete "ready to vote" state, not
// just the confirm-empty step in isolation.
function maybeAdvanceAfterSealing(ctx) {
  const allBoxes = db.prepare('SELECT * FROM ballot_boxes WHERE stream_id = ?').all(ctx.stream.id);
  const allReady = allBoxes.length > 0 && allBoxes.every((b) => b.confirmed_empty_at && b.sealed_at);
  if (allReady && !hasEvent(ctx.stream.id, 'boxes_confirmed_empty')) {
    db.prepare('INSERT INTO process_events (id, stream_id, event_type, actor_id, at) VALUES (?, ?, ?, ?, ?)')
      .run(nanoid(), ctx.stream.id, 'boxes_confirmed_empty', ctx.actorId, new Date().toISOString());
    broadcast('stream_update', toStreamDTO(ctx.stream, ctx.station, ctx.ward?.name));
  }
}

app.patch('/api/streams/:id/ballot-boxes/:boxId/confirm', requireAuth, (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (hasEvent(ctx.stream.id, 'polling_closed')) return res.status(409).json({ error: 'Voting is closed — ballot box records can no longer be edited' });

  const box = db.prepare('SELECT * FROM ballot_boxes WHERE id = ? AND stream_id = ?').get(req.params.boxId, ctx.stream.id);
  if (!box) return res.status(404).json({ error: 'Ballot box record not found' });

  const now = new Date().toISOString();
  db.prepare('UPDATE ballot_boxes SET confirmed_empty_at = ?, confirmed_by = ? WHERE id = ?').run(now, req.user.sub, box.id);

  audit({ req, action: 'ballot_box.confirm', entityType: 'ballot_box', entityId: box.id, after: { confirmedEmptyAt: now } });
  maybeAdvanceAfterSealing({ ...ctx, actorId: req.user.sub });
  res.json(toBallotBoxDTO(db.prepare('SELECT * FROM ballot_boxes WHERE id = ?').get(box.id)));
});

// Sealing: an IEBC seal is mandatory; any number of additional agent/party
// seals may be added alongside it. Requires the box to already be
// confirmed empty — you can't seal a box you haven't verified is empty.
app.patch('/api/streams/:id/ballot-boxes/:boxId/seal', requireAuth, validate(ballotBoxSealSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (hasEvent(ctx.stream.id, 'polling_closed')) return res.status(409).json({ error: 'Voting is closed — ballot box records can no longer be edited' });

  const box = db.prepare('SELECT * FROM ballot_boxes WHERE id = ? AND stream_id = ?').get(req.params.boxId, ctx.stream.id);
  if (!box) return res.status(404).json({ error: 'Ballot box record not found' });
  if (!box.confirmed_empty_at) return res.status(409).json({ error: 'Confirm the box is empty before sealing it' });

  const now = new Date().toISOString();
  db.prepare('UPDATE ballot_boxes SET iebc_seal_serial = ?, agent_seal_serials = ?, sealed_at = ?, sealed_by = ? WHERE id = ?')
    .run(req.body.iebcSealSerial, JSON.stringify(req.body.agentSealSerials), now, req.user.sub, box.id);

  audit({ req, action: 'ballot_box.seal', entityType: 'ballot_box', entityId: box.id, after: { iebcSealSerial: req.body.iebcSealSerial, agentSealSerials: req.body.agentSealSerials } });
  maybeAdvanceAfterSealing({ ...ctx, actorId: req.user.sub });
  res.json(toBallotBoxDTO(db.prepare('SELECT * FROM ballot_boxes WHERE id = ?').get(box.id)));
});

// The closing seal over the ballot slot itself, applied at close of voting.
// Requires the box to already have its initial seal in place.
app.patch('/api/streams/:id/ballot-boxes/:boxId/close-seal', requireAuth, validate(ballotBoxClosingSealSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });

  const box = db.prepare('SELECT * FROM ballot_boxes WHERE id = ? AND stream_id = ?').get(req.params.boxId, ctx.stream.id);
  if (!box) return res.status(404).json({ error: 'Ballot box record not found' });
  if (!box.sealed_at) return res.status(409).json({ error: 'Seal the box before applying the closing seal' });

  const now = new Date().toISOString();
  db.prepare('UPDATE ballot_boxes SET closing_seal_serial = ?, closing_sealed_at = ?, closing_sealed_by = ? WHERE id = ?')
    .run(req.body.sealSerial, now, req.user.sub, box.id);

  audit({ req, action: 'ballot_box.close_seal', entityType: 'ballot_box', entityId: box.id, after: { closingSealSerial: req.body.sealSerial } });
  res.json(toBallotBoxDTO(db.prepare('SELECT * FROM ballot_boxes WHERE id = ?').get(box.id)));
});

// At the start of tallying: confirm whether the seals cut are the same
// ones applied when the box was sealed and closed. A "no" here is exactly
// the kind of discrepancy that should prompt an incident report — the
// frontend surfaces that prompt, this endpoint just records the answer.
app.patch('/api/streams/:id/ballot-boxes/:boxId/seal-match', requireAuth, validate(ballotBoxSealMatchSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });

  const box = db.prepare('SELECT * FROM ballot_boxes WHERE id = ? AND stream_id = ?').get(req.params.boxId, ctx.stream.id);
  if (!box) return res.status(404).json({ error: 'Ballot box record not found' });
  if (!box.closing_seal_serial) return res.status(409).json({ error: 'The box must have its closing seal recorded first' });

  const now = new Date().toISOString();
  db.prepare('UPDATE ballot_boxes SET seals_match_at_tally = ?, seal_match_note = ?, seal_match_confirmed_at = ?, seal_match_confirmed_by = ? WHERE id = ?')
    .run(req.body.sealsMatch ? 1 : 0, req.body.note || null, now, req.user.sub, box.id);

  audit({ req, action: 'ballot_box.seal_match', entityType: 'ballot_box', entityId: box.id, after: { sealsMatch: req.body.sealsMatch, note: req.body.note } });
  if (!req.body.sealsMatch) pushActivity(`Seal mismatch reported at ${ctx.ward?.name} — ${ctx.station.code} ${ctx.stream.label}`, 'alert', req.user.sub);
  res.json(toBallotBoxDTO(db.prepare('SELECT * FROM ballot_boxes WHERE id = ?').get(box.id)));
});

// After counting concludes, the box is re-sealed with a new seal.
app.patch('/api/streams/:id/ballot-boxes/:boxId/reseal', requireAuth, validate(ballotBoxResealSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });

  const box = db.prepare('SELECT * FROM ballot_boxes WHERE id = ? AND stream_id = ?').get(req.params.boxId, ctx.stream.id);
  if (!box) return res.status(404).json({ error: 'Ballot box record not found' });
  if (!box.seal_match_confirmed_at) return res.status(409).json({ error: 'Confirm the seal match at the start of tallying before re-sealing' });

  const now = new Date().toISOString();
  db.prepare('UPDATE ballot_boxes SET reseal_serial = ?, resealed_at = ?, resealed_by = ? WHERE id = ?')
    .run(req.body.sealSerial, now, req.user.sub, box.id);

  audit({ req, action: 'ballot_box.reseal', entityType: 'ballot_box', entityId: box.id, after: { resealSerial: req.body.sealSerial } });
  res.json(toBallotBoxDTO(db.prepare('SELECT * FROM ballot_boxes WHERE id = ?').get(box.id)));
});

app.post('/api/streams/:id/booklets', requireAuth, validate(ballotBookletSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (!hasEvent(ctx.stream.id, 'polling_opened')) return res.status(409).json({ error: 'Booklets can only be logged after polling has been declared open' });
  if (hasEvent(ctx.stream.id, 'polling_closed')) return res.status(409).json({ error: 'Voting is closed — booklet records can no longer be edited' });

  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.body.positionId);
  if (!position) return res.status(400).json({ error: 'Unknown position' });

  const booklet = {
    id: nanoid(), stream_id: ctx.stream.id, position_id: position.id, serial_start: req.body.serialStart, serial_end: req.body.serialEnd,
    quantity: req.body.quantity || 0, opened_by: req.user.sub, opened_at: new Date().toISOString()
  };
  db.prepare('INSERT INTO ballot_booklets (id, stream_id, position_id, serial_start, serial_end, quantity, opened_by, opened_at) VALUES (@id, @stream_id, @position_id, @serial_start, @serial_end, @quantity, @opened_by, @opened_at)').run(booklet);

  audit({ req, action: 'booklet.log', entityType: 'ballot_booklet', entityId: booklet.id, after: { positionId: position.id, serialStart: booklet.serial_start, serialEnd: booklet.serial_end, quantity: booklet.quantity } });
  res.status(201).json({ id: booklet.id, positionId: position.id, serialStart: booklet.serial_start, serialEnd: booklet.serial_end, quantity: booklet.quantity, openedAt: booklet.opened_at });
});

// ---------------------------------------------------------------------
// Turnout snapshots
// ---------------------------------------------------------------------

app.post('/api/streams/:id/turnout', requireAuth, validate(turnoutUpdateSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (!hasEvent(ctx.stream.id, 'polling_opened')) return res.status(409).json({ error: 'Turnout can only be logged while polling is open' });
  if (hasEvent(ctx.stream.id, 'polling_closed')) return res.status(409).json({ error: 'Polling has closed — turnout is no longer being tracked live' });
  if (req.body.votersProcessed > ctx.stream.registered) {
    return res.status(400).json({ error: `Cannot exceed ${ctx.stream.registered} registered voters for this stream` });
  }

  const snap = { id: nanoid(), stream_id: ctx.stream.id, voters_processed: req.body.votersProcessed, reported_by: req.user.sub, reported_at: new Date().toISOString() };
  db.prepare('INSERT INTO turnout_updates (id, stream_id, voters_processed, reported_by, reported_at) VALUES (@id, @stream_id, @voters_processed, @reported_by, @reported_at)').run(snap);

  const dto = toStreamDTO(ctx.stream, ctx.station, ctx.ward?.name);
  audit({ req, action: 'turnout.update', entityType: 'stream', entityId: ctx.stream.id, after: { votersProcessed: snap.voters_processed } });
  broadcast('stream_update', dto);
  res.status(201).json({ id: snap.id, votersProcessed: snap.voters_processed, reportedAt: snap.reported_at, stream: dto });
});

// ---------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------

app.post('/api/streams/:id/results', requireAuth, evidenceUpload.single('photo'), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (!hasEvent(ctx.stream.id, 'counting_started')) return res.status(409).json({ error: 'Results can only be submitted once tallying has been logged as started' });
  if (!req.file) return res.status(400).json({ error: 'A photo of the signed results form is required' });

  let candidateVotes;
  try {
    candidateVotes = JSON.parse(req.body.candidateVotes || '{}');
  } catch {
    return res.status(400).json({ error: 'candidateVotes must be valid JSON' });
  }

  const parsed = resultSubmitSchema.safeParse({ ...req.body, candidateVotes });
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const { positionId, rejectedVotes, disputedVotes, spoiltVotes, strayVotes, totalCast, remainingBallots, validVotes, formReference } = parsed.data;

  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId);
  if (!position) return res.status(400).json({ error: 'Unknown position' });

  if (totalCast > ctx.stream.registered) {
    return res.status(400).json({ error: `Total ballots cast (${totalCast}) exceed ${ctx.stream.registered} registered voters for this stream` });
  }

  const anomalies = [];
  const candidateSum = Object.values(parsed.data.candidateVotes).reduce((a, v) => a + v, 0);
  const categorySum = candidateSum + rejectedVotes + disputedVotes + spoiltVotes + strayVotes;
  if (categorySum !== totalCast) {
    anomalies.push(`Ballot categories sum to ${categorySum}, but total ballots cast was entered as ${totalCast}.`);
  }
  const issuedForPosition = db.prepare('SELECT COALESCE(SUM(quantity), 0) as total FROM ballot_booklets WHERE stream_id = ? AND position_id = ?').get(ctx.stream.id, positionId).total;
  if (issuedForPosition > 0 && (issuedForPosition - remainingBallots) !== totalCast) {
    anomalies.push(`Ballots issued (${issuedForPosition}) minus ballots remaining (${remainingBallots}) = ${issuedForPosition - remainingBallots}, which does not match total ballots cast (${totalCast}).`);
  }

  const existing = db.prepare('SELECT id FROM results WHERE stream_id = ? AND position_id = ?').get(ctx.stream.id, positionId);
  const record = {
    id: existing?.id || nanoid(), stream_id: ctx.stream.id, position_id: positionId,
    candidate_votes: JSON.stringify(parsed.data.candidateVotes), rejected_votes: rejectedVotes,
    disputed_votes: disputedVotes, spoilt_votes: spoiltVotes, stray_votes: strayVotes,
    total_cast: totalCast, remaining_ballots: remainingBallots, valid_votes: validVotes,
    form_reference: formReference || null, submitted_by: req.user.sub, submitted_at: new Date().toISOString()
  };
  if (existing) {
    db.prepare(`
      UPDATE results SET candidate_votes = ?, rejected_votes = ?, disputed_votes = ?, spoilt_votes = ?, stray_votes = ?,
        total_cast = ?, remaining_ballots = ?, valid_votes = ?, form_reference = ?, submitted_by = ?, submitted_at = ? WHERE id = ?
    `).run(record.candidate_votes, record.rejected_votes, record.disputed_votes, record.spoilt_votes, record.stray_votes,
      record.total_cast, record.remaining_ballots, record.valid_votes, record.form_reference, record.submitted_by, record.submitted_at, existing.id);
  } else {
    db.prepare(`
      INSERT INTO results (id, stream_id, position_id, candidate_votes, rejected_votes, disputed_votes, spoilt_votes, stray_votes,
        total_cast, remaining_ballots, valid_votes, form_reference, submitted_by, submitted_at)
      VALUES (@id, @stream_id, @position_id, @candidate_votes, @rejected_votes, @disputed_votes, @spoilt_votes, @stray_votes,
        @total_cast, @remaining_ballots, @valid_votes, @form_reference, @submitted_by, @submitted_at)
    `).run(record);
  }

  db.prepare('INSERT INTO attachments (id, entity_type, entity_id, file_type, storage_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nanoid(), 'result', record.id, 'image', req.file.filename, req.user.sub);

  const now = new Date().toISOString();
  ['counting_completed', 'results_declared'].forEach((eventType) => {
    if (!hasEvent(ctx.stream.id, eventType)) {
      db.prepare('INSERT INTO process_events (id, stream_id, event_type, actor_id, at) VALUES (?, ?, ?, ?, ?)').run(nanoid(), ctx.stream.id, eventType, req.user.sub, now);
    }
  });

  const dto = toStreamDTO(ctx.stream, ctx.station, ctx.ward?.name);
  audit({ req, action: 'result.submit', entityType: 'result', entityId: record.id, after: { positionId, validVotes, totalCast, anomalies } });
  broadcast('stream_update', dto);
  pushActivity(`${ctx.ward?.name} — ${ctx.station.code} ${ctx.stream.label}: ${position.name} results submitted${anomalies.length ? ' (anomaly flagged)' : ''}`, anomalies.length ? 'alert' : 'ok', req.user.sub);

  res.status(existing ? 200 : 201).json({ id: record.id, positionId, stream: dto, anomalies });
});

app.get('/api/results/aggregate', requireAuth, (req, res) => {
  const { positionId, level, scopeId } = req.query;
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(positionId);
  if (!position) return res.status(400).json({ error: 'Unknown position' });

  let wardIds = null;
  if (level === 'constituency' && scopeId) {
    wardIds = db.prepare('SELECT id FROM wards WHERE constituency_id = ?').all(scopeId).map((w) => w.id);
  } else if (level === 'county' && scopeId) {
    const constituencies = db.prepare('SELECT id FROM constituencies WHERE county_id = ?').all(scopeId).map((c) => c.id);
    wardIds = constituencies.length
      ? db.prepare(`SELECT id FROM wards WHERE constituency_id IN (${constituencies.map(() => '?').join(',')})`).all(...constituencies).map((w) => w.id)
      : [];
  }

  const stations = wardIds ? db.prepare(`SELECT id FROM stations WHERE ward_id IN (${wardIds.map(() => '?').join(',') || "''"})`).all(...wardIds) : db.prepare('SELECT id FROM stations').all();
  const stationIds = stations.map((s) => s.id);
  const streams = stationIds.length ? db.prepare(`SELECT id FROM streams WHERE station_id IN (${stationIds.map(() => '?').join(',')})`).all(...stationIds) : [];
  const streamIds = streams.map((s) => s.id);
  const results = streamIds.length ? db.prepare(`SELECT * FROM results WHERE position_id = ? AND stream_id IN (${streamIds.map(() => '?').join(',')})`).all(positionId, ...streamIds) : [];

  const candidateTotals = {};
  let rejectedTotal = 0;
  let disputedTotal = 0;
  let spoiltTotal = 0;
  let strayTotal = 0;
  let validTotal = 0;
  results.forEach((r) => {
    const votes = JSON.parse(r.candidate_votes || '{}');
    Object.entries(votes).forEach(([name, count]) => { candidateTotals[name] = (candidateTotals[name] || 0) + count; });
    rejectedTotal += r.rejected_votes;
    disputedTotal += r.disputed_votes;
    spoiltTotal += r.spoilt_votes;
    strayTotal += r.stray_votes;
    validTotal += r.valid_votes;
  });

  res.json({
    positionId, level: level || 'national', scopeId: scopeId || null,
    streamsReported: results.length, streamsTotal: streamIds.length,
    candidateVotes: candidateTotals, rejectedVotes: rejectedTotal, disputedVotes: disputedTotal,
    spoiltVotes: spoiltTotal, strayVotes: strayTotal, validVotes: validTotal
  });
});

// ---------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------

function toAgentDTO(u, wardName, streamLabels) {
  return { id: u.id, name: u.name, wardId: u.jurisdiction_id, wardName: wardName || '—', streamLabels: streamLabels || [], phone: u.phone, status: u.status, lastCheckIn: u.last_check_in };
}

app.get('/api/agents', requireAuth, requireRole('coordinator', 'admin', 'aspirant'), (req, res) => {
  const scopeWardIds = wardIdsInScope(req.user);
  const wards = Object.fromEntries(db.prepare('SELECT id, name FROM wards').all().map((w) => [w.id, w.name]));
  let rows = db.prepare("SELECT * FROM users WHERE role = 'agent' ORDER BY name").all();
  if (scopeWardIds !== null) rows = rows.filter((u) => scopeWardIds.includes(u.jurisdiction_id));

  const streamsByAgent = {};
  db.prepare(`
    SELECT sa.agent_id as agentId, s.label, st.code FROM stream_agents sa
    JOIN streams s ON s.id = sa.stream_id JOIN stations st ON st.id = s.station_id
  `).all().forEach((r) => {
    if (!streamsByAgent[r.agentId]) streamsByAgent[r.agentId] = [];
    streamsByAgent[r.agentId].push(`${r.code} — ${r.label}`);
  });

  res.json(rows.map((u) => toAgentDTO(u, wards[u.jurisdiction_id], streamsByAgent[u.id])));
});

app.patch('/api/agents/:id', requireAuth, validate(agentStatusSchema), (req, res) => {
  const isSelf = req.user.sub === req.params.id;
  const isStaff = req.user.role === 'coordinator' || req.user.role === 'admin';
  if (!isSelf && !isStaff) return res.status(403).json({ error: 'You can only update your own status' });

  const agent = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent'").get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (isStaff && !isSelf && !inScope(req.user, 'ward', agent.jurisdiction_id)) return res.status(403).json({ error: 'This agent is outside your jurisdiction' });

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET status = ?, last_check_in = ? WHERE id = ?').run(req.body.status, now, agent.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(agent.id);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(updated.jurisdiction_id);
  const dto = toAgentDTO(updated, ward?.name);

  audit({ req, action: 'agent.status', entityType: 'user', entityId: agent.id, before: { status: agent.status }, after: { status: req.body.status } });
  broadcast('agent_update', dto);
  if (req.body.status === 'active') pushActivity(`Agent ${updated.name} checked in at ${ward?.name} Ward`, 'info', req.user.sub);
  res.json(dto);
});

// ---------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------

function incidentWardId(incident) {
  if (incident.ward_id) return incident.ward_id;
  if (incident.stream_id) {
    const stream = db.prepare('SELECT station_id FROM streams WHERE id = ?').get(incident.stream_id);
    const station = stream ? db.prepare('SELECT ward_id FROM stations WHERE id = ?').get(stream.station_id) : null;
    return station?.ward_id || null;
  }
  return null;
}

function toIncidentDTO(i, attachments) {
  return {
    id: i.id, streamId: i.stream_id, stationCode: i.station_code, wardName: i.ward_name, note: i.note,
    severity: i.severity, urgent: !!i.urgent, status: i.status,
    escalatedToType: i.escalated_to_type, escalatedToId: i.escalated_to_id, escalatedAt: i.escalated_at,
    resolutionNote: i.resolution_note, createdAt: i.created_at, resolvedAt: i.resolved_at,
    attachments: (attachments || []).filter((a) => a.entity_id === i.id).map((a) => ({ id: a.id, fileType: a.file_type }))
  };
}

app.get('/api/incidents', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM incidents ORDER BY urgent DESC, created_at DESC').all();
  const scoped = req.user.role === 'admin' ? rows : rows.filter((i) => {
    const wardId = incidentWardId(i);
    return wardId ? inScope(req.user, 'ward', wardId) : req.user.jurisdictionType === 'national';
  });
  const attachments = db.prepare("SELECT * FROM attachments WHERE entity_type = 'incident'").all();
  res.json(scoped.map((i) => toIncidentDTO(i, attachments)));
});

app.post('/api/incidents', requireAuth, evidenceUpload.array('files', 5), (req, res) => {
  const parsed = incidentCreateSchema.safeParse({
    streamId: req.body.streamId || null, wardId: req.body.wardId || null,
    stationCode: req.body.stationCode, wardName: req.body.wardName,
    note: req.body.note, severity: req.body.severity, urgent: req.body.urgent
  });
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
  const { streamId, wardId, stationCode, wardName, note, severity, urgent } = parsed.data;

  let resolvedWardId = wardId;
  if (!resolvedWardId && streamId) {
    const stream = db.prepare('SELECT station_id FROM streams WHERE id = ?').get(streamId);
    const station = stream ? db.prepare('SELECT ward_id FROM stations WHERE id = ?').get(stream.station_id) : null;
    resolvedWardId = station?.ward_id || null;
  }
  if (!resolvedWardId && req.user.jurisdictionType === 'ward') resolvedWardId = req.user.jurisdictionId;

  const incident = {
    id: nanoid(), stream_id: streamId || null, ward_id: resolvedWardId || null,
    station_code: stationCode || '—', ward_name: wardName || '—',
    note, severity, urgent: urgent ? 1 : 0, status: 'open', created_by: req.user.sub, created_at: new Date().toISOString()
  };
  db.prepare(`
    INSERT INTO incidents (id, stream_id, ward_id, station_code, ward_name, note, severity, urgent, status, created_by, created_at)
    VALUES (@id, @stream_id, @ward_id, @station_code, @ward_name, @note, @severity, @urgent, @status, @created_by, @created_at)
  `).run(incident);

  const fileTypeFor = (mimetype) => mimetype.startsWith('video') ? 'video' : mimetype.startsWith('audio') ? 'audio' : 'image';
  (req.files || []).forEach((file) => {
    db.prepare('INSERT INTO attachments (id, entity_type, entity_id, file_type, storage_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(nanoid(), 'incident', incident.id, fileTypeFor(file.mimetype), file.filename, req.user.sub);
  });

  const dto = toIncidentDTO(incident, (req.files || []).map((f, idx) => ({ id: `pending-${idx}`, entity_id: incident.id, file_type: fileTypeFor(f.mimetype) })));
  audit({ req, action: 'incident.create', entityType: 'incident', entityId: incident.id, after: { note, severity, urgent: !!urgent } });
  broadcast('incident', dto);
  pushActivity(`${urgent ? 'URGENT incident' : 'Incident'} flagged at ${dto.wardName} — ${dto.stationCode}`, 'alert', req.user.sub);
  res.status(201).json(dto);
});

function requireIncidentScope(req, res, incident) {
  const wardId = incidentWardId(incident);
  const ok = req.user.role === 'admin' || (wardId ? inScope(req.user, 'ward', wardId) : req.user.jurisdictionType === 'national');
  if (!ok) res.status(403).json({ error: 'This incident is outside your jurisdiction' });
  return ok;
}

app.patch('/api/incidents/:id/resolve', requireAuth, requireRole('coordinator', 'admin'), validate(incidentResolveSchema), (req, res) => {
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  if (!requireIncidentScope(req, res, incident)) return;
  if (incident.status === 'resolved') return res.status(409).json({ error: 'Already resolved' });

  const now = new Date().toISOString();
  db.prepare('UPDATE incidents SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE id = ?')
    .run('resolved', req.user.sub, now, req.body.resolutionNote, incident.id);
  const updated = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incident.id);
  const dto = toIncidentDTO(updated, db.prepare("SELECT * FROM attachments WHERE entity_type = 'incident' AND entity_id = ?").all(incident.id));

  audit({ req, action: 'incident.resolve', entityType: 'incident', entityId: incident.id, before: { status: incident.status }, after: { status: 'resolved', resolutionNote: req.body.resolutionNote } });
  broadcast('incident', dto);
  res.json(dto);
});

app.post('/api/incidents/:id/escalate', requireAuth, requireRole('coordinator', 'admin'), validate(incidentEscalateSchema), (req, res) => {
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  if (!requireIncidentScope(req, res, incident)) return;

  const now = new Date().toISOString();
  db.prepare('UPDATE incidents SET escalated_to_type = ?, escalated_to_id = ?, escalated_at = ?, urgent = ? WHERE id = ?')
    .run(req.body.escalatedToType, req.body.escalatedToId || null, now, req.body.urgent ? 1 : incident.urgent, incident.id);
  const updated = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incident.id);
  const dto = toIncidentDTO(updated, db.prepare("SELECT * FROM attachments WHERE entity_type = 'incident' AND entity_id = ?").all(incident.id));

  audit({ req, action: 'incident.escalate', entityType: 'incident', entityId: incident.id, after: { escalatedToType: req.body.escalatedToType, escalatedToId: req.body.escalatedToId } });
  broadcast('incident', dto);
  pushActivity(`Incident at ${dto.wardName} — ${dto.stationCode} escalated to ${req.body.escalatedToType} level`, 'alert', req.user.sub);
  res.json(dto);
});

app.get('/api/attachments/:id/file', requireAuth, (req, res) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE id = ?').get(req.params.id);
  if (!attachment) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(uploadDir, attachment.storage_path));
});

app.get('/api/activity', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM activity ORDER BY at DESC LIMIT 50').all());
});

// ---------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------

function jurisdictionLabel(type, id) {
  if (!type || type === 'national') return 'National';
  const table = type === 'ward' ? 'wards' : type === 'constituency' ? 'constituencies' : 'counties';
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id);
  return row ? row.name : '—';
}

app.get('/api/users', requireAuth, requireRole('coordinator', 'admin'), (req, res) => {
  let rows = db.prepare(`
    SELECT id, name, email, phone, role, jurisdiction_type, jurisdiction_id, status, created_at FROM users
    ORDER BY (status = 'pending') DESC, created_at DESC
  `).all();

  if (req.user.role !== 'admin') {
    rows = rows.filter((u) => u.id === req.user.sub || inScope(req.user, u.jurisdiction_type, u.jurisdiction_id));
  }

  res.json(rows.map((u) => ({
    id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
    jurisdictionType: u.jurisdiction_type, jurisdictionId: u.jurisdiction_id,
    jurisdictionLabel: jurisdictionLabel(u.jurisdiction_type, u.jurisdiction_id),
    status: u.status, createdAt: u.created_at
  })));
});

function toUserDTO(u) {
  return {
    id: u.id, name: u.name, email: u.email, phone: u.phone, role: u.role,
    jurisdictionType: u.jurisdiction_type, jurisdictionId: u.jurisdiction_id,
    jurisdictionLabel: jurisdictionLabel(u.jurisdiction_type, u.jurisdiction_id),
    status: u.status, createdAt: u.created_at
  };
}

app.post('/api/users/:id/approve', requireAuth, requireRole('coordinator', 'admin'), validate(approveUserSchema), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.status !== 'pending') return res.status(409).json({ error: 'That account is not pending approval' });

  const { role, jurisdictionType, jurisdictionId } = req.body;
  const resolvedType = role === 'admin' ? 'national' : jurisdictionType;
  const resolvedId = resolvedType === 'national' ? null : jurisdictionId;

  if (!canApprove(req.user, role, resolvedType, resolvedId)) {
    return res.status(403).json({ error: "You don't have jurisdiction to approve this request" });
  }
  if (resolvedType !== 'national') {
    const table = resolvedType === 'ward' ? 'wards' : resolvedType === 'constituency' ? 'constituencies' : 'counties';
    const found = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(resolvedId);
    if (!found) return res.status(400).json({ error: 'Unknown jurisdiction' });
  }

  db.prepare("UPDATE users SET role = ?, jurisdiction_type = ?, jurisdiction_id = ?, status = 'active' WHERE id = ?").run(role, resolvedType, resolvedId, target.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);

  audit({ req, action: 'user.approve', entityType: 'user', entityId: target.id, before: { status: 'pending' }, after: { status: 'active', role, jurisdictionType: resolvedType, jurisdictionId: resolvedId } });
  res.json({ user: toUserDTO(updated) });
});

app.post('/api/users/:id/decline', requireAuth, requireRole('coordinator', 'admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.status !== 'pending') return res.status(409).json({ error: 'That account is not pending approval' });
  if (!canApprove(req.user, target.role, target.jurisdiction_type, target.jurisdiction_id)) {
    return res.status(403).json({ error: "You don't have jurisdiction over this request" });
  }
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  audit({ req, action: 'user.decline', entityType: 'user', entityId: target.id, before: { status: 'pending', email: target.email } });
  res.status(204).end();
});

app.patch('/api/users/:id/assignment', requireAuth, requireRole('coordinator', 'admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (!['coordinator', 'agent', 'aspirant'].includes(target.role)) {
    return res.status(400).json({ error: 'Only coordinators, agents, and aspirants can be reassigned' });
  }
  if (!canReassign(req.user, target)) {
    return res.status(403).json({ error: 'You do not have authority to reassign this user' });
  }

  const jurisdictionType = target.role === 'agent' ? 'ward' : (req.body.jurisdictionType || target.jurisdiction_type);
  const jurisdictionId = req.body.jurisdictionId ?? null;
  if (jurisdictionType !== 'national') {
    const table = jurisdictionType === 'ward' ? 'wards' : jurisdictionType === 'constituency' ? 'constituencies' : 'counties';
    const found = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(jurisdictionId);
    if (!found) return res.status(400).json({ error: 'Unknown jurisdiction' });
  }
  if (!inScope(req.user, jurisdictionType, jurisdictionId)) {
    return res.status(403).json({ error: 'The destination jurisdiction is outside your scope' });
  }

  if (target.role === 'agent' && target.jurisdiction_id !== jurisdictionId) {
    db.prepare('DELETE FROM stream_agents WHERE agent_id = ?').run(target.id);
  }

  db.prepare('UPDATE users SET jurisdiction_type = ?, jurisdiction_id = ? WHERE id = ?').run(jurisdictionType, jurisdictionId, target.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);

  audit({ req, action: 'user.assignment', entityType: 'user', entityId: target.id, before: { jurisdictionType: target.jurisdiction_type, jurisdictionId: target.jurisdiction_id }, after: { jurisdictionType, jurisdictionId } });
  res.json({ user: toUserDTO(updated) });
});

app.get('/api/audit', requireAuth, requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT 200').all());
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError || err?.message?.includes('File too large')) {
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Niko Kadi Twende kwa Debe API + WS listening on http://localhost:${PORT} (${isProd ? 'production' : 'development'})`);
});
