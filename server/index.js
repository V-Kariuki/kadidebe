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
  MODULES, modulesForTenant, tenantHasModule, requireModule, positionIdsForTenant, tenantTracksPosition,
  getTenant, resolveTenant, requireTenant, requireSuperadmin, effectiveWardIds, withinTenantCeiling,
  inTenantScope, assignableLevelsForTenant, tenantDTO, jurisdictionLabelFor
} from './tenancy.js';
import {
  validate, loginSchema, registerSchema, approveUserSchema, changePasswordSchema, agentStatusSchema,
  tenantCreateSchema, tenantUpdateSchema, tenantModulesSchema, tenantPositionsSchema,
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

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
// The official national register is ~5.2MB / 46k rows, well past the small
// ward-import limit above, so it gets its own more generous cap.
const registerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
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
  let claims;
  try {
    claims = jwt.verify(decodeURIComponent(match[1]), JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Tag the socket with its tenant at handshake time. Without this every
    // client would receive every tenant's live updates — the single most
    // dangerous leak in a multi-tenant realtime app.
    ws.tenantId = claims.tenantId || null;
    ws.userRole = claims.role || null;
    // A superadmin has no tenant of their own; when they open an instance the
    // client passes it on the socket URL so they receive that instance's feed.
    if (claims.role === 'superadmin') {
      try { ws.tenantId = new URL(req.url, 'http://localhost').searchParams.get('tenantId') || null; } catch { ws.tenantId = null; }
    }
    wss.emit('connection', ws, req);
  });
});

// Every broadcast is addressed to exactly one tenant. Superadmin sockets
// receive nothing by default — the platform console is deliberately not a
// firehose of every client's live traffic.
function broadcast(tenantId, type, payload) {
  if (!tenantId) return;
  const msg = JSON.stringify({ type, payload });
  wss.clients.forEach((client) => {
    if (client.readyState === 1 && client.tenantId === tenantId) client.send(msg);
  });
}

function pushActivity(tenantId, text, tone, actorId) {
  if (!tenantId) return null;
  const item = { id: nanoid(), tenant_id: tenantId, text, tone, actor_id: actorId, at: new Date().toISOString() };
  db.prepare('INSERT INTO activity (id, tenant_id, text, tone, actor_id, at) VALUES (@id, @tenant_id, @text, @tone, @actor_id, @at)').run(item);
  broadcast(tenantId, 'activity', item);
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
  const { name, email, phone, password, roleRequested, jurisdictionType, jurisdictionId, tenantSlug } = req.body;
  const normalizedEmail = email.toLowerCase();

  const tenant = db.prepare("SELECT * FROM tenants WHERE slug = ? AND status = 'active'").get(tenantSlug);
  if (!tenant) return res.status(400).json({ error: 'Unknown or inactive instance' });

  // Email is unique per instance, not globally — the same person can hold
  // an account in two different client instances.
  const existing = db.prepare('SELECT id FROM users WHERE tenant_id = ? AND email = ?').get(tenant.id, normalizedEmail);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists in this instance' });

  // A request can't ask for a jurisdiction the instance itself doesn't cover.
  if (!withinTenantCeiling(tenant, jurisdictionType, jurisdictionType === 'national' ? null : jurisdictionId)) {
    return res.status(400).json({ error: `This instance only covers ${jurisdictionLabelFor(tenant.jurisdiction_type, tenant.jurisdiction_id)}` });
  }

  if (jurisdictionType !== 'national') {
    const table = jurisdictionType === 'ward' ? 'wards' : jurisdictionType === 'constituency' ? 'constituencies' : 'counties';
    const found = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(jurisdictionId);
    if (!found) return res.status(400).json({ error: 'Unknown jurisdiction' });
  }

  const user = {
    id: nanoid(), tenant_id: tenant.id, name, email: normalizedEmail, phone, password_hash: bcrypt.hashSync(password, 12),
    role: roleRequested, jurisdiction_type: jurisdictionType, jurisdiction_id: jurisdictionType === 'national' ? null : jurisdictionId,
    status: 'pending', last_check_in: null
  };
  db.prepare(`
    INSERT INTO users (id, tenant_id, name, email, phone, password_hash, role, jurisdiction_type, jurisdiction_id, status, last_check_in, created_at)
    VALUES (@id, @tenant_id, @name, @email, @phone, @password_hash, @role, @jurisdiction_type, @jurisdiction_id, @status, @last_check_in, datetime('now'))
  `).run(user);

  audit({ req, tenantId: tenant.id, action: 'user.register', entityType: 'user', entityId: user.id, after: { name, email: normalizedEmail, phone, roleRequested, jurisdictionType, jurisdictionId, status: 'pending' } });
  res.status(201).json({ message: 'Account requested. A coordinator or admin for that instance needs to approve it before you can sign in.' });
});

app.post('/api/auth/login', loginLimiter, validate(loginSchema), (req, res) => {
  const { email, password, tenantSlug } = req.body;
  const normalized = email.toLowerCase();

  // Email is only unique within an instance, so resolve the candidate set
  // first. One match logs straight in; several require the caller to name
  // the instance. The response deliberately doesn't reveal WHICH instances
  // hold that email — just how many — to avoid leaking the client list.
  let user;
  if (tenantSlug) {
    user = db.prepare(`
      SELECT u.* FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = ? AND t.slug = ?
    `).get(normalized, tenantSlug);
  } else {
    const matches = db.prepare('SELECT * FROM users WHERE email = ?').all(normalized);
    if (matches.length > 1) {
      return res.status(409).json({ error: 'That email is registered in more than one instance. Please specify which one.', needsTenant: true });
    }
    user = matches[0];
  }

  if (user?.locked_until && new Date(user.locked_until) > new Date()) {
    return res.status(423).json({ error: 'Account temporarily locked due to failed attempts. Try again later.' });
  }
  if (user?.status === 'disabled') return res.status(403).json({ error: 'This account has been disabled.' });
  if (user?.tenant_id) {
    const t = getTenant(user.tenant_id);
    if (!t || t.status !== 'active') return res.status(403).json({ error: 'This instance is suspended. Contact your administrator.' });
  }
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
  audit({ req, tenantId: user.tenant_id || null, action: 'login', entityType: 'user', entityId: user.id });

  const loginTenant = getTenant(user.tenant_id);
  res.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, jurisdictionType: user.jurisdiction_type, jurisdictionId: user.jurisdiction_id, tenantId: user.tenant_id },
    tenant: loginTenant ? tenantDTO(loginTenant) : null,
    modules: loginTenant ? modulesForTenant(loginTenant.id) : null,
    positionIds: loginTenant ? positionIdsForTenant(loginTenant.id) : null
  });
});

app.post('/api/auth/logout', requireAuth, resolveTenant, (req, res) => {
  audit({ req, action: 'logout', entityType: 'user', entityId: req.user.sub });
  clearAuthCookies(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, resolveTenant, (req, res) => {
  // The client needs the instance's module set and jurisdiction ceiling up
  // front so it can hide what's switched off rather than render dead links.
  res.json({
    user: {
      id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role,
      jurisdictionType: req.user.jurisdictionType, jurisdictionId: req.user.jurisdictionId,
      tenantId: req.user.tenantId || null
    },
    tenant: req.tenant ? tenantDTO(req.tenant) : null,
    modules: req.tenant ? modulesForTenant(req.tenant.id) : null,
    positionIds: req.tenant ? positionIdsForTenant(req.tenant.id) : null
  });
});

app.post('/api/auth/change-password', requireAuth, resolveTenant, validate(changePasswordSchema), (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);   // own account; id is already unique
  if (!user || !bcrypt.compareSync(req.body.currentPassword, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.newPassword, 12), user.id);
  audit({ req, action: 'user.change_password', entityType: 'user', entityId: user.id });
  res.json({ ok: true });
});

// Unauthenticated: the signup form needs to know which instances exist and
// what each one covers. Deliberately minimal — name, slug and ceiling only,
// never contact details, user counts, or module configuration.
app.get('/api/public/instances', (req, res) => {
  const rows = db.prepare("SELECT id, name, slug, jurisdiction_type, jurisdiction_id FROM tenants WHERE status = 'active' ORDER BY name").all();
  res.json(rows.map((t) => ({
    slug: t.slug, name: t.name,
    jurisdictionType: t.jurisdiction_type,
    jurisdictionLabel: jurisdictionLabelFor(t.jurisdiction_type, t.jurisdiction_id)
  })));
});

app.get('/api/public/geo', (req, res) => {
  res.json({
    counties: db.prepare('SELECT id, name FROM counties ORDER BY name').all(),
    constituencies: db.prepare('SELECT id, name, county_id as countyId FROM constituencies ORDER BY name').all(),
    wards: db.prepare('SELECT id, name, constituency_id as constituencyId FROM wards ORDER BY name').all()
  });
});

// ---------------------------------------------------------------------
// Platform console — instance (tenant) management
//
// Superadmin-only. This is where instances are provisioned: name, slug,
// jurisdiction ceiling, which modules are switched on, and which elective
// positions the instance tracks. An instance capped at a ward can never
// see or act outside it no matter what roles its own users hold.
// ---------------------------------------------------------------------

app.get('/api/tenants', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
  res.json(rows.map((t) => tenantDTO(t, true)));
});

app.get('/api/tenants/:id', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
  const t = getTenant(req.params.id);
  if (!t) return res.status(404).json({ error: 'Instance not found' });
  res.json(tenantDTO(t, true));
});

app.post('/api/tenants', requireAuth, resolveTenant, requireSuperadmin, validate(tenantCreateSchema), (req, res) => {
  const { name, slug, jurisdictionType, jurisdictionId, contactEmail, notes, modules, positionIds, admin } = req.body;

  if (db.prepare('SELECT id FROM tenants WHERE slug = ?').get(slug)) {
    return res.status(409).json({ error: 'An instance with that slug already exists' });
  }
  if (jurisdictionType !== 'national') {
    const table = jurisdictionType === 'ward' ? 'wards' : jurisdictionType === 'constituency' ? 'constituencies' : 'counties';
    if (!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(jurisdictionId)) {
      return res.status(400).json({ error: 'Unknown jurisdiction for the instance ceiling' });
    }
  }

  const tenantId = nanoid();
  let createdAdmin = null;

  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO tenants (id, name, slug, jurisdiction_type, jurisdiction_id, status, contact_email, notes)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(tenantId, name, slug, jurisdictionType, jurisdictionType === 'national' ? null : jurisdictionId, contactEmail || null, notes || null);

    if (modules && typeof modules === 'object') {
      const ins = db.prepare('INSERT OR REPLACE INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, ?, ?)');
      for (const m of MODULES) {
        if (m.core) continue;
        if (m.key in modules) ins.run(tenantId, m.key, modules[m.key] ? 1 : 0);
      }
    }
    if (Array.isArray(positionIds) && positionIds.length) {
      const ins = db.prepare('INSERT OR IGNORE INTO tenant_positions (tenant_id, position_id) VALUES (?, ?)');
      positionIds.forEach((pid) => ins.run(tenantId, pid));
    }

    // Provision the instance's first admin in the same transaction — an
    // instance with no way to log into it isn't much use.
    if (admin?.email && admin?.password) {
      const adminId = nanoid();
      db.prepare(`
        INSERT INTO users (id, tenant_id, name, email, phone, password_hash, role, jurisdiction_type, jurisdiction_id, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?, 'active', datetime('now'))
      `).run(adminId, tenantId, admin.name || 'Instance Administrator', admin.email.toLowerCase(), admin.phone || null,
             bcrypt.hashSync(admin.password, 12), jurisdictionType, jurisdictionType === 'national' ? null : jurisdictionId);
      createdAdmin = { id: adminId, email: admin.email.toLowerCase() };
    }
  });

  try { run(); } catch (err) { return res.status(400).json({ error: `Could not create instance: ${err.message}` }); }

  const created = getTenant(tenantId);
  audit({ req, tenantId, action: 'tenant.create', entityType: 'tenant', entityId: tenantId, after: { name, slug, jurisdictionType, jurisdictionId } });
  res.status(201).json({ tenant: tenantDTO(created, true), admin: createdAdmin });
});

