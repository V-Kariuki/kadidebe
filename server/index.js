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

import { db, runMigrations } from './db.js';
import {
  JWT_SECRET, TOKEN_COOKIE, setAuthCookies, clearAuthCookies,
  requireAuth, requireCsrf, requireRole
} from './auth.js';
import { audit } from './audit.js';
import {
  validate, loginSchema, registerSchema, approveUserSchema, stationResultSchema, agentStatusSchema,
  incidentCreateSchema, incidentUpdateSchema, constituencyCreateSchema, constituencyUpdateSchema,
  wardCreateSchema, wardUpdateSchema, stationCreateSchema, stationUpdateSchema,
  stationAssignSchema, userAssignmentSchema
} from './validation.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

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
    jwt.verify(decodeURIComponent(match[1]), JWT_SECRET);
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
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' }
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many account requests from this device. Try again later.' }
});

app.post('/api/auth/register', registerLimiter, validate(registerSchema), (req, res) => {
  const { name, email, password } = req.body;
  const normalizedEmail = email.toLowerCase();

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const user = {
    id: nanoid(),
    name,
    email: normalizedEmail,
    password_hash: bcrypt.hashSync(password, 12),
    role: null,
    ward_id: null,
    phone: null,
    status: 'pending',
    last_check_in: null
  };
  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, ward_id, phone, status, last_check_in, created_at)
    VALUES (@id, @name, @email, @password_hash, @role, @ward_id, @phone, @status, @last_check_in, datetime('now'))
  `).run(user);

  audit({ req, action: 'user.register', entityType: 'user', entityId: user.id, after: { name, email: normalizedEmail, status: 'pending' } });

  res.status(201).json({ message: 'Account requested. An admin needs to approve it and assign a role before you can sign in.' });
});

app.post('/api/auth/login', loginLimiter, validate(loginSchema), (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(423).json({ error: 'Account temporarily locked due to failed attempts. Try again later.' });
  }
  if (user?.status === 'disabled') {
    return res.status(403).json({ error: 'This account has been disabled.' });
  }
  if (user?.status === 'pending') {
    return res.status(403).json({ error: 'Your account is awaiting admin approval.' });
  }

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

  res.json({ user: { id: user.id, name: user.name, email: user.email, role: user.role, wardId: user.ward_id } });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  audit({ req, action: 'logout', entityType: 'user', entityId: req.user.sub });
  clearAuthCookies(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role, wardId: req.user.wardId } });
});

app.get('/api/overview', requireAuth, (req, res) => {
  const stations = db.prepare('SELECT * FROM stations').all();
  const wards = db.prepare('SELECT * FROM wards').all();
  const agents = db.prepare("SELECT * FROM users WHERE role = 'agent'").all();
  const incidents = db.prepare('SELECT * FROM incidents').all();

  const reporting = stations.filter((s) => s.status === 'done' || s.status === 'progress').length;
  const registered = wards.reduce((a, w) => a + w.registered_voters, 0);
  const votesCast = stations.reduce((a, s) => a + s.votes_cast, 0);
  const turnout = registered ? Number(((votesCast / registered) * 100).toFixed(1)) : 0;

  res.json({
    stationsReporting: reporting,
    stationsTotal: stations.length,
    turnoutPct: turnout,
    registeredVoters: registered,
    votesCast,
    agentsActive: agents.filter((a) => a.status === 'active').length,
    agentsOffline: agents.filter((a) => a.status !== 'active').length,
    openIncidents: incidents.filter((i) => i.status === 'open').length
  });
});

app.get('/api/wards', requireAuth, (req, res) => {
  const constituencies = Object.fromEntries(db.prepare('SELECT id, name FROM constituencies').all().map((c) => [c.id, c.name]));
  res.json(db.prepare('SELECT * FROM wards ORDER BY name').all().map((w) => ({
    id: w.id, name: w.name, registeredVoters: w.registered_voters,
    constituencyId: w.constituency_id, constituencyName: constituencies[w.constituency_id] || null
  })));
});

app.get('/api/constituencies', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM constituencies ORDER BY name').all().map((c) => ({ id: c.id, name: c.name })));
});

app.post('/api/constituencies', requireAuth, requireRole('admin'), validate(constituencyCreateSchema), (req, res) => {
  const existing = db.prepare('SELECT id FROM constituencies WHERE name = ?').get(req.body.name);
  if (existing) return res.status(409).json({ error: 'A constituency with that name already exists' });

  const constituency = { id: nanoid(), name: req.body.name };
  db.prepare('INSERT INTO constituencies (id, name) VALUES (@id, @name)').run(constituency);
  audit({ req, action: 'constituency.create', entityType: 'constituency', entityId: constituency.id, after: constituency });
  res.status(201).json(constituency);
});

app.patch('/api/constituencies/:id', requireAuth, requireRole('admin'), validate(constituencyUpdateSchema), (req, res) => {
  const existing = db.prepare('SELECT * FROM constituencies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Constituency not found' });

  const nameTaken = db.prepare('SELECT id FROM constituencies WHERE name = ? AND id != ?').get(req.body.name, existing.id);
  if (nameTaken) return res.status(409).json({ error: 'A constituency with that name already exists' });

  db.prepare('UPDATE constituencies SET name = ? WHERE id = ?').run(req.body.name, existing.id);
  const dto = { id: existing.id, name: req.body.name };
  audit({ req, action: 'constituency.update', entityType: 'constituency', entityId: existing.id, before: { name: existing.name }, after: dto });
  res.json(dto);
});

app.delete('/api/constituencies/:id', requireAuth, requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM constituencies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Constituency not found' });

  const wardCount = db.prepare('SELECT COUNT(*) as n FROM wards WHERE constituency_id = ?').get(existing.id).n;
  if (wardCount > 0) {
    return res.status(409).json({ error: `Reassign or delete ${wardCount} ward(s) in this constituency first` });
  }

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

  db.prepare('UPDATE wards SET name = ?, registered_voters = ?, constituency_id = ? WHERE id = ?')
    .run(nextName, nextRegistered, nextConstituencyId, existing.id);

  const constituency = nextConstituencyId ? db.prepare('SELECT name FROM constituencies WHERE id = ?').get(nextConstituencyId) : null;
  const dto = toWardDTO({ id: existing.id, name: nextName, registered_voters: nextRegistered, constituency_id: nextConstituencyId }, constituency?.name);

  audit({
    req, action: 'ward.update', entityType: 'ward', entityId: existing.id,
    before: { name: existing.name, registeredVoters: existing.registered_voters, constituencyId: existing.constituency_id },
    after: { name: nextName, registeredVoters: nextRegistered, constituencyId: nextConstituencyId }
  });
  res.json(dto);
});

app.delete('/api/wards/:id', requireAuth, requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM wards WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ward not found' });

  const stationCount = db.prepare('SELECT COUNT(*) as n FROM stations WHERE ward_id = ?').get(existing.id).n;
  const userCount = db.prepare('SELECT COUNT(*) as n FROM users WHERE ward_id = ?').get(existing.id).n;
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

app.post('/api/wards/import', requireAuth, requireRole('admin'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let rows;
  try {
    rows = parseCsv(req.file.buffer.toString('utf-8'), {
      columns: (header) => header.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, '')),
      skip_empty_lines: true,
      trim: true
    });
  } catch (err) {
    return res.status(400).json({ error: `Could not read that file as CSV: ${err.message}` });
  }
  if (rows.length === 0) return res.status(400).json({ error: 'The file has no data rows' });
  if (rows.length > 2000) return res.status(400).json({ error: 'That file has too many rows (max 2000 per import)' });

  const summary = { constituenciesCreated: 0, wardsCreated: 0, wardsUpdated: 0, skipped: [] };

  const runImport = db.transaction(() => {
    rows.forEach((row, i) => {
      const lineNumber = i + 2; // header is line 1
      const wardName = (row.ward || row.wardname || '').trim();
      if (!wardName) {
        summary.skipped.push({ row: lineNumber, reason: 'Missing ward name' });
        return;
      }

      const registeredRaw = row.registeredvoters ?? row.registered ?? '';
      let registeredVoters = null;
      if (String(registeredRaw).trim() !== '') {
        const n = Number(registeredRaw);
        if (!Number.isFinite(n) || n < 0) {
          summary.skipped.push({ row: lineNumber, reason: `Invalid registeredVoters "${registeredRaw}"` });
          return;
        }
        registeredVoters = Math.round(n);
      }

      const constituencyName = (row.constituency || row.constituencyname || '').trim();
      let constituencyId = null;
      if (constituencyName) {
        const found = db.prepare('SELECT id FROM constituencies WHERE name = ?').get(constituencyName);
        if (found) {
          constituencyId = found.id;
        } else {
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

  try {
    runImport();
  } catch (err) {
    return res.status(400).json({ error: `Import failed: ${err.message}` });
  }

  audit({ req, action: 'ward.import', entityType: 'ward', entityId: 'bulk', after: summary });
  res.json(summary);
});

function toStationDTO(s, wardName) {
  return {
    id: s.id, code: s.code, wardId: s.ward_id, wardName,
    registered: s.registered, status: s.status, votesCast: s.votes_cast,
    assignedAgentId: s.assigned_agent_id, lastUpdated: s.last_updated
  };
}

app.get('/api/stations', requireAuth, (req, res) => {
  const wards = Object.fromEntries(db.prepare('SELECT id, name FROM wards').all().map((w) => [w.id, w.name]));
  let rows = db.prepare('SELECT * FROM stations').all();

  if (req.user.role === 'agent') {
    rows = rows.filter((s) => s.ward_id === req.user.wardId);
  }
  res.json(rows.map((s) => toStationDTO(s, wards[s.ward_id])));
});

app.post('/api/stations', requireAuth, requireRole('admin'), validate(stationCreateSchema), (req, res) => {
  const { code, wardId, registered } = req.body;
  const ward = db.prepare('SELECT * FROM wards WHERE id = ?').get(wardId);
  if (!ward) return res.status(400).json({ error: 'Unknown ward' });

  const existing = db.prepare('SELECT id FROM stations WHERE code = ?').get(code);
  if (existing) return res.status(409).json({ error: 'A station with that code already exists' });

  const now = new Date().toISOString();
  const station = {
    id: nanoid(), code, ward_id: wardId, registered, status: 'pending',
    votes_cast: 0, assigned_agent_id: null, last_updated: now
  };
  db.prepare(`
    INSERT INTO stations (id, code, ward_id, registered, status, votes_cast, assigned_agent_id, last_updated)
    VALUES (@id, @code, @ward_id, @registered, @status, @votes_cast, @assigned_agent_id, @last_updated)
  `).run(station);

  const dto = toStationDTO(station, ward.name);
  audit({ req, action: 'station.create', entityType: 'station', entityId: station.id, after: dto });
  broadcast('station_update', dto);
  res.status(201).json(dto);
});

app.patch('/api/stations/:id/assign', requireAuth, requireRole('admin'), validate(stationAssignSchema), (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  const { agentId } = req.body;
  let agent = null;
  if (agentId) {
    agent = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent' AND status != 'pending'").get(agentId);
    if (!agent) return res.status(400).json({ error: 'Unknown agent' });
    if (agent.ward_id !== station.ward_id) {
      return res.status(400).json({ error: "The agent must be assigned to the station's ward first" });
    }
  }

  db.prepare('UPDATE stations SET assigned_agent_id = ? WHERE id = ?').run(agentId || null, station.id);
  const updated = db.prepare('SELECT * FROM stations WHERE id = ?').get(station.id);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(updated.ward_id);
  const dto = toStationDTO(updated, ward?.name);

  audit({
    req, action: 'station.assign', entityType: 'station', entityId: station.id,
    before: { assignedAgentId: station.assigned_agent_id }, after: { assignedAgentId: agentId || null }
  });
  broadcast('station_update', dto);
  res.json(dto);
});

app.patch('/api/stations/:id', requireAuth, requireRole('admin'), validate(stationUpdateSchema), (req, res) => {
  const existing = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Station not found' });

  const { code, wardId, registered } = req.body;
  if (code && code !== existing.code) {
    const codeTaken = db.prepare('SELECT id FROM stations WHERE code = ? AND id != ?').get(code, existing.id);
    if (codeTaken) return res.status(409).json({ error: 'A station with that code already exists' });
  }
  if (wardId) {
    const ward = db.prepare('SELECT id FROM wards WHERE id = ?').get(wardId);
    if (!ward) return res.status(400).json({ error: 'Unknown ward' });
  }
  if (registered !== undefined && registered < existing.votes_cast) {
    return res.status(400).json({ error: `Registered voters can't be less than the ${existing.votes_cast} votes already recorded` });
  }

  const nextCode = code !== undefined ? code : existing.code;
  const nextWardId = wardId !== undefined ? wardId : existing.ward_id;
  const nextRegistered = registered !== undefined ? registered : existing.registered;

  // Moving a station to a different ward invalidates its agent assignment —
  // an agent can only hold stations inside their own ward (see /assign).
  const wardChanged = nextWardId !== existing.ward_id;
  const nextAssignedAgentId = wardChanged ? null : existing.assigned_agent_id;

  db.prepare('UPDATE stations SET code = ?, ward_id = ?, registered = ?, assigned_agent_id = ?, last_updated = ? WHERE id = ?')
    .run(nextCode, nextWardId, nextRegistered, nextAssignedAgentId, new Date().toISOString(), existing.id);

  const updated = db.prepare('SELECT * FROM stations WHERE id = ?').get(existing.id);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(updated.ward_id);
  const dto = toStationDTO(updated, ward?.name);

  audit({
    req, action: 'station.edit', entityType: 'station', entityId: existing.id,
    before: { code: existing.code, wardId: existing.ward_id, registered: existing.registered },
    after: { code: nextCode, wardId: nextWardId, registered: nextRegistered }
  });
  broadcast('station_update', dto);
  res.json(dto);
});

