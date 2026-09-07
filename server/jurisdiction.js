import { db } from './db.js';

export const LEVEL = { ward: 0, constituency: 1, county: 2, national: 3 };

export function resolveWardChain(wardId) {
  const ward = db.prepare('SELECT id, constituency_id FROM wards WHERE id = ?').get(wardId);
  if (!ward) return null;
  const constituency = ward.constituency_id
    ? db.prepare('SELECT id, county_id FROM constituencies WHERE id = ?').get(ward.constituency_id)
    : null;
  return {
    wardId: ward.id,
    constituencyId: constituency?.id || null,
    countyId: constituency?.county_id || null
  };
}

export function resolveConstituencyChain(constituencyId) {
  const constituency = db.prepare('SELECT id, county_id FROM constituencies WHERE id = ?').get(constituencyId);
  if (!constituency) return null;
  return { constituencyId: constituency.id, countyId: constituency.county_id || null };
}

// Does the jurisdiction node (containerType, containerId) contain the node
// (targetType, targetId)? 'national' contains everything. A node always
// contains itself.
export function jurisdictionContains(containerType, containerId, targetType, targetId) {
  if (containerType === 'national') return true;
  if (containerType === targetType) return String(containerId) === String(targetId);

  if (containerType === 'county') {
    if (targetType === 'constituency') {
      const chain = resolveConstituencyChain(targetId);
      return !!chain && String(chain.countyId) === String(containerId);
    }
    if (targetType === 'ward') {
      const chain = resolveWardChain(targetId);
      return !!chain && String(chain.countyId) === String(containerId);
    }
  }

  if (containerType === 'constituency') {
    if (targetType === 'ward') {
      const chain = resolveWardChain(targetId);
      return !!chain && String(chain.constituencyId) === String(containerId);
    }
  }

  return false;
}

// Is `viewer` allowed to see/manage something scoped to (targetType, targetId)?
// True for admins, for national-scoped coordinators, or when the viewer's
// own jurisdiction contains (or equals) the target.
export function inScope(viewer, targetType, targetId) {
  if (viewer.role === 'admin') return true;
  if (!viewer.jurisdictionType) return false;
  if (targetType == null || targetId == null) return viewer.jurisdictionType === 'national';
  return jurisdictionContains(viewer.jurisdictionType, viewer.jurisdictionId, targetType, targetId);
}

// Can `approver` approve a pending registration requesting `requestedRole`
// at (requestedJurisdictionType, requestedJurisdictionId)?
//  - admin: always.
//  - coordinator approving an agent request: needs the agent's ward inside
//    (or equal to, for a ward coordinator) their own jurisdiction.
//  - coordinator approving a coordinator request: needs strictly higher
//    jurisdiction level, containing the requested jurisdiction.
//  - nobody but admin approves a request for the admin role.
export function canApprove(approver, requestedRole, requestedJurisdictionType, requestedJurisdictionId) {
  if (approver.role === 'admin') return true;
  if (approver.role !== 'coordinator') return false;

  if (requestedRole === 'agent') {
    return jurisdictionContains(approver.jurisdictionType, approver.jurisdictionId, 'ward', requestedJurisdictionId);
  }

  if (requestedRole === 'coordinator' || requestedRole === 'aspirant') {
    if (requestedJurisdictionType === 'national') return false; // only admin approves national-level requests
    if (LEVEL[approver.jurisdictionType] <= LEVEL[requestedJurisdictionType]) return false;
    return jurisdictionContains(approver.jurisdictionType, approver.jurisdictionId, requestedJurisdictionType, requestedJurisdictionId);
  }

  return false;
}

// Can `assigner` change a subordinate's jurisdiction/role assignment?
// Nobody reassigns themselves, ever. Otherwise the rule branches by the
// target's role — an agent shares the same jurisdiction *level* (ward) as
// a ward coordinator, but is still their subordinate, so any coordinator
// (ward level or above) whose jurisdiction contains the agent's ward can
// reassign them. A coordinator, though, can only be reassigned by a
// STRICTLY higher jurisdiction level (so a ward coordinator can never
// reassign another ward coordinator — that needs constituency level or
// above), and only within that superior's own jurisdiction subtree.
export function canReassign(assigner, target) {
  if (assigner.id === target.id || assigner.sub === target.id) return false;
  if (assigner.role === 'admin') return true;
  if (assigner.role !== 'coordinator') return false;

  if (target.role === 'agent') {
    return jurisdictionContains(assigner.jurisdictionType, assigner.jurisdictionId, 'ward', target.jurisdiction_id);
  }

  if (target.role === 'coordinator' || target.role === 'aspirant') {
    if (LEVEL[assigner.jurisdictionType] <= LEVEL[target.jurisdiction_type]) return false;
    return jurisdictionContains(assigner.jurisdictionType, assigner.jurisdictionId, target.jurisdiction_type, target.jurisdiction_id);
  }

  return false;
}

// Every ward id within an arbitrary jurisdiction node (not necessarily the
// viewer's own) — the general-purpose version wardIdsInScope wraps.
export function wardIdsForJurisdiction(type, id) {
  if (type === 'national') return null;
  if (type === 'ward') return [id];
  if (type === 'constituency') {
    return db.prepare('SELECT id FROM wards WHERE constituency_id = ?').all(id).map((w) => w.id);
  }
  if (type === 'county') {
    const constituencies = db.prepare('SELECT id FROM constituencies WHERE county_id = ?').all(id).map((c) => c.id);
    if (constituencies.length === 0) return [];
    const placeholders = constituencies.map(() => '?').join(',');
    return db.prepare(`SELECT id FROM wards WHERE constituency_id IN (${placeholders})`).all(...constituencies).map((w) => w.id);
  }
  return [];
}

// Every ward id within a viewer's scope. Returns null to mean "all wards"
// (national scope / admin) rather than materializing the whole table.
export function wardIdsInScope(viewer) {
  if (viewer.role === 'admin' || viewer.jurisdictionType === 'national') return null;
  return wardIdsForJurisdiction(viewer.jurisdictionType, viewer.jurisdictionId);
}