app.patch('/api/tenants/:id', requireAuth, resolveTenant, requireSuperadmin, validate(tenantUpdateSchema), (req, res) => {
  const existing = getTenant(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Instance not found' });
  const { name, jurisdictionType, jurisdictionId, status, contactEmail, notes } = req.body;

  const nextType = jurisdictionType !== undefined ? jurisdictionType : existing.jurisdiction_type;
  const nextId = jurisdictionType !== undefined
    ? (nextType === 'national' ? null : jurisdictionId)
    : existing.jurisdiction_id;

  if (nextType !== 'national' && nextId) {
    const table = nextType === 'ward' ? 'wards' : nextType === 'constituency' ? 'constituencies' : 'counties';
    if (!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(nextId)) {
      return res.status(400).json({ error: 'Unknown jurisdiction for the instance ceiling' });
    }
  }

  db.prepare(`
    UPDATE tenants SET name = ?, jurisdiction_type = ?, jurisdiction_id = ?, status = ?, contact_email = ?, notes = ? WHERE id = ?
  `).run(
    name !== undefined ? name : existing.name,
    nextType, nextId,
    status !== undefined ? status : existing.status,
    contactEmail !== undefined ? contactEmail : existing.contact_email,
    notes !== undefined ? notes : existing.notes,
    existing.id
  );

  audit({ req, tenantId: existing.id, action: 'tenant.update', entityType: 'tenant', entityId: existing.id,
          before: { name: existing.name, jurisdictionType: existing.jurisdiction_type, status: existing.status },
          after: { name, jurisdictionType: nextType, status } });
  res.json(tenantDTO(getTenant(existing.id), true));
});

app.put('/api/tenants/:id/modules', requireAuth, resolveTenant, requireSuperadmin, validate(tenantModulesSchema), (req, res) => {
  const existing = getTenant(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Instance not found' });
  const ins = db.prepare('INSERT OR REPLACE INTO tenant_modules (tenant_id, module_key, enabled) VALUES (?, ?, ?)');
  const run = db.transaction(() => {
    for (const m of MODULES) {
      if (m.core) continue;   // core modules can't be switched off
      if (m.key in req.body.modules) ins.run(existing.id, m.key, req.body.modules[m.key] ? 1 : 0);
    }
  });
  run();
  audit({ req, tenantId: existing.id, action: 'tenant.modules', entityType: 'tenant', entityId: existing.id, after: req.body.modules });
  res.json({ modules: modulesForTenant(existing.id) });
});

app.put('/api/tenants/:id/positions', requireAuth, resolveTenant, requireSuperadmin, validate(tenantPositionsSchema), (req, res) => {
  const existing = getTenant(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Instance not found' });
  const valid = new Set(db.prepare('SELECT id FROM positions').all().map((p) => p.id));
  const bad = req.body.positionIds.filter((id) => !valid.has(id));
  if (bad.length) return res.status(400).json({ error: `Unknown position(s): ${bad.join(', ')}` });

  const run = db.transaction(() => {
    db.prepare('DELETE FROM tenant_positions WHERE tenant_id = ?').run(existing.id);
    const ins = db.prepare('INSERT INTO tenant_positions (tenant_id, position_id) VALUES (?, ?)');
    req.body.positionIds.forEach((pid) => ins.run(existing.id, pid));
  });
  run();
  audit({ req, tenantId: existing.id, action: 'tenant.positions', entityType: 'tenant', entityId: existing.id, after: req.body.positionIds });
  res.json({ positionIds: positionIdsForTenant(existing.id) });
});

// The module catalogue, so the console can render toggles without
// hardcoding the list client-side.
app.get('/api/platform/modules', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
  res.json(MODULES);
});

// Read-only view of the caller's own instance config, for non-superadmins.
app.get('/api/tenant/config', requireAuth, resolveTenant, requireTenant, (req, res) => {
  res.json({
    tenant: tenantDTO(req.tenant),
    modules: modulesForTenant(req.tenant.id),
    positionIds: positionIdsForTenant(req.tenant.id),
    assignableLevels: assignableLevelsForTenant(req.tenant)
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
// Only voting-linked activity locks when polling closes. Logistics events
// (dispatch, arrival of materials/agent) are facts that can be recorded late.
const PRE_CLOSE_EVENTS = new Set(['boxes_confirmed_empty', 'polling_opened']);
// Milestones that are never logged by hand: they happen as a consequence of
// real work, so a button/form can't be used to skip that work.
//   boxes_confirmed_empty -> every seat's box serial logged, confirmed empty, sealed
//   counting_completed / results_declared -> results actually submitted
const AUTO_ONLY_EVENTS = new Set(['boxes_confirmed_empty', 'counting_completed', 'results_declared']);

function deriveStatus(tenantId, streamId) {
  const rows = db.prepare('SELECT DISTINCT event_type FROM process_events WHERE tenant_id = ? AND stream_id = ?').all(tenantId, streamId);
  let best = -1;
  rows.forEach((r) => { const idx = EVENT_ORDER.indexOf(r.event_type); if (idx > best) best = idx; });
  return best >= 0 ? EVENT_ORDER[best] : 'not_started';
}

function hasEvent(tenantId, streamId, eventType) {
  return !!db.prepare('SELECT 1 FROM process_events WHERE tenant_id = ? AND stream_id = ? AND event_type = ?').get(tenantId, streamId, eventType);
}

function latestTurnout(tenantId, streamId) {
  const row = db.prepare('SELECT voters_processed FROM turnout_updates WHERE tenant_id = ? AND stream_id = ? ORDER BY reported_at DESC LIMIT 1').get(tenantId, streamId);
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

app.get('/api/overview', requireAuth, resolveTenant, requireTenant, (req, res) => {
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
    ? db.prepare("SELECT * FROM users WHERE tenant_id = ? AND role = 'agent'").all(req.tenant.id)
    : (wardIds.length ? db.prepare(`SELECT * FROM users WHERE tenant_id = ? AND role = 'agent' AND jurisdiction_id IN (${wardIds.map(() => '?').join(',')})`).all(req.tenant.id, ...wardIds) : []);
  const allIncidents = db.prepare('SELECT * FROM incidents WHERE tenant_id = ?').all(req.tenant.id);
  const incidents = allIncidents.filter((i) => wardIds === null || (i.ward_id && wardIdSet.has(i.ward_id)));

  let reporting = 0;
  let votesCast = 0;
  streams.forEach((s) => {
    const status = deriveStatus(req.tenant.id, s.id);
    if (REPORTED_STATUSES.has(status)) reporting += 1;
    votesCast += latestTurnout(req.tenant.id, s.id);
  });

  const registered = wards.reduce((a, w) => a + w.registered_voters, 0);
  const turnout = registered ? Number(((votesCast / registered) * 100).toFixed(1)) : 0;

  let pendingApprovals = 0;
  if (req.user.role === 'admin' || req.user.role === 'coordinator') {
    const pending = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND status = 'pending'").all(req.tenant.id);
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
    streamStatuses: streams.map((s) => ({ id: s.id, status: deriveStatus(req.tenant.id, s.id) })).reduce((acc, s) => { acc[s.status] = (acc[s.status] || 0) + 1; return acc; }, {})
  });
});

// ---------------------------------------------------------------------
// Counties / Constituencies / Wards
// ---------------------------------------------------------------------

app.get('/api/counties', requireAuth, resolveTenant, (req, res) => {
  res.json(db.prepare('SELECT * FROM counties ORDER BY name').all().map((c) => ({ id: c.id, name: c.name })));
});

app.post('/api/counties', requireAuth, resolveTenant, requireSuperadmin, validate(countyCreateSchema), (req, res) => {
  const existing = db.prepare('SELECT id FROM counties WHERE name = ?').get(req.body.name);
  if (existing) return res.status(409).json({ error: 'A county with that name already exists' });
  const county = { id: nanoid(), name: req.body.name, code: req.body.code || null };
  db.prepare('INSERT INTO counties (id, name, code) VALUES (@id, @name, @code)').run(county);
  audit({ req, action: 'county.create', entityType: 'county', entityId: county.id, after: county });
  res.status(201).json(county);
});

app.patch('/api/counties/:id', requireAuth, resolveTenant, requireSuperadmin, validate(countyUpdateSchema), (req, res) => {
  const existing = db.prepare('SELECT * FROM counties WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'County not found' });
  const nameTaken = db.prepare('SELECT id FROM counties WHERE name = ? AND id != ?').get(req.body.name, existing.id);
  if (nameTaken) return res.status(409).json({ error: 'A county with that name already exists' });
  const nextCountyName = req.body.name !== undefined ? req.body.name : existing.name;
  const nextCountyCode = req.body.code !== undefined ? (req.body.code || null) : existing.code;
  db.prepare('UPDATE counties SET name = ?, code = ? WHERE id = ?').run(nextCountyName, nextCountyCode, existing.id);
  const dto = { id: existing.id, name: nextCountyName, code: nextCountyCode };
  audit({ req, action: 'county.update', entityType: 'county', entityId: existing.id, before: { name: existing.name }, after: dto });
  res.json(dto);
});

app.delete('/api/counties/:id', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM counties WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'County not found' });
  const count = db.prepare('SELECT COUNT(*) as n FROM constituencies WHERE county_id = ?').get(existing.id).n;
  if (count > 0) return res.status(409).json({ error: `Reassign or delete ${count} constituency(ies) in this county first` });
  db.prepare('DELETE FROM counties WHERE id = ?').run(existing.id);
  audit({ req, action: 'county.delete', entityType: 'county', entityId: existing.id, before: { name: existing.name } });
  res.status(204).end();
});

function toConstituencyDTO(c, countyName) {
  return { id: c.id, name: c.name, code: c.code || null, countyId: c.county_id, countyName: countyName || null };
}

app.get('/api/constituencies', requireAuth, resolveTenant, (req, res) => {
  const counties = Object.fromEntries(db.prepare('SELECT id, name FROM counties').all().map((c) => [c.id, c.name]));
  res.json(db.prepare('SELECT * FROM constituencies ORDER BY name').all().map((c) => toConstituencyDTO(c, counties[c.county_id])));
});

app.post('/api/constituencies', requireAuth, resolveTenant, requireSuperadmin, validate(constituencyCreateSchema), (req, res) => {
  const existing = db.prepare('SELECT id FROM constituencies WHERE name = ?').get(req.body.name);
  if (existing) return res.status(409).json({ error: 'A constituency with that name already exists' });
  if (req.body.countyId) {
    const county = db.prepare('SELECT id FROM counties WHERE id = ?').get(req.body.countyId);
    if (!county) return res.status(400).json({ error: 'Unknown county' });
  }
  const constituency = { id: nanoid(), name: req.body.name, code: req.body.code || null, county_id: req.body.countyId || null };
  db.prepare('INSERT INTO constituencies (id, name, code, county_id) VALUES (@id, @name, @code, @county_id)').run(constituency);
  const dto = toConstituencyDTO(constituency, null);
  audit({ req, action: 'constituency.create', entityType: 'constituency', entityId: constituency.id, after: dto });
  res.status(201).json(dto);
});

app.patch('/api/constituencies/:id', requireAuth, resolveTenant, requireSuperadmin, validate(constituencyUpdateSchema), (req, res) => {
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
  const nextCode = req.body.code !== undefined ? (req.body.code || null) : existing.code;
  db.prepare('UPDATE constituencies SET name = ?, code = ?, county_id = ? WHERE id = ?').run(nextName, nextCode, nextCountyId, existing.id);
  const dto = toConstituencyDTO({ id: existing.id, name: nextName, code: nextCode, county_id: nextCountyId }, null);
  audit({ req, action: 'constituency.update', entityType: 'constituency', entityId: existing.id, before: { name: existing.name, countyId: existing.county_id }, after: { name: nextName, countyId: nextCountyId } });
  res.json(dto);
});

app.delete('/api/constituencies/:id', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM constituencies WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Constituency not found' });
  const wardCount = db.prepare('SELECT COUNT(*) as n FROM wards WHERE constituency_id = ?').get(existing.id).n;
  if (wardCount > 0) return res.status(409).json({ error: `Reassign or delete ${wardCount} ward(s) in this constituency first` });
  db.prepare('DELETE FROM constituencies WHERE id = ?').run(existing.id);
  audit({ req, action: 'constituency.delete', entityType: 'constituency', entityId: existing.id, before: { name: existing.name } });
  res.status(204).end();
});

app.post('/api/wards', requireAuth, resolveTenant, requireSuperadmin, validate(wardCreateSchema), (req, res) => {
  const { name, registeredVoters, constituencyId } = req.body;
  const existing = db.prepare('SELECT id FROM wards WHERE name = ?').get(name);
  if (existing) return res.status(409).json({ error: 'A ward with that name already exists' });
  if (constituencyId) {
    const constituency = db.prepare('SELECT id FROM constituencies WHERE id = ?').get(constituencyId);
    if (!constituency) return res.status(400).json({ error: 'Unknown constituency' });
  }
  const ward = { id: nanoid(), name, code: req.body.code || null, registered_voters: registeredVoters, constituency_id: constituencyId || null };
  db.prepare('INSERT INTO wards (id, name, code, registered_voters, constituency_id) VALUES (@id, @name, @code, @registered_voters, @constituency_id)').run(ward);
  const dto = { id: ward.id, name: ward.name, code: ward.code, registeredVoters: ward.registered_voters, constituencyId: ward.constituency_id };
  audit({ req, action: 'ward.create', entityType: 'ward', entityId: ward.id, after: dto });
  res.status(201).json(dto);
});

function toWardDTO(w, constituencyName) {
  return { id: w.id, name: w.name, code: w.code || null, registeredVoters: w.registered_voters, constituencyId: w.constituency_id, constituencyName: constituencyName || null };
}

app.get('/api/wards', requireAuth, resolveTenant, (req, res) => {
  const constituencies = Object.fromEntries(db.prepare('SELECT id, name FROM constituencies').all().map((c) => [c.id, c.name]));
  res.json(db.prepare('SELECT * FROM wards ORDER BY name').all().map((w) => toWardDTO(w, constituencies[w.constituency_id])));
});

app.patch('/api/wards/:id', requireAuth, resolveTenant, requireSuperadmin, validate(wardUpdateSchema), (req, res) => {
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
  const nextWardCode = req.body.code !== undefined ? (req.body.code || null) : existing.code;
  db.prepare('UPDATE wards SET name = ?, code = ?, registered_voters = ?, constituency_id = ? WHERE id = ?').run(nextName, nextWardCode, nextRegistered, nextConstituencyId, existing.id);
  const constituency = nextConstituencyId ? db.prepare('SELECT name FROM constituencies WHERE id = ?').get(nextConstituencyId) : null;
  const dto = toWardDTO({ id: existing.id, name: nextName, code: nextWardCode, registered_voters: nextRegistered, constituency_id: nextConstituencyId }, constituency?.name);
  audit({ req, action: 'ward.update', entityType: 'ward', entityId: existing.id, before: { name: existing.name, registeredVoters: existing.registered_voters, constituencyId: existing.constituency_id }, after: { name: nextName, registeredVoters: nextRegistered, constituencyId: nextConstituencyId } });
  res.json(dto);
});

app.delete('/api/wards/:id', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM wards WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Ward not found' });
  const stationCount = db.prepare('SELECT COUNT(*) as n FROM stations WHERE ward_id = ?').get(existing.id).n;
  // Wards are shared, so this counts assigned users across every instance.
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

app.get('/api/wards/import-template', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
  const csv = 'constituency,ward,registeredVoters\nTharaka,Chuka,5400\nTharaka,Magutuni,4200\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="wards-template.csv"');
  res.send(csv);
});

app.post('/api/wards/import', requireAuth, resolveTenant, requireSuperadmin, csvUpload.single('file'), (req, res) => {
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
  if (rows.length > 50000) return res.status(400).json({ error: 'That file has too many rows (max 2000 per import)' });

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
// Official register import (IEBC "Registered Voters per Polling Station")
//
// Handles the full 5-level hierarchy in one pass, keyed on GLOBALLY
// UNIQUE codes rather than names — names repeat across the country (nine
// different wards are called "TOWNSHIP"; 1,436 registration centre names
// are reused), so name-based matching would silently merge unrelated
// places. IEBC's own per-level codes also repeat within their parent
// (every ward's first registration centre is "001"), so each level's
// global code is built by concatenating the parent chain, exactly the way
// IEBC builds the 15-digit polling station code:
//   county      = county                                   (3)
//   constituency= county+const                             (6)
//   ward        = county+const+caw                        (10)
//   station     = county+const+caw+regcentre              (13)
//   stream      = the full polling station code            (15)
//
// Idempotent: re-importing the same file updates in place rather than
// duplicating, so a corrected register can be re-run safely.
//
// Note on registered voters: the register gives a figure per polling
// station (stream). Ward totals are summed from their streams rather
// than taken from any single row, since the same ward figure is repeated
// on every row belonging to it.
// ---------------------------------------------------------------------

const REGISTER_EXPECTED_COLUMNS = [
  'countycode', 'countyname', 'constcode', 'constname', 'cawcode', 'cawname',
  'regcentrecode', 'regcentrename', 'pollingstationcode', 'pollingstationname', 'registeredvoters'
];

app.get('/api/register/import-template', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
  const csv = 'county_code,county_name,const_code,const_name,caw_code,caw_name,reg_centre_code,reg_centre_name,polling_station_code,polling_station_name,registered_voters\n'
    + '001,MOMBASA,001,CHANGAMWE,0001,PORT REITZ,001,BOMU PRIMARY SCHOOL,001001000100101,BOMU PRIMARY SCHOOL,673\n';
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="register-template.csv"');
  res.send(csv);
});

app.post('/api/register/import', requireAuth, resolveTenant, requireSuperadmin, registerUpload.single('file'), (req, res) => {
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

  const present = new Set(Object.keys(rows[0] || {}));
  const missing = REGISTER_EXPECTED_COLUMNS.filter((c) => !present.has(c));
  if (missing.length) {
    return res.status(400).json({ error: `Missing required column(s): ${missing.join(', ')}. Download the template for the expected format.` });
  }

  const summary = {
    rowsRead: rows.length,
    countiesCreated: 0, constituenciesCreated: 0, wardsCreated: 0, stationsCreated: 0, streamsCreated: 0,
    countiesUpdated: 0, constituenciesUpdated: 0, wardsUpdated: 0, stationsUpdated: 0, streamsUpdated: 0,
    skipped: []
  };

  // Cache code -> internal id within this import so we do one lookup per
  // distinct entity rather than one per row (46k rows would otherwise mean
  // ~230k redundant SELECTs).
  const cache = { county: new Map(), constituency: new Map(), ward: new Map(), station: new Map() };
  const wardVoterTotals = new Map();

  const selCounty = db.prepare('SELECT id FROM counties WHERE code = ?');
  const insCounty = db.prepare('INSERT INTO counties (id, name, code) VALUES (?, ?, ?)');
  const updCounty = db.prepare('UPDATE counties SET name = ? WHERE id = ?');
  const selConst = db.prepare('SELECT id FROM constituencies WHERE code = ?');
  const insConst = db.prepare('INSERT INTO constituencies (id, name, code, county_id) VALUES (?, ?, ?, ?)');
  const updConst = db.prepare('UPDATE constituencies SET name = ?, county_id = ? WHERE id = ?');
  const selWard = db.prepare('SELECT id FROM wards WHERE code = ?');
  const insWard = db.prepare('INSERT INTO wards (id, name, code, registered_voters, constituency_id) VALUES (?, ?, ?, ?, ?)');
  const updWard = db.prepare('UPDATE wards SET name = ?, constituency_id = ? WHERE id = ?');
  const selStation = db.prepare('SELECT id FROM stations WHERE code = ?');
  const insStation = db.prepare('INSERT INTO stations (id, code, name, ward_id, registered) VALUES (?, ?, ?, ?, ?)');
  const updStation = db.prepare('UPDATE stations SET name = ?, ward_id = ? WHERE id = ?');
  const selStream = db.prepare('SELECT id FROM streams WHERE code = ?');
  const insStream = db.prepare('INSERT INTO streams (id, station_id, code, label, registered) VALUES (?, ?, ?, ?, ?)');
  const updStream = db.prepare('UPDATE streams SET station_id = ?, label = ?, registered = ? WHERE id = ?');

  const runImport = db.transaction(() => {
    rows.forEach((row, i) => {
      const lineNumber = i + 2;
      const countyCode = String(row.countycode || '').trim();
      const countyName = String(row.countyname || '').trim();
      const constCode = String(row.constcode || '').trim();
      const constName = String(row.constname || '').trim();
      const cawCode = String(row.cawcode || '').trim();
      const cawName = String(row.cawname || '').trim();
      const regCentreCode = String(row.regcentrecode || '').trim();
      const regCentreName = String(row.regcentrename || '').trim();
      const pollingStationCode = String(row.pollingstationcode || '').trim();
      const pollingStationName = String(row.pollingstationname || '').trim();
      const votersRaw = String(row.registeredvoters ?? '').trim();

      if (!countyCode || !countyName || !constCode || !constName || !cawCode || !cawName
        || !regCentreCode || !regCentreName || !pollingStationCode || !pollingStationName) {
        summary.skipped.push({ row: lineNumber, reason: 'Missing one or more required code/name fields' });
        return;
      }
      const voters = Number(votersRaw);
      if (!Number.isFinite(voters) || voters < 0) {
        summary.skipped.push({ row: lineNumber, reason: `Invalid registered_voters "${votersRaw}"` });
        return;
      }

      // Globally unique codes, built from the parent chain.
      const gCounty = countyCode;
      const gConst = countyCode + constCode;
      const gWard = countyCode + constCode + cawCode;
      const gStation = countyCode + constCode + cawCode + regCentreCode;
      const gStream = pollingStationCode;

      if (!gStream.startsWith(gStation)) {
        summary.skipped.push({ row: lineNumber, reason: `polling_station_code "${gStream}" does not match its county/const/ward/centre codes (expected prefix "${gStation}")` });
        return;
      }

      let countyId = cache.county.get(gCounty);
      if (!countyId) {
        const found = selCounty.get(gCounty);
        if (found) { countyId = found.id; updCounty.run(countyName, countyId); summary.countiesUpdated += 1; }
        else { countyId = nanoid(); insCounty.run(countyId, countyName, gCounty); summary.countiesCreated += 1; }
        cache.county.set(gCounty, countyId);
      }

      let constId = cache.constituency.get(gConst);
      if (!constId) {
        const found = selConst.get(gConst);
        if (found) { constId = found.id; updConst.run(constName, countyId, constId); summary.constituenciesUpdated += 1; }
        else { constId = nanoid(); insConst.run(constId, constName, gConst, countyId); summary.constituenciesCreated += 1; }
        cache.constituency.set(gConst, constId);
      }

      let wardId = cache.ward.get(gWard);
      if (!wardId) {
        const found = selWard.get(gWard);
        if (found) { wardId = found.id; updWard.run(cawName, constId, wardId); summary.wardsUpdated += 1; }
        else { wardId = nanoid(); insWard.run(wardId, cawName, gWard, 0, constId); summary.wardsCreated += 1; }
        cache.ward.set(gWard, wardId);
      }

      let stationId = cache.station.get(gStation);
      if (!stationId) {
        const found = selStation.get(gStation);
        if (found) { stationId = found.id; updStation.run(regCentreName, wardId, stationId); summary.stationsUpdated += 1; }
        else { stationId = nanoid(); insStation.run(stationId, gStation, regCentreName, wardId, 0); summary.stationsCreated += 1; }
        cache.station.set(gStation, stationId);
      }

      // A registration centre routinely has many polling stations all
      // sharing its name — Bomu Primary School has 14, and one centre has
      // 58 — so the official name alone can't satisfy UNIQUE(station_id,
      // label). The last 2 digits of the 15-digit code are the polling
      // station's sequence within its centre, so use that to build a
      // distinct label ("Stream 01", "Stream 02", ...). The official
      // polling station name is preserved on the station itself, which is
      // where it actually belongs.
      const seq = gStream.slice(gStation.length);
      const streamLabel = `Stream ${seq}`;

      const existingStream = selStream.get(gStream);
      if (existingStream) {
        updStream.run(stationId, streamLabel, Math.round(voters), existingStream.id);
        summary.streamsUpdated += 1;
      } else {
        insStream.run(nanoid(), stationId, gStream, streamLabel, Math.round(voters));
        summary.streamsCreated += 1;
      }

      wardVoterTotals.set(wardId, (wardVoterTotals.get(wardId) || 0) + Math.round(voters));
    });

    // Roll stream-level figures up: station.registered = sum of its
    // streams, ward.registered_voters = sum of its streams. Done as a set
    // operation at the end rather than incrementally per row.
    db.exec(`
      UPDATE stations SET registered = COALESCE(
        (SELECT SUM(s.registered) FROM streams s WHERE s.station_id = stations.id), 0
      )
    `);
    db.exec(`
      UPDATE wards SET registered_voters = COALESCE((
        SELECT SUM(s.registered) FROM streams s
        JOIN stations st ON st.id = s.station_id
        WHERE st.ward_id = wards.id
      ), 0)
      WHERE EXISTS (SELECT 1 FROM stations st2 WHERE st2.ward_id = wards.id)
    `);
  });

  try {
    runImport();
  } catch (err) {
    return res.status(400).json({ error: `Import failed and was rolled back: ${err.message}` });
  }

  // The skipped list can be huge on a malformed file — cap what's returned
  // so a bad upload doesn't produce a multi-megabyte error response.
  const skippedTotal = summary.skipped.length;
  summary.skipped = summary.skipped.slice(0, 50);
  summary.skippedTotal = skippedTotal;

  audit({ req, action: 'register.import', entityType: 'register', entityId: 'bulk', after: { ...summary, skipped: `${skippedTotal} rows` } });
  res.json(summary);
});

// ---------------------------------------------------------------------
// Positions & candidates
// ---------------------------------------------------------------------

app.get('/api/positions', requireAuth, resolveTenant, (req, res) => {
  const allowed = req.tenant ? positionIdsForTenant(req.tenant.id) : null;
  const positions = db.prepare('SELECT * FROM positions').all()
    .filter((p) => allowed === null || allowed.includes(p.id));
  const candidates = db.prepare('SELECT * FROM candidates').all();
  res.json(positions.map((p) => ({
    id: p.id, name: p.name, scope: p.scope,
    candidates: candidates.filter((c) => c.position_id === p.id).map((c) => ({ id: c.id, name: c.name, party: c.party }))
  })));
});

app.post('/api/positions/:id/candidates', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id);
  if (!position) return res.status(404).json({ error: 'Position not found' });
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Candidate name is required' });
  const candidate = { id: nanoid(), position_id: position.id, name, party: (req.body?.party || '').trim() || null };
  db.prepare('INSERT INTO candidates (id, position_id, name, party) VALUES (@id, @position_id, @name, @party)').run(candidate);
  audit({ req, action: 'candidate.create', entityType: 'candidate', entityId: candidate.id, after: candidate });
  res.status(201).json({ id: candidate.id, name: candidate.name, party: candidate.party });
});

app.delete('/api/candidates/:id', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
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

app.get('/api/stations', requireAuth, resolveTenant, (req, res) => {
  const scopeWardIds = effectiveWardIds(req.user, req.tenant);
  const wards = Object.fromEntries(db.prepare('SELECT id, name FROM wards').all().map((w) => [w.id, w.name]));
  let rows = db.prepare('SELECT * FROM stations').all();

  if (req.user.role === 'agent') {
    const myWardIds = db.prepare(`
      SELECT DISTINCT st.ward_id as wardId FROM stream_agents sa
      JOIN streams s ON s.id = sa.stream_id JOIN stations st ON st.id = s.station_id
      WHERE sa.tenant_id = ? AND sa.agent_id = ?
    `).all(req.tenant.id, req.user.sub).map((r) => r.wardId);
    rows = rows.filter((s) => myWardIds.includes(s.ward_id));
  } else if (scopeWardIds !== null) {
    rows = rows.filter((s) => scopeWardIds.includes(s.ward_id));
  }
  res.json(rows.map((s) => toStationDTO(s, wards[s.ward_id])));
});

app.post('/api/stations', requireAuth, resolveTenant, requireSuperadmin, validate(stationCreateSchema), (req, res) => {
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

app.patch('/api/stations/:id', requireAuth, resolveTenant, requireSuperadmin, validate(stationUpdateSchema), (req, res) => {
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

// Stations are shared reference data — removing one affects every tenant
// monitoring it, so this is a platform-level action and the cascade clears
// operational rows across ALL tenants, not just the caller's.
app.delete('/api/stations/:id', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
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
  broadcast(req.tenant.id, 'station_delete', { id: existing.id });
  res.status(204).end();
});

function agentsForStream(tenantId, streamId) {
  return db.prepare(`
    SELECT u.id, u.name FROM stream_agents sa JOIN users u ON u.id = sa.agent_id
    WHERE sa.tenant_id = ? AND sa.stream_id = ?
  `).all(tenantId, streamId);
}

function agentAssignedToStream(tenantId, streamId, agentId) {
  return !!db.prepare('SELECT 1 FROM stream_agents WHERE tenant_id = ? AND stream_id = ? AND agent_id = ?').get(tenantId, streamId, agentId);
}

function toStreamDTO(tenantId, stream, station, wardName) {
  return {
    id: stream.id, label: stream.label, code: stream.code || null, registered: stream.registered,
    stationId: stream.station_id, stationCode: station?.code, stationName: station?.name,
    wardId: station?.ward_id, wardName,
    agents: agentsForStream(tenantId, stream.id),
    status: deriveStatus(tenantId, stream.id),
    votersProcessed: latestTurnout(tenantId, stream.id)
  };
}

function streamWithContext(streamId) {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(streamId);
  if (!stream) return null;
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stream.station_id);
  const ward = station ? db.prepare('SELECT name FROM wards WHERE id = ?').get(station.ward_id) : null;
  return { stream, station, ward };
}

function canViewStream(user, tenant, stream, station) {
  if (!withinTenantCeiling(tenant, 'ward', station.ward_id)) return false;
  if (user.role === 'superadmin') return true;
  if (user.role === 'admin' || user.role === 'coordinator' || user.role === 'aspirant') return inScope(user, 'ward', station.ward_id);
  if (user.role === 'agent') return agentAssignedToStream(tenant.id, stream.id, user.sub);
  return false;
}

function canEditStream(user, tenant, stream, station) {
  if (!withinTenantCeiling(tenant, 'ward', station.ward_id)) return false;
  if (user.role === 'aspirant') return false;   // view-only by definition
  if (user.role === 'superadmin' || user.role === 'admin' || user.role === 'coordinator') return inScope(user, 'ward', station.ward_id);
  if (user.role === 'agent') return agentAssignedToStream(tenant.id, stream.id, user.sub);
  return false;
}

app.get('/api/streams', requireAuth, resolveTenant, requireTenant, requireModule('stations'), (req, res) => {
  const scopeWardIds = effectiveWardIds(req.user, req.tenant);
  let rows = db.prepare('SELECT * FROM streams').all();
  const stations = Object.fromEntries(db.prepare('SELECT * FROM stations').all().map((s) => [s.id, s]));
  const wards = Object.fromEntries(db.prepare('SELECT id, name FROM wards').all().map((w) => [w.id, w.name]));

  if (req.user.role === 'agent') {
    const myStreamIds = new Set(db.prepare('SELECT stream_id FROM stream_agents WHERE tenant_id = ? AND agent_id = ?').all(req.tenant.id, req.user.sub).map((r) => r.stream_id));
    rows = rows.filter((s) => myStreamIds.has(s.id));
  } else if (scopeWardIds !== null) {
    rows = rows.filter((s) => scopeWardIds.includes(stations[s.station_id]?.ward_id));
  }

  res.json(rows.map((s) => {
    const station = stations[s.station_id];
    return toStreamDTO(req.tenant.id, s, station, wards[station?.ward_id]);
  }));
});

function custodyOn_(req, ctx) {
  if (!tenantHasModule(req.tenant.id, 'ballot_custody')) return null;
  return custodyProgress(req.tenant.id, ctx.stream.id);
}

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

app.get('/api/streams/:id', requireAuth, resolveTenant, requireTenant, requireModule('stations'), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canViewStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });

  const events = db.prepare('SELECT * FROM process_events WHERE tenant_id = ? AND stream_id = ? ORDER BY at ASC').all(req.tenant.id, ctx.stream.id);
  const boxes = db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND stream_id = ?').all(req.tenant.id, ctx.stream.id).map(toBallotBoxDTO);
  const booklets = db.prepare('SELECT * FROM ballot_booklets WHERE tenant_id = ? AND stream_id = ?').all(req.tenant.id, ctx.stream.id)
    .map((b) => ({ id: b.id, positionId: b.position_id, serialStart: b.serial_start, serialEnd: b.serial_end, quantity: b.quantity, openedAt: b.opened_at }));
  const results = db.prepare('SELECT * FROM results WHERE tenant_id = ? AND stream_id = ?').all(req.tenant.id, ctx.stream.id)
    .map((r) => ({
      id: r.id, positionId: r.position_id, candidateVotes: JSON.parse(r.candidate_votes || '{}'),
      rejectedVotes: r.rejected_votes, disputedVotes: r.disputed_votes, spoiltVotes: r.spoilt_votes, strayVotes: r.stray_votes,
      totalCast: r.total_cast, remainingBallots: r.remaining_ballots, validVotes: r.valid_votes,
      formReference: r.form_reference, submittedAt: r.submitted_at
    }));
  const turnout = db.prepare('SELECT * FROM turnout_updates WHERE tenant_id = ? AND stream_id = ? ORDER BY reported_at DESC').all(req.tenant.id, ctx.stream.id)
    .map((t) => ({ id: t.id, votersProcessed: t.voters_processed, reportedAt: t.reported_at }));
  const attachments = (entityIds) => db.prepare(`SELECT * FROM attachments WHERE tenant_id = ? AND entity_type = 'result' AND entity_id IN (${entityIds.map(() => '?').join(',') || "''"})`).all(req.tenant.id, ...entityIds);

  res.json({
    ...toStreamDTO(req.tenant.id, ctx.stream, ctx.station, ctx.ward?.name),
    canEdit: canEditStream(req.user, req.tenant, ctx.stream, ctx.station),
    events: events.map((e) => ({ id: e.id, eventType: e.event_type, at: e.at, note: e.note, gpsLat: e.gps_lat, gpsLng: e.gps_lng, actorId: e.actor_id, recordedBy: e.recorded_by, details: e.details_json ? JSON.parse(e.details_json) : {} })),
    custody: custodyOn_(req, ctx),
    ballotBoxes: boxes,
    ballotBooklets: booklets,
    results,
    resultAttachments: results.length ? attachments(results.map((r) => r.id)).map((a) => ({ id: a.id, entityId: a.entity_id, fileType: a.file_type })) : [],
    turnoutHistory: turnout
  });
});

app.post('/api/stations/:id/streams', requireAuth, resolveTenant, requireSuperadmin, validate(streamCreateSchema), (req, res) => {
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(req.params.id);
  if (!station) return res.status(404).json({ error: 'Station not found' });
  const dup = db.prepare('SELECT id FROM streams WHERE station_id = ? AND label = ?').get(station.id, req.body.label);
  if (dup) return res.status(409).json({ error: 'A stream with that label already exists at this station' });

  const stream = { id: nanoid(), station_id: station.id, label: req.body.label, code: req.body.code || null, registered: req.body.registered };
  db.prepare('INSERT INTO streams (id, station_id, label, code, registered) VALUES (@id, @station_id, @label, @code, @registered)').run(stream);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(station.ward_id);
  const dto = toStreamDTO(req.tenant.id, stream, station, ward?.name);
  audit({ req, action: 'stream.create', entityType: 'stream', entityId: stream.id, after: dto });
  broadcast(req.tenant.id, 'stream_update', dto);
  res.status(201).json(dto);
});

// Shared reference data — see the station delete above.
app.delete('/api/streams/:id', requireAuth, resolveTenant, requireSuperadmin, (req, res) => {
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
  broadcast(req.tenant.id, 'stream_delete', { id: existing.id });
  res.status(204).end();
});

app.post('/api/streams/:id/agents', requireAuth, resolveTenant, requireTenant, requireModule('agents'), requireRole('coordinator', 'admin'), validate(streamAgentSchema), (req, res) => {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stream.station_id);
  if (!inScope(req.user, 'ward', station.ward_id)) return res.status(403).json({ error: 'This stream is outside your jurisdiction' });

  const agent = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND id = ? AND role = 'agent' AND status != 'pending'").get(req.tenant.id, req.body.agentId);
  if (!agent) return res.status(400).json({ error: 'Unknown agent' });
  if (agent.jurisdiction_type !== 'ward' || agent.jurisdiction_id !== station.ward_id) {
    return res.status(400).json({ error: "The agent's home ward must match the station's ward" });
  }

  db.prepare('INSERT OR IGNORE INTO stream_agents (tenant_id, stream_id, agent_id) VALUES (?, ?, ?)').run(req.tenant.id, stream.id, agent.id);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(station.ward_id);
  const dto = toStreamDTO(req.tenant.id, stream, station, ward?.name);

  audit({ req, action: 'stream.agent_add', entityType: 'stream', entityId: stream.id, after: { agentId: agent.id } });
  broadcast(req.tenant.id, 'stream_update', dto);
  res.status(201).json(dto);
});