app.delete('/api/stations/:id', requireAuth, requireRole('admin'), (req, res) => {
  const existing = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Station not found' });

  const runDelete = db.transaction(() => {
    db.prepare('DELETE FROM station_results WHERE station_id = ?').run(existing.id);
    db.prepare('DELETE FROM stations WHERE id = ?').run(existing.id);
  });
  runDelete();

  audit({ req, action: 'station.delete', entityType: 'station', entityId: existing.id, before: { code: existing.code, wardId: existing.ward_id } });
  broadcast('station_delete', { id: existing.id });
  res.status(204).end();
});

app.post('/api/stations/:id/result', requireAuth, validate(stationResultSchema), (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station not found' });

  const isOwnerAgent = req.user.role === 'agent' && station.assigned_agent_id === req.user.sub;
  const isStaff = req.user.role === 'coordinator' || req.user.role === 'admin';
  if (!isOwnerAgent && !isStaff) {
    return res.status(403).json({ error: 'You are not assigned to this station' });
  }
  if (req.body.votesCast > station.registered) {
    return res.status(400).json({ error: `Votes cast cannot exceed ${station.registered} registered voters` });
  }

  const before = { status: station.status, votesCast: station.votes_cast };
  const now = new Date().toISOString();

  db.prepare('UPDATE stations SET votes_cast = ?, status = ?, last_updated = ?, last_updated_by = ? WHERE id = ?')
    .run(req.body.votesCast, req.body.status, now, req.user.sub, station.id);
  db.prepare('INSERT INTO station_results (id, station_id, submitted_by, votes_cast, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nanoid(), station.id, req.user.sub, req.body.votesCast, req.body.status, now);

  const updated = db.prepare('SELECT * FROM stations WHERE id = ?').get(station.id);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(updated.ward_id);
  const dto = toStationDTO(updated, ward.name);

  audit({ req, action: 'station.result', entityType: 'station', entityId: station.id, before, after: { status: dto.status, votesCast: dto.votesCast } });
  broadcast('station_update', dto);
  pushActivity(`${ward.name} — ${updated.code} results ${updated.status === 'done' ? 'submitted and verified' : 'updated'}`, 'ok', req.user.sub);

  res.json(dto);
});

function toAgentDTO(u) {
  return { id: u.id, name: u.name, wardName: u.ward_id, phone: u.phone, status: u.status, lastCheckIn: u.last_check_in };
}

app.get('/api/agents', requireAuth, requireRole('coordinator', 'admin'), (req, res) => {
  const wards = Object.fromEntries(db.prepare('SELECT id, name FROM wards').all().map((w) => [w.id, w.name]));
  const rows = db.prepare("SELECT * FROM users WHERE role = 'agent' ORDER BY name").all();
  res.json(rows.map((u) => ({ ...toAgentDTO(u), wardName: wards[u.ward_id] || '—' })));
});

app.patch('/api/agents/:id', requireAuth, validate(agentStatusSchema), (req, res) => {
  const isSelf = req.user.sub === req.params.id;
  const isStaff = req.user.role === 'coordinator' || req.user.role === 'admin';
  if (!isSelf && !isStaff) return res.status(403).json({ error: 'You can only update your own status' });

  const agent = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'agent'").get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET status = ?, last_check_in = ? WHERE id = ?').run(req.body.status, now, agent.id);
  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(agent.id);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(updated.ward_id);
  const dto = { ...toAgentDTO(updated), wardName: ward?.name || '—' };

  audit({ req, action: 'agent.status', entityType: 'user', entityId: agent.id, before: { status: agent.status }, after: { status: req.body.status } });
  broadcast('agent_update', dto);
  if (req.body.status === 'active') pushActivity(`Agent ${updated.name} checked in at ${ward?.name} Ward`, 'info', req.user.sub);

  res.json(dto);
});

app.get('/api/incidents', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM incidents ORDER BY created_at DESC').all().map((i) => ({
    id: i.id, stationCode: i.station_code, wardName: i.ward_name, note: i.note,
    severity: i.severity, status: i.status, createdAt: i.created_at
  })));
});

