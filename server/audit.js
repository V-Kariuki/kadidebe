import { nanoid } from 'nanoid';
import { db } from './db.js';

const insert = db.prepare(`
  INSERT INTO audit_log (id, tenant_id, actor_id, actor_email, action, entity_type, entity_id, before_json, after_json, ip, at)
  VALUES (@id, @tenant_id, @actor_id, @actor_email, @action, @entity_type, @entity_id, @before_json, @after_json, @ip, datetime('now'))
`);

// tenantId is taken from the resolved request context. Platform-level
// superadmin actions (creating an instance, toggling its modules) pass an
// explicit tenantId so the entry lands in the audit trail of the instance
// being acted upon, which is where an auditor would look for it.
export function audit({ req, action, entityType, entityId, before, after, tenantId }) {
  const resolved = tenantId !== undefined ? tenantId : (req.tenant?.id || req.user?.tenantId || null);
  insert.run({
    id: nanoid(),
    tenant_id: resolved,
    actor_id: req.user?.sub || null,
    actor_email: req.user?.email || null,
    action,
    entity_type: entityType,
    entity_id: entityId,
    before_json: before !== undefined ? JSON.stringify(before) : null,
    after_json: after !== undefined ? JSON.stringify(after) : null,
    ip: req.ip
  });
}
