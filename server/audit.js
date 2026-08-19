import { nanoid } from 'nanoid';
import { db } from './db.js';

const insert = db.prepare(`
  INSERT INTO audit_log (id, actor_id, actor_email, action, entity_type, entity_id, before_json, after_json, ip, at)
  VALUES (@id, @actor_id, @actor_email, @action, @entity_type, @entity_id, @before_json, @after_json, @ip, datetime('now'))
`);

export function audit({ req, action, entityType, entityId, before, after }) {
  insert.run({
    id: nanoid(),
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