app.post('/api/incidents', requireAuth, validate(incidentCreateSchema), (req, res) => {
  const { stationCode, wardName, note, severity } = req.body;
  const incident = {
    id: nanoid(), station_code: stationCode || '—', ward_name: wardName || '—',
    note, severity, status: 'open', created_by: req.user.sub, created_at: new Date().toISOString()
  };
  db.prepare(`INSERT INTO incidents (id, station_code, ward_name, note, severity, status, created_by, created_at)
              VALUES (@id, @station_code, @ward_name, @note, @severity, @status, @created_by, @created_at)`).run(incident);

  const dto = { id: incident.id, stationCode: incident.station_code, wardName: incident.ward_name, note, severity, status: 'open', createdAt: incident.created_at };
  audit({ req, action: 'incident.create', entityType: 'incident', entityId: incident.id, after: dto });
  broadcast('incident', dto);
  pushActivity(`Incident flagged at ${dto.wardName} — ${dto.stationCode}`, 'alert', req.user.sub);

  res.status(201).json(dto);
});

app.patch('/api/incidents/:id', requireAuth, requireRole('coordinator', 'admin'), validate(incidentUpdateSchema), (req, res) => {
  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });

  const now = new Date().toISOString();
  db.prepare('UPDATE incidents SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
    .run(req.body.status, req.body.status === 'resolved' ? req.user.sub : null, req.body.status === 'resolved' ? now : null, incident.id);

  const updated = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incident.id);
  const dto = { id: updated.id, stationCode: updated.station_code, wardName: updated.ward_name, note: updated.note, severity: updated.severity, status: updated.status, createdAt: updated.created_at };

  audit({ req, action: 'incident.update', entityType: 'incident', entityId: incident.id, before: { status: incident.status }, after: { status: updated.status } });
  broadcast('incident', dto);
  res.json(dto);
});

