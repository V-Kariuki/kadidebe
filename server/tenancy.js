import { db } from './db.js';
import { LEVEL, jurisdictionContains, wardIdsForJurisdiction } from './jurisdiction.js';

// ---------------------------------------------------------------------
// Module registry
//
// Each module can be switched off per tenant so an instance sold to, say,
// an MCA candidate isn't carrying presidential tallying UI it will never
// use. `core` modules can't be disabled — without them there's no app.
// `default` is what applies when a tenant has no explicit row, so adding
// a module here later doesn't require backfilling every existing tenant.
// ---------------------------------------------------------------------

export const MODULES = [
  { key: 'stations', label: 'Polling stations & streams', core: true, default: true,
    description: 'The station list and per-stream workflow. Everything else depends on it.' },
  { key: 'process_events', label: 'Process timeline', core: true, default: true,
    description: 'Materials dispatched → polling opened → counting → results declared.' },
  { key: 'ballot_custody', label: 'Ballot box & seal custody', core: false, default: true,
    description: 'Box serials, IEBC/agent seals, closing seals, seal-match checks, re-sealing.' },
  { key: 'booklets', label: 'Ballot booklet tracking', core: false, default: true,
    description: 'Booklet serial ranges and quantities issued, used for reconciliation.' },
  { key: 'turnout', label: 'Live turnout', core: false, default: true,
    description: 'Cumulative voters-processed snapshots while polling is open.' },
  { key: 'results', label: 'Results submission', core: false, default: true,
    description: 'Per-position ballot accounting with photo evidence of the signed form.' },
  { key: 'incidents', label: 'Incident reporting', core: false, default: true,
    description: 'Incident log with photo/video/audio evidence, escalation, and resolution notes.' },
  { key: 'agents', label: 'Agent management', core: false, default: true,
    description: 'Agent roster, check-ins, and stream assignment.' },
  { key: 'reports', label: 'Turnout reports', core: false, default: true,
    description: 'Ward-by-ward turnout breakdown and rankings.' },
  { key: 'audit', label: 'Audit log', core: false, default: true,
    description: 'Immutable record of every action taken in the instance.' }
];

const MODULE_BY_KEY = Object.fromEntries(MODULES.map((m) => [m.key, m]));

export function modulesForTenant(tenantId) {
  const rows = tenantId
    ? db.prepare('SELECT module_key, enabled FROM tenant_modules WHERE tenant_id = ?').all(tenantId)
    : [];
  const overrides = Object.fromEntries(rows.map((r) => [r.module_key, !!r.enabled]));
  const out = {};
  for (const m of MODULES) {
    out[m.key] = m.core ? true : (m.key in overrides ? overrides[m.key] : m.default);
  }
  return out;
}

export function tenantHasModule(tenantId, key) {
  const mod = MODULE_BY_KEY[key];
  if (!mod) return false;
  if (mod.core) return true;
  const row = db.prepare('SELECT enabled FROM tenant_modules WHERE tenant_id = ? AND module_key = ?').get(tenantId, key);
  return row ? !!row.enabled : mod.default;
}

// Express guard. Superadmins bypass module gating entirely — they operate
// above tenants and need to be able to inspect any instance.
export function requireModule(key) {
  return (req, res, next) => {
    if (req.user?.role === 'superadmin') return next();
    if (!req.tenant) return res.status(403).json({ error: 'No tenant context' });
    if (!tenantHasModule(req.tenant.id, key)) {
      const label = MODULE_BY_KEY[key]?.label || key;
      return res.status(403).json({ error: `The ${label} module is not enabled for this instance` });
    }
    next();
  };
}

// ---------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------

export function positionIdsForTenant(tenantId) {
  const rows = db.prepare('SELECT position_id FROM tenant_positions WHERE tenant_id = ?').all(tenantId);
  // No rows means "all positions" — the sensible default for a full-slate
  // campaign, and it keeps a freshly created tenant immediately usable.
  if (rows.length === 0) return null;
  return rows.map((r) => r.position_id);
}

export function tenantTracksPosition(tenantId, positionId) {
  const allowed = positionIdsForTenant(tenantId);
  return allowed === null || allowed.includes(positionId);
}

// ---------------------------------------------------------------------
// Tenant resolution + jurisdiction ceiling
// ---------------------------------------------------------------------

export function getTenant(tenantId) {
  if (!tenantId) return null;
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantId) || null;
}