app.delete('/api/streams/:id/agents/:agentId', requireAuth, resolveTenant, requireTenant, requireModule('agents'), requireRole('coordinator', 'admin'), (req, res) => {
  const stream = db.prepare('SELECT * FROM streams WHERE id = ?').get(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Stream not found' });
  const station = db.prepare('SELECT * FROM stations WHERE id = ?').get(stream.station_id);
  if (!inScope(req.user, 'ward', station.ward_id)) return res.status(403).json({ error: 'This stream is outside your jurisdiction' });

  db.prepare('DELETE FROM stream_agents WHERE tenant_id = ? AND stream_id = ? AND agent_id = ?').run(req.tenant.id, stream.id, req.params.agentId);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(station.ward_id);
  const dto = toStreamDTO(req.tenant.id, stream, station, ward?.name);

  audit({ req, action: 'stream.agent_remove', entityType: 'stream', entityId: stream.id, after: { agentId: req.params.agentId } });
  broadcast(req.tenant.id, 'stream_update', dto);
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

// The seats this instance is actually tracking (all six unless narrowed).
function expectedPositionIds(tenantId) {
  const tracked = positionIdsForTenant(tenantId);
  return tracked === null ? db.prepare('SELECT id FROM positions').all().map((p) => p.id) : tracked;
}

// How far each seat's ballot box has got, for gating the milestones.
function custodyProgress(tenantId, streamId) {
  const expected = expectedPositionIds(tenantId);
  const boxes = db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND stream_id = ?').all(tenantId, streamId);
  const byPos = Object.fromEntries(boxes.map((b) => [b.position_id, b]));
  const count = (pred) => expected.filter((pid) => byPos[pid] && pred(byPos[pid])).length;
  return {
    expected: expected.length,
    sealed: count((b) => b.confirmed_empty_at && b.sealed_at),
    closed: count((b) => b.closing_seal_serial),
    matched: count((b) => b.seal_match_confirmed_at)
  };
}

app.post('/api/streams/:id/events', requireAuth, resolveTenant, requireTenant, requireModule('process_events'), validate(processEventSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });

  const eventType = req.body.eventType;
  const tid = req.tenant.id;
  const sid = ctx.stream.id;
  const custodyOn = tenantHasModule(tid, 'ballot_custody');

  if (AUTO_ONLY_EVENTS.has(eventType)) {
    const how = eventType === 'boxes_confirmed_empty'
      ? 'it is recorded automatically once every seat\'s ballot box has its serial logged, is confirmed empty and is sealed'
      : 'it is recorded automatically when results are submitted';
    return res.status(409).json({ error: `${EVENT_LABEL[eventType]} can't be logged by hand — ${how}.` });
  }
  if (hasEvent(tid, sid, eventType)) return res.status(409).json({ error: `${EVENT_LABEL[eventType]} has already been logged for this stream` });
  if (PRE_CLOSE_EVENTS.has(eventType) && hasEvent(tid, sid, 'polling_closed')) {
    return res.status(409).json({ error: 'Voting is closed — pre-close activities can no longer be logged or edited' });
  }

  // Sequencing rules. Each one stops a milestone being declared before the
  // physical work it depends on has been recorded.
  const progress = custodyOn ? custodyProgress(tid, sid) : null;
  if (eventType === 'polling_opened' && custodyOn && progress.sealed < progress.expected) {
    return res.status(409).json({ error: `Before polling can be declared open, every seat's ballot box needs its serial logged, confirmed empty and sealed (${progress.sealed} of ${progress.expected} done).` });
  }
  if (eventType === 'polling_closed') {
    if (!hasEvent(tid, sid, 'polling_opened')) return res.status(409).json({ error: 'Polling has not been declared open yet' });
    if (custodyOn && progress.closed < progress.expected) {
      return res.status(409).json({ error: `Before polling can be declared closed, the closing seal over each ballot slot must be recorded (${progress.closed} of ${progress.expected} done).` });
    }
  }
  if (eventType === 'counting_started') {
    if (!hasEvent(tid, sid, 'polling_closed')) return res.status(409).json({ error: 'Polling has not been declared closed yet' });
    if (custodyOn && progress.matched < progress.expected) {
      return res.status(409).json({ error: `Before counting starts, confirm for each seat whether the seals cut match those applied (${progress.matched} of ${progress.expected} done).` });
    }
  }
  if (eventType === 'materials_departed' && !hasEvent(tid, sid, 'results_declared')) {
    return res.status(409).json({ error: 'Materials can only depart once results have been submitted' });
  }
  if (eventType === 'materials_arrived_tally_centre' && !hasEvent(tid, sid, 'materials_departed')) {
    return res.status(409).json({ error: 'Materials have not been logged as departing the station yet' });
  }

  const event = {
    id: nanoid(), tenant_id: tid, stream_id: sid, event_type: eventType, actor_id: req.user.sub,
    gps_lat: req.body.gpsLat ?? null, gps_lng: req.body.gpsLng ?? null, note: req.body.note || null,
    recorded_by: req.body.recordedBy, details_json: JSON.stringify(req.body.details || {}),
    at: new Date().toISOString()
  };
  db.prepare('INSERT INTO process_events (id, tenant_id, stream_id, event_type, actor_id, gps_lat, gps_lng, note, recorded_by, details_json, at) VALUES (@id, @tenant_id, @stream_id, @event_type, @actor_id, @gps_lat, @gps_lng, @note, @recorded_by, @details_json, @at)').run(event);

  const dto = toStreamDTO(req.tenant.id, ctx.stream, ctx.station, ctx.ward?.name);
  audit({ req, action: 'stream.event', entityType: 'stream', entityId: ctx.stream.id, after: { eventType: event.event_type } });
  broadcast(req.tenant.id, 'stream_update', dto);
  pushActivity(req.tenant.id, `${ctx.ward?.name || 'Station'} — ${ctx.station.code} ${ctx.stream.label}: ${EVENT_LABEL[eventType] || eventType}`, 'info', req.user.sub);

  res.status(201).json({ event: { id: event.id, eventType, at: event.at }, stream: dto });
});

// ---------------------------------------------------------------------
// Ballot box & booklet custody
// ---------------------------------------------------------------------

app.post('/api/streams/:id/ballot-boxes', requireAuth, resolveTenant, requireTenant, requireModule('ballot_custody'), validate(ballotBoxSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (hasEvent(req.tenant.id, ctx.stream.id, 'polling_closed')) return res.status(409).json({ error: 'Voting is closed — ballot box records can no longer be edited' });

  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.body.positionId);
  if (!position) return res.status(400).json({ error: 'Unknown position' });
  if (!tenantTracksPosition(req.tenant.id, position.id)) {
    return res.status(403).json({ error: `This instance does not track the ${position.name} race` });
  }

  const existing = db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND stream_id = ? AND position_id = ?').get(req.tenant.id, ctx.stream.id, position.id);
  const record = { id: existing?.id || nanoid(), tenant_id: req.tenant.id, stream_id: ctx.stream.id, position_id: position.id, box_serial: req.body.boxSerial };
  if (existing) {
    db.prepare('UPDATE ballot_boxes SET box_serial = ? WHERE tenant_id = ? AND id = ?').run(record.box_serial, req.tenant.id, existing.id);
  } else {
    db.prepare('INSERT INTO ballot_boxes (id, tenant_id, stream_id, position_id, box_serial) VALUES (@id, @tenant_id, @stream_id, @position_id, @box_serial)').run(record);
  }

  audit({ req, action: 'ballot_box.log', entityType: 'ballot_box', entityId: record.id, after: { positionId: position.id, boxSerial: record.box_serial } });
  const saved = db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ?').get(req.tenant.id, record.id);
  res.status(existing ? 200 : 201).json(toBallotBoxDTO(saved));
});