app.get('/api/activity', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM activity ORDER BY at DESC LIMIT 50').all());
});

app.get('/api/users', requireAuth, requireRole('admin'), (req, res) => {
  const wards = Object.fromEntries(db.prepare('SELECT id, name FROM wards').all().map((w) => [w.id, w.name]));
  res.json(db.prepare(`
    SELECT id, name, email, role, ward_id, status, created_at FROM users
    ORDER BY (status = 'pending') DESC, created_at DESC
  `).all()
    .map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, wardName: wards[u.ward_id] || null, status: u.status, createdAt: u.created_at })));
});

app.post('/api/users/:id/approve', requireAuth, requireRole('admin'), validate(approveUserSchema), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.status !== 'pending') return res.status(409).json({ error: 'That account is not pending approval' });

  const { role, wardId } = req.body;
  let resolvedWardId = null;
  if (role === 'agent') {
    const ward = db.prepare('SELECT id FROM wards WHERE id = ?').get(wardId);
    if (!ward) return res.status(400).json({ error: 'Unknown ward' });
    resolvedWardId = ward.id;
  }

  db.prepare("UPDATE users SET role = ?, ward_id = ?, status = 'active' WHERE id = ?").run(role, resolvedWardId, target.id);

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);
  const ward = updated.ward_id ? db.prepare('SELECT name FROM wards WHERE id = ?').get(updated.ward_id) : null;
  const dto = { id: updated.id, name: updated.name, email: updated.email, role: updated.role, wardName: ward?.name || null, status: updated.status, createdAt: updated.created_at };

  audit({ req, action: 'user.approve', entityType: 'user', entityId: target.id, before: { status: 'pending' }, after: { status: 'active', role, wardId: resolvedWardId } });
  res.json({ user: dto });
});