// Attaches req.tenant. A superadmin has no tenant of their own but may
// act inside one by passing ?tenantId= / X-Tenant-Id, which is how the
// platform console inspects a client instance.
export function resolveTenant(req, res, next) {
  if (!req.user) return next();

  if (req.user.role === 'superadmin') {
    const impersonated = req.headers['x-tenant-id'] || req.query.tenantId || null;
    req.tenant = impersonated ? getTenant(impersonated) : null;
    return next();
  }

  const tenant = getTenant(req.user.tenantId);
  if (!tenant) return res.status(403).json({ error: 'Your account is not attached to an instance' });
  if (tenant.status !== 'active') return res.status(403).json({ error: 'This instance is suspended. Contact your administrator.' });
  req.tenant = tenant;
  next();
}

export function requireTenant(req, res, next) {
  if (!req.tenant) return res.status(400).json({ error: 'This action requires an instance context' });
  next();
}

export function requireSuperadmin(req, res, next) {
  if (req.user?.role !== 'superadmin') return res.status(403).json({ error: 'Platform administrator access required' });
  next();
}

// The effective geographic scope: a user can never see outside their
// tenant's ceiling, even if their own jurisdiction is broader. Returns an
// array of ward ids, or null meaning "everything" (only possible when both
// tenant ceiling and user jurisdiction are national).
export function effectiveWardIds(user, tenant) {
  const userWards = user.jurisdictionType === 'national' || user.role === 'superadmin'
    ? null
    : wardIdsForJurisdiction(user.jurisdictionType, user.jurisdictionId);

  const tenantWards = !tenant || tenant.jurisdiction_type === 'national'
    ? null
    : wardIdsForJurisdiction(tenant.jurisdiction_type, tenant.jurisdiction_id);

  if (userWards === null) return tenantWards;
  if (tenantWards === null) return userWards;
  const tenantSet = new Set(tenantWards);
  return userWards.filter((w) => tenantSet.has(w));
}

// Is a jurisdiction node within the tenant's ceiling?
export function withinTenantCeiling(tenant, targetType, targetId) {
  if (!tenant || tenant.jurisdiction_type === 'national') return true;
  if (targetType === 'national') return false; // can't act nationally inside a capped instance
  return jurisdictionContains(tenant.jurisdiction_type, tenant.jurisdiction_id, targetType, targetId);
}

// Combined check used by write paths: the actor's own jurisdiction must
// contain the target AND the target must sit within the tenant ceiling.
export function inTenantScope(user, tenant, targetType, targetId) {
  if (!withinTenantCeiling(tenant, targetType, targetId)) return false;
  if (user.role === 'superadmin' || user.role === 'admin') return true;
  if (!user.jurisdictionType) return false;
  if (targetType == null || targetId == null) return user.jurisdictionType === 'national';
  return jurisdictionContains(user.jurisdictionType, user.jurisdictionId, targetType, targetId);
}

// The jurisdiction levels a tenant's own admin may assign to users —
// never broader than the instance ceiling.
export function assignableLevelsForTenant(tenant) {
  const order = ['national', 'county', 'constituency', 'ward'];
  if (!tenant || tenant.jurisdiction_type === 'national') return order;
  return order.slice(order.indexOf(tenant.jurisdiction_type));
}

export function tenantDTO(t, includeConfig = false) {
  if (!t) return null;
  const base = {
    id: t.id, name: t.name, slug: t.slug,
    jurisdictionType: t.jurisdiction_type, jurisdictionId: t.jurisdiction_id,
    jurisdictionLabel: jurisdictionLabelFor(t.jurisdiction_type, t.jurisdiction_id),
    status: t.status, contactEmail: t.contact_email, notes: t.notes, createdAt: t.created_at
  };
  if (!includeConfig) return base;
  return {
    ...base,
    modules: modulesForTenant(t.id),
    positionIds: positionIdsForTenant(t.id),
    userCount: db.prepare('SELECT COUNT(*) n FROM users WHERE tenant_id = ?').get(t.id).n
  };
}

export function jurisdictionLabelFor(type, id) {
  if (!type || type === 'national') return 'National';
  const table = type === 'ward' ? 'wards' : type === 'constituency' ? 'constituencies' : 'counties';
  const row = db.prepare(`SELECT name FROM ${table} WHERE id = ?`).get(id);
  return row ? row.name : '—';
}

export { LEVEL };