// Once every logged box for the stream is both confirmed empty AND sealed,
// the stream's timeline advances to boxes_confirmed_empty automatically —
// that milestone now represents the complete "ready to vote" state, not
// just the confirm-empty step in isolation.
function maybeAdvanceAfterSealing(ctx) {
  const progress = custodyProgress(ctx.tenantId, ctx.stream.id);
  if (progress.expected > 0 && progress.sealed >= progress.expected && !hasEvent(ctx.tenantId, ctx.stream.id, 'boxes_confirmed_empty')) {
    db.prepare('INSERT INTO process_events (id, tenant_id, stream_id, event_type, actor_id, recorded_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), ctx.tenantId, ctx.stream.id, 'boxes_confirmed_empty', ctx.actorId, 'Recorded automatically', new Date().toISOString());
    broadcast(ctx.tenantId, 'stream_update', toStreamDTO(ctx.tenantId, ctx.stream, ctx.station, ctx.ward?.name));
  }
}

app.patch('/api/streams/:id/ballot-boxes/:boxId/confirm', requireAuth, resolveTenant, requireTenant, requireModule('ballot_custody'), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (hasEvent(req.tenant.id, ctx.stream.id, 'polling_closed')) return res.status(409).json({ error: 'Voting is closed — ballot box records can no longer be edited' });

  const box = db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ? AND stream_id = ?').get(req.tenant.id, req.params.boxId, ctx.stream.id);
  if (!box) return res.status(404).json({ error: 'Ballot box record not found' });

  const now = new Date().toISOString();
  db.prepare('UPDATE ballot_boxes SET confirmed_empty_at = ?, confirmed_by = ? WHERE tenant_id = ? AND id = ?').run(now, req.user.sub, req.tenant.id, box.id);

  audit({ req, action: 'ballot_box.confirm', entityType: 'ballot_box', entityId: box.id, after: { confirmedEmptyAt: now } });
  maybeAdvanceAfterSealing({ ...ctx, tenantId: req.tenant.id, actorId: req.user.sub });
  res.json(toBallotBoxDTO(db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ?').get(req.tenant.id, box.id)));
});

// Sealing: an IEBC seal is mandatory; any number of additional agent/party
// seals may be added alongside it. Requires the box to already be
// confirmed empty — you can't seal a box you haven't verified is empty.
app.patch('/api/streams/:id/ballot-boxes/:boxId/seal', requireAuth, resolveTenant, requireTenant, requireModule('ballot_custody'), validate(ballotBoxSealSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (hasEvent(req.tenant.id, ctx.stream.id, 'polling_closed')) return res.status(409).json({ error: 'Voting is closed — ballot box records can no longer be edited' });

  const box = db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ? AND stream_id = ?').get(req.tenant.id, req.params.boxId, ctx.stream.id);
  if (!box) return res.status(404).json({ error: 'Ballot box record not found' });
  if (!box.confirmed_empty_at) return res.status(409).json({ error: 'Confirm the box is empty before sealing it' });

  const now = new Date().toISOString();
  db.prepare('UPDATE ballot_boxes SET iebc_seal_serial = ?, agent_seal_serials = ?, sealed_at = ?, sealed_by = ? WHERE tenant_id = ? AND id = ?')
    .run(req.body.iebcSealSerial, JSON.stringify(req.body.agentSealSerials), now, req.user.sub, req.tenant.id, box.id);

  audit({ req, action: 'ballot_box.seal', entityType: 'ballot_box', entityId: box.id, after: { iebcSealSerial: req.body.iebcSealSerial, agentSealSerials: req.body.agentSealSerials } });
  maybeAdvanceAfterSealing({ ...ctx, tenantId: req.tenant.id, actorId: req.user.sub });
  res.json(toBallotBoxDTO(db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ?').get(req.tenant.id, box.id)));
});

// The closing seal over the ballot slot itself, applied at close of voting.
// Requires the box to already have its initial seal in place.
app.patch('/api/streams/:id/ballot-boxes/:boxId/close-seal', requireAuth, resolveTenant, requireTenant, requireModule('ballot_custody'), validate(ballotBoxClosingSealSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });

  const box = db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ? AND stream_id = ?').get(req.tenant.id, req.params.boxId, ctx.stream.id);
  if (!box) return res.status(404).json({ error: 'Ballot box record not found' });
  if (!box.sealed_at) return res.status(409).json({ error: 'Seal the box before applying the closing seal' });
  if (!hasEvent(req.tenant.id, ctx.stream.id, 'polling_opened')) return res.status(409).json({ error: 'The closing seal is applied at the end of voting, once polling has been declared open' });

  const now = new Date().toISOString();
  db.prepare('UPDATE ballot_boxes SET closing_seal_serial = ?, closing_sealed_at = ?, closing_sealed_by = ? WHERE tenant_id = ? AND id = ?')
    .run(req.body.sealSerial, now, req.user.sub, req.tenant.id, box.id);

  audit({ req, action: 'ballot_box.close_seal', entityType: 'ballot_box', entityId: box.id, after: { closingSealSerial: req.body.sealSerial } });
  res.json(toBallotBoxDTO(db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ?').get(req.tenant.id, box.id)));
});

// At the start of tallying: confirm whether the seals cut are the same
// ones applied when the box was sealed and closed. A "no" here is exactly
// the kind of discrepancy that should prompt an incident report — the
// frontend surfaces that prompt, this endpoint just records the answer.
app.patch('/api/streams/:id/ballot-boxes/:boxId/seal-match', requireAuth, resolveTenant, requireTenant, requireModule('ballot_custody'), validate(ballotBoxSealMatchSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });

  const box = db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ? AND stream_id = ?').get(req.tenant.id, req.params.boxId, ctx.stream.id);
  if (!box) return res.status(404).json({ error: 'Ballot box record not found' });
  if (!box.closing_seal_serial) return res.status(409).json({ error: 'The box must have its closing seal recorded first' });

  const now = new Date().toISOString();
  db.prepare('UPDATE ballot_boxes SET seals_match_at_tally = ?, seal_match_note = ?, seal_match_confirmed_at = ?, seal_match_confirmed_by = ? WHERE tenant_id = ? AND id = ?')
    .run(req.body.sealsMatch ? 1 : 0, req.body.note || null, now, req.user.sub, req.tenant.id, box.id);

  audit({ req, action: 'ballot_box.seal_match', entityType: 'ballot_box', entityId: box.id, after: { sealsMatch: req.body.sealsMatch, note: req.body.note } });
  if (!req.body.sealsMatch) pushActivity(req.tenant.id, `Seal mismatch reported at ${ctx.ward?.name} — ${ctx.station.code} ${ctx.stream.label}`, 'alert', req.user.sub);
  res.json(toBallotBoxDTO(db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ?').get(req.tenant.id, box.id)));
});

// After counting concludes, the box is re-sealed with a new seal.
app.patch('/api/streams/:id/ballot-boxes/:boxId/reseal', requireAuth, resolveTenant, requireTenant, requireModule('ballot_custody'), validate(ballotBoxResealSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });

  const box = db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ? AND stream_id = ?').get(req.tenant.id, req.params.boxId, ctx.stream.id);
  if (!box) return res.status(404).json({ error: 'Ballot box record not found' });
  if (!box.seal_match_confirmed_at) return res.status(409).json({ error: 'Confirm the seal match at the start of tallying before re-sealing' });

  const now = new Date().toISOString();
  db.prepare('UPDATE ballot_boxes SET reseal_serial = ?, resealed_at = ?, resealed_by = ? WHERE tenant_id = ? AND id = ?')
    .run(req.body.sealSerial, now, req.user.sub, req.tenant.id, box.id);

  audit({ req, action: 'ballot_box.reseal', entityType: 'ballot_box', entityId: box.id, after: { resealSerial: req.body.sealSerial } });
  res.json(toBallotBoxDTO(db.prepare('SELECT * FROM ballot_boxes WHERE tenant_id = ? AND id = ?').get(req.tenant.id, box.id)));
});

app.post('/api/streams/:id/booklets', requireAuth, resolveTenant, requireTenant, requireModule('booklets'), validate(ballotBookletSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (!hasEvent(req.tenant.id, ctx.stream.id, 'polling_opened')) return res.status(409).json({ error: 'Booklets can only be logged after polling has been declared open' });
  if (hasEvent(req.tenant.id, ctx.stream.id, 'polling_closed')) return res.status(409).json({ error: 'Voting is closed — booklet records can no longer be edited' });

  const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(req.body.positionId);
  if (!position) return res.status(400).json({ error: 'Unknown position' });
  if (!tenantTracksPosition(req.tenant.id, position.id)) {
    return res.status(403).json({ error: `This instance does not track the ${position.name} race` });
  }

  const booklet = {
    id: nanoid(), tenant_id: req.tenant.id, stream_id: ctx.stream.id, position_id: position.id, serial_start: req.body.serialStart, serial_end: req.body.serialEnd,
    quantity: req.body.quantity || 0, opened_by: req.user.sub, opened_at: new Date().toISOString()
  };
  db.prepare('INSERT INTO ballot_booklets (id, tenant_id, stream_id, position_id, serial_start, serial_end, quantity, opened_by, opened_at) VALUES (@id, @tenant_id, @stream_id, @position_id, @serial_start, @serial_end, @quantity, @opened_by, @opened_at)').run(booklet);

  audit({ req, action: 'booklet.log', entityType: 'ballot_booklet', entityId: booklet.id, after: { positionId: position.id, serialStart: booklet.serial_start, serialEnd: booklet.serial_end, quantity: booklet.quantity } });
  res.status(201).json({ id: booklet.id, positionId: position.id, serialStart: booklet.serial_start, serialEnd: booklet.serial_end, quantity: booklet.quantity, openedAt: booklet.opened_at });
});

// ---------------------------------------------------------------------
// Turnout snapshots
// ---------------------------------------------------------------------

app.post('/api/streams/:id/turnout', requireAuth, resolveTenant, requireTenant, requireModule('turnout'), validate(turnoutUpdateSchema), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (!hasEvent(req.tenant.id, ctx.stream.id, 'polling_opened')) return res.status(409).json({ error: 'Turnout can only be logged while polling is open' });
  if (hasEvent(req.tenant.id, ctx.stream.id, 'polling_closed')) return res.status(409).json({ error: 'Polling has closed — turnout is no longer being tracked live' });
  if (req.body.votersProcessed > ctx.stream.registered) {
    return res.status(400).json({ error: `Cannot exceed ${ctx.stream.registered} registered voters for this stream` });
  }

  const snap = { id: nanoid(), tenant_id: req.tenant.id, stream_id: ctx.stream.id, voters_processed: req.body.votersProcessed, reported_by: req.user.sub, reported_at: new Date().toISOString() };
  db.prepare('INSERT INTO turnout_updates (id, tenant_id, stream_id, voters_processed, reported_by, reported_at) VALUES (@id, @tenant_id, @stream_id, @voters_processed, @reported_by, @reported_at)').run(snap);

  const dto = toStreamDTO(req.tenant.id, ctx.stream, ctx.station, ctx.ward?.name);
  audit({ req, action: 'turnout.update', entityType: 'stream', entityId: ctx.stream.id, after: { votersProcessed: snap.voters_processed } });
  broadcast(req.tenant.id, 'stream_update', dto);
  res.status(201).json({ id: snap.id, votersProcessed: snap.voters_processed, reportedAt: snap.reported_at, stream: dto });
});

// ---------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------

app.post('/api/streams/:id/results', requireAuth, resolveTenant, requireTenant, requireModule('results'), evidenceUpload.single('photo'), (req, res) => {
  const ctx = streamWithContext(req.params.id);
  if (!ctx || !ctx.station) return res.status(404).json({ error: 'Stream not found' });
  if (!canEditStream(req.user, req.tenant, ctx.stream, ctx.station)) return res.status(403).json({ error: 'Not authorized for this stream' });
  if (!hasEvent(req.tenant.id, ctx.stream.id, 'counting_started')) return res.status(409).json({ error: 'Results can only be submitted once tallying has been logged as started' });
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
  if (!tenantTracksPosition(req.tenant.id, positionId)) {
    return res.status(403).json({ error: `This instance does not track the ${position.name} race` });
  }

  if (totalCast > ctx.stream.registered) {
    return res.status(400).json({ error: `Total ballots cast (${totalCast}) exceed ${ctx.stream.registered} registered voters for this stream` });
  }

  const anomalies = [];
  const candidateSum = Object.values(parsed.data.candidateVotes).reduce((a, v) => a + v, 0);
  const categorySum = candidateSum + rejectedVotes + disputedVotes + spoiltVotes + strayVotes;
  if (categorySum !== totalCast) {
    anomalies.push(`Ballot categories sum to ${categorySum}, but total ballots cast was entered as ${totalCast}.`);
  }
  const issuedForPosition = db.prepare('SELECT COALESCE(SUM(quantity), 0) as total FROM ballot_booklets WHERE tenant_id = ? AND stream_id = ? AND position_id = ?').get(req.tenant.id, ctx.stream.id, positionId).total;
  if (issuedForPosition > 0 && (issuedForPosition - remainingBallots) !== totalCast) {
    anomalies.push(`Ballots issued (${issuedForPosition}) minus ballots remaining (${remainingBallots}) = ${issuedForPosition - remainingBallots}, which does not match total ballots cast (${totalCast}).`);
  }

  const existing = db.prepare('SELECT id FROM results WHERE tenant_id = ? AND stream_id = ? AND position_id = ?').get(req.tenant.id, ctx.stream.id, positionId);
  const record = {
    id: existing?.id || nanoid(), tenant_id: req.tenant.id, stream_id: ctx.stream.id, position_id: positionId,
    candidate_votes: JSON.stringify(parsed.data.candidateVotes), rejected_votes: rejectedVotes,
    disputed_votes: disputedVotes, spoilt_votes: spoiltVotes, stray_votes: strayVotes,
    total_cast: totalCast, remaining_ballots: remainingBallots, valid_votes: validVotes,
    form_reference: formReference || null, submitted_by: req.user.sub, submitted_at: new Date().toISOString()
  };
  if (existing) {
    db.prepare(`
      UPDATE results SET candidate_votes = ?, rejected_votes = ?, disputed_votes = ?, spoilt_votes = ?, stray_votes = ?,
        total_cast = ?, remaining_ballots = ?, valid_votes = ?, form_reference = ?, submitted_by = ?, submitted_at = ? WHERE tenant_id = ? AND id = ?
    `).run(record.candidate_votes, record.rejected_votes, record.disputed_votes, record.spoilt_votes, record.stray_votes,
      record.total_cast, record.remaining_ballots, record.valid_votes, record.form_reference, record.submitted_by, record.submitted_at, req.tenant.id, existing.id);
  } else {
    db.prepare(`
      INSERT INTO results (id, tenant_id, stream_id, position_id, candidate_votes, rejected_votes, disputed_votes, spoilt_votes, stray_votes,
        total_cast, remaining_ballots, valid_votes, form_reference, submitted_by, submitted_at)
      VALUES (@id, @tenant_id, @stream_id, @position_id, @candidate_votes, @rejected_votes, @disputed_votes, @spoilt_votes, @stray_votes,
        @total_cast, @remaining_ballots, @valid_votes, @form_reference, @submitted_by, @submitted_at)
    `).run(record);
  }

  db.prepare('INSERT INTO attachments (id, tenant_id, entity_type, entity_id, file_type, storage_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(nanoid(), req.tenant.id, 'result', record.id, 'image', req.file.filename, req.user.sub);

  const now = new Date().toISOString();
  ['counting_completed', 'results_declared'].forEach((eventType) => {
    if (!hasEvent(req.tenant.id, ctx.stream.id, eventType)) {
      db.prepare('INSERT INTO process_events (id, tenant_id, stream_id, event_type, actor_id, recorded_by, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(nanoid(), req.tenant.id, ctx.stream.id, eventType, req.user.sub, 'Recorded automatically', now);
    }
  });

  const dto = toStreamDTO(req.tenant.id, ctx.stream, ctx.station, ctx.ward?.name);
  audit({ req, action: 'result.submit', entityType: 'result', entityId: record.id, after: { positionId, validVotes, totalCast, anomalies } });
  broadcast(req.tenant.id, 'stream_update', dto);
  pushActivity(req.tenant.id, `${ctx.ward?.name} — ${ctx.station.code} ${ctx.stream.label}: ${position.name} results submitted${anomalies.length ? ' (anomaly flagged)' : ''}`, anomalies.length ? 'alert' : 'ok', req.user.sub);

  res.status(existing ? 200 : 201).json({ id: record.id, positionId, stream: dto, anomalies });
});

app.get('/api/results/aggregate', requireAuth, resolveTenant, requireTenant, requireModule('results'), (req, res) => {
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
  const results = streamIds.length ? db.prepare(`SELECT * FROM results WHERE tenant_id = ? AND position_id = ? AND stream_id IN (${streamIds.map(() => '?').join(',')})`).all(req.tenant.id, positionId, ...streamIds) : [];

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

app.get('/api/agents', requireAuth, resolveTenant, requireTenant, requireModule('agents'), requireRole('coordinator', 'admin', 'aspirant'), (req, res) => {
  const scopeWardIds = effectiveWardIds(req.user, req.tenant);
  const wards = Object.fromEntries(db.prepare('SELECT id, name FROM wards').all().map((w) => [w.id, w.name]));
  let rows = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND role = 'agent' ORDER BY name").all(req.tenant.id);
  if (scopeWardIds !== null) rows = rows.filter((u) => scopeWardIds.includes(u.jurisdiction_id));

  const streamsByAgent = {};
  db.prepare(`
    SELECT sa.agent_id as agentId, s.label, st.code FROM stream_agents sa
    JOIN streams s ON s.id = sa.stream_id JOIN stations st ON st.id = s.station_id
    WHERE sa.tenant_id = ?
  `).all(req.tenant.id).forEach((r) => {
    if (!streamsByAgent[r.agentId]) streamsByAgent[r.agentId] = [];
    streamsByAgent[r.agentId].push(`${r.code} — ${r.label}`);
  });

  res.json(rows.map((u) => toAgentDTO(u, wards[u.jurisdiction_id], streamsByAgent[u.id])));
});

app.patch('/api/agents/:id', requireAuth, resolveTenant, requireTenant, requireModule('agents'), validate(agentStatusSchema), (req, res) => {
  const isSelf = req.user.sub === req.params.id;
  const isStaff = req.user.role === 'coordinator' || req.user.role === 'admin';
  if (!isSelf && !isStaff) return res.status(403).json({ error: 'You can only update your own status' });

  const agent = db.prepare("SELECT * FROM users WHERE tenant_id = ? AND id = ? AND role = 'agent'").get(req.tenant.id, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  if (isStaff && !isSelf && !inScope(req.user, 'ward', agent.jurisdiction_id)) return res.status(403).json({ error: 'This agent is outside your jurisdiction' });

  const now = new Date().toISOString();
  db.prepare('UPDATE users SET status = ?, last_check_in = ? WHERE id = ?').run(req.body.status, now, agent.id);
  const updated = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND id = ?').get(req.tenant.id, agent.id);
  const ward = db.prepare('SELECT name FROM wards WHERE id = ?').get(updated.jurisdiction_id);
  const dto = toAgentDTO(updated, ward?.name);

  audit({ req, action: 'agent.status', entityType: 'user', entityId: agent.id, before: { status: agent.status }, after: { status: req.body.status } });
  broadcast(req.tenant.id, 'agent_update', dto);
  if (req.body.status === 'active') pushActivity(req.tenant.id, `Agent ${updated.name} checked in at ${ward?.name} Ward`, 'info', req.user.sub);
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

app.get('/api/incidents', requireAuth, resolveTenant, requireTenant, requireModule('incidents'), (req, res) => {
  const rows = db.prepare('SELECT * FROM incidents WHERE tenant_id = ? ORDER BY urgent DESC, created_at DESC').all(req.tenant.id);
  const scoped = req.user.role === 'admin' ? rows : rows.filter((i) => {
    const wardId = incidentWardId(i);
    return wardId ? inScope(req.user, 'ward', wardId) : req.user.jurisdictionType === 'national';
  });
  const attachments = db.prepare("SELECT * FROM attachments WHERE tenant_id = ? AND entity_type = 'incident'").all(req.tenant.id);
  res.json(scoped.map((i) => toIncidentDTO(i, attachments)));
});

app.post('/api/incidents', requireAuth, resolveTenant, requireTenant, requireModule('incidents'), evidenceUpload.array('files', 5), (req, res) => {
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
    id: nanoid(), tenant_id: req.tenant.id, stream_id: streamId || null, ward_id: resolvedWardId || null,
    station_code: stationCode || '—', ward_name: wardName || '—',
    note, severity, urgent: urgent ? 1 : 0, status: 'open', created_by: req.user.sub, created_at: new Date().toISOString()
  };
  db.prepare(`
    INSERT INTO incidents (id, tenant_id, stream_id, ward_id, station_code, ward_name, note, severity, urgent, status, created_by, created_at)
    VALUES (@id, @tenant_id, @stream_id, @ward_id, @station_code, @ward_name, @note, @severity, @urgent, @status, @created_by, @created_at)
  `).run(incident);

  const fileTypeFor = (mimetype) => mimetype.startsWith('video') ? 'video' : mimetype.startsWith('audio') ? 'audio' : 'image';
  (req.files || []).forEach((file) => {
    db.prepare('INSERT INTO attachments (id, tenant_id, entity_type, entity_id, file_type, storage_path, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(nanoid(), req.tenant.id, 'incident', incident.id, fileTypeFor(file.mimetype), file.filename, req.user.sub);
  });

  const dto = toIncidentDTO(incident, (req.files || []).map((f, idx) => ({ id: `pending-${idx}`, entity_id: incident.id, file_type: fileTypeFor(f.mimetype) })));
  audit({ req, action: 'incident.create', entityType: 'incident', entityId: incident.id, after: { note, severity, urgent: !!urgent } });
  broadcast(req.tenant.id, 'incident', dto);
  pushActivity(req.tenant.id, `${urgent ? 'URGENT incident' : 'Incident'} flagged at ${dto.wardName} — ${dto.stationCode}`, 'alert', req.user.sub);
  res.status(201).json(dto);
});

function requireIncidentScope(req, res, incident) {
  const wardId = incidentWardId(incident);
  const ok = req.user.role === 'admin' || (wardId ? inScope(req.user, 'ward', wardId) : req.user.jurisdictionType === 'national');
  if (!ok) res.status(403).json({ error: 'This incident is outside your jurisdiction' });
  return ok;
}

app.patch('/api/incidents/:id/resolve', requireAuth, resolveTenant, requireTenant, requireModule('incidents'), requireRole('coordinator', 'admin'), validate(incidentResolveSchema), (req, res) => {
  const incident = db.prepare('SELECT * FROM incidents WHERE tenant_id = ? AND id = ?').get(req.tenant.id, req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  if (!requireIncidentScope(req, res, incident)) return;
  if (incident.status === 'resolved') return res.status(409).json({ error: 'Already resolved' });

  const now = new Date().toISOString();
  db.prepare('UPDATE incidents SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ? WHERE tenant_id = ? AND id = ?')
    .run('resolved', req.user.sub, now, req.body.resolutionNote, req.tenant.id, incident.id);
  const updated = db.prepare('SELECT * FROM incidents WHERE tenant_id = ? AND id = ?').get(req.tenant.id, incident.id);
  const dto = toIncidentDTO(updated, db.prepare("SELECT * FROM attachments WHERE tenant_id = ? AND entity_type = 'incident' AND entity_id = ?").all(req.tenant.id, incident.id));

  audit({ req, action: 'incident.resolve', entityType: 'incident', entityId: incident.id, before: { status: incident.status }, after: { status: 'resolved', resolutionNote: req.body.resolutionNote } });
  broadcast(req.tenant.id, 'incident', dto);
  res.json(dto);
});

app.post('/api/incidents/:id/escalate', requireAuth, resolveTenant, requireTenant, requireModule('incidents'), requireRole('coordinator', 'admin'), validate(incidentEscalateSchema), (req, res) => {
  const incident = db.prepare('SELECT * FROM incidents WHERE tenant_id = ? AND id = ?').get(req.tenant.id, req.params.id);
  if (!incident) return res.status(404).json({ error: 'Incident not found' });
  if (!requireIncidentScope(req, res, incident)) return;

  const now = new Date().toISOString();
  db.prepare('UPDATE incidents SET escalated_to_type = ?, escalated_to_id = ?, escalated_at = ?, urgent = ? WHERE tenant_id = ? AND id = ?')
    .run(req.body.escalatedToType, req.body.escalatedToId || null, now, req.body.urgent ? 1 : incident.urgent, req.tenant.id, incident.id);
  const updated = db.prepare('SELECT * FROM incidents WHERE tenant_id = ? AND id = ?').get(req.tenant.id, incident.id);
  const dto = toIncidentDTO(updated, db.prepare("SELECT * FROM attachments WHERE tenant_id = ? AND entity_type = 'incident' AND entity_id = ?").all(req.tenant.id, incident.id));

  audit({ req, action: 'incident.escalate', entityType: 'incident', entityId: incident.id, after: { escalatedToType: req.body.escalatedToType, escalatedToId: req.body.escalatedToId } });
  broadcast(req.tenant.id, 'incident', dto);
  pushActivity(req.tenant.id, `Incident at ${dto.wardName} — ${dto.stationCode} escalated to ${req.body.escalatedToType} level`, 'alert', req.user.sub);
  res.json(dto);
});

app.get('/api/attachments/:id/file', requireAuth, resolveTenant, requireTenant, (req, res) => {
  const attachment = db.prepare('SELECT * FROM attachments WHERE tenant_id = ? AND id = ?').get(req.tenant.id, req.params.id);
  if (!attachment) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(uploadDir, attachment.storage_path));
});

app.get('/api/activity', requireAuth, resolveTenant, requireTenant, (req, res) => {
  res.json(db.prepare('SELECT * FROM activity WHERE tenant_id = ? ORDER BY at DESC LIMIT 50').all(req.tenant.id));
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

app.get('/api/users', requireAuth, resolveTenant, requireTenant, requireRole('coordinator', 'admin'), (req, res) => {
  let rows = db.prepare(`
    SELECT id, name, email, phone, role, jurisdiction_type, jurisdiction_id, status, created_at FROM users
    WHERE tenant_id = ?
    ORDER BY (status = 'pending') DESC, created_at DESC
  `).all(req.tenant.id);

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

app.post('/api/users/:id/approve', requireAuth, resolveTenant, requireTenant, requireRole('coordinator', 'admin'), validate(approveUserSchema), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND id = ?').get(req.tenant.id, req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.status !== 'pending') return res.status(409).json({ error: 'That account is not pending approval' });

  const { role, jurisdictionType, jurisdictionId } = req.body;
  const resolvedType = role === 'admin' ? 'national' : jurisdictionType;
  const resolvedId = resolvedType === 'national' ? null : jurisdictionId;

  if (!withinTenantCeiling(req.tenant, resolvedType, resolvedId)) {
    return res.status(403).json({ error: `This instance only covers ${jurisdictionLabelFor(req.tenant.jurisdiction_type, req.tenant.jurisdiction_id)}` });
  }
  if (!canApprove(req.user, role, resolvedType, resolvedId)) {
    return res.status(403).json({ error: "You don't have jurisdiction to approve this request" });
  }
  if (resolvedType !== 'national') {
    const table = resolvedType === 'ward' ? 'wards' : resolvedType === 'constituency' ? 'constituencies' : 'counties';
    const found = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(resolvedId);
    if (!found) return res.status(400).json({ error: 'Unknown jurisdiction' });
  }

  db.prepare("UPDATE users SET role = ?, jurisdiction_type = ?, jurisdiction_id = ?, status = 'active' WHERE id = ?").run(role, resolvedType, resolvedId, target.id);
  const updated = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND id = ?').get(req.tenant.id, target.id);

  audit({ req, action: 'user.approve', entityType: 'user', entityId: target.id, before: { status: 'pending' }, after: { status: 'active', role, jurisdictionType: resolvedType, jurisdictionId: resolvedId } });
  res.json({ user: toUserDTO(updated) });
});

app.post('/api/users/:id/decline', requireAuth, resolveTenant, requireTenant, requireRole('coordinator', 'admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND id = ?').get(req.tenant.id, req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.status !== 'pending') return res.status(409).json({ error: 'That account is not pending approval' });
  if (!canApprove(req.user, target.role, target.jurisdiction_type, target.jurisdiction_id)) {
    return res.status(403).json({ error: "You don't have jurisdiction over this request" });
  }
  db.prepare('DELETE FROM users WHERE tenant_id = ? AND id = ?').run(req.tenant.id, target.id);
  audit({ req, action: 'user.decline', entityType: 'user', entityId: target.id, before: { status: 'pending', email: target.email } });
  res.status(204).end();
});

app.patch('/api/users/:id/assignment', requireAuth, resolveTenant, requireTenant, requireRole('coordinator', 'admin'), (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND id = ?').get(req.tenant.id, req.params.id);
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
  if (!withinTenantCeiling(req.tenant, jurisdictionType, jurisdictionId)) {
    return res.status(403).json({ error: `This instance only covers ${jurisdictionLabelFor(req.tenant.jurisdiction_type, req.tenant.jurisdiction_id)}` });
  }
  if (!inScope(req.user, jurisdictionType, jurisdictionId)) {
    return res.status(403).json({ error: 'The destination jurisdiction is outside your scope' });
  }

  if (target.role === 'agent' && target.jurisdiction_id !== jurisdictionId) {
    db.prepare('DELETE FROM stream_agents WHERE tenant_id = ? AND agent_id = ?').run(req.tenant.id, target.id);
  }

  db.prepare('UPDATE users SET jurisdiction_type = ?, jurisdiction_id = ? WHERE id = ?').run(jurisdictionType, jurisdictionId, target.id);
  const updated = db.prepare('SELECT * FROM users WHERE tenant_id = ? AND id = ?').get(req.tenant.id, target.id);

  audit({ req, action: 'user.assignment', entityType: 'user', entityId: target.id, before: { jurisdictionType: target.jurisdiction_type, jurisdictionId: target.jurisdiction_id }, after: { jurisdictionType, jurisdictionId } });
  res.json({ user: toUserDTO(updated) });
});

app.get('/api/audit', requireAuth, resolveTenant, requireTenant, requireModule('audit'), requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY at DESC LIMIT 200').all(req.tenant.id));
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