app.post('/api/users/:id/decline', requireAuth, requireRole('admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.status !== 'pending') return res.status(409).json({ error: 'That account is not pending approval' });

  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  audit({ req, action: 'user.decline', entityType: 'user', entityId: target.id, before: { status: 'pending', email: target.email } });
  res.status(204).end();
});

app.patch('/api/users/:id/assignment', requireAuth, requireRole('admin'), validate(userAssignmentSchema), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.role !== 'coordinator' && target.role !== 'agent') {
    return res.status(400).json({ error: 'Only coordinators and agents can be assigned to a ward' });
  }

  const { wardId } = req.body;
  if (wardId) {
    const ward = db.prepare('SELECT id FROM wards WHERE id = ?').get(wardId);
    if (!ward) return res.status(400).json({ error: 'Unknown ward' });
  }

  db.prepare('UPDATE users SET ward_id = ? WHERE id = ?').run(wardId || null, target.id);

  // Moving an agent out of a ward orphans any station still assigned to
  // them there — clear it rather than leaving a stale cross-ward link.
  if (target.role === 'agent' && target.ward_id !== wardId) {
    db.prepare('UPDATE stations SET assigned_agent_id = NULL WHERE assigned_agent_id = ? AND ward_id != ?')
      .run(target.id, wardId || '');
  }

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(target.id);
  const ward = updated.ward_id ? db.prepare('SELECT name FROM wards WHERE id = ?').get(updated.ward_id) : null;
  const dto = { id: updated.id, name: updated.name, email: updated.email, role: updated.role, wardName: ward?.name || null, status: updated.status, createdAt: updated.created_at };

  audit({ req, action: 'user.assignment', entityType: 'user', entityId: target.id, before: { wardId: target.ward_id }, after: { wardId: wardId || null } });
  res.json({ user: dto });
});

app.get('/api/audit', requireAuth, requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT 200').all());
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Niko Kadi Twende kwa Debe API + WS listening on http://localhost:${PORT} (${isProd ? 'production' : 'development'})`);
});
