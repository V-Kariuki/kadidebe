import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function AuditLog() {
  const [rows, setRows] = useState(null);

  useEffect(() => { api.auditLog().then(setRows); }, []);

  if (!rows) return <div className="screen-loading">Loading audit log…</div>;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Audit Log</h1>
          <p>Last {rows.length} actions · immutable record of every account and tally change</p>
        </div>
      </div>

      <div className="panel">
        <table>
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Before → After</th><th>IP</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="dim mono">{new Date(r.at + 'Z').toLocaleString()}</td>
                <td>{r.actor_email || '—'}</td>
                <td><span className="status-badge st-progress">{r.action}</span></td>
                <td className="mono dim">{r.entity_type}:{r.entity_id.slice(0, 8)}</td>
                <td className="mono dim" style={{ fontSize: 11 }}>
                  {r.before_json ? r.before_json.slice(0, 40) : '—'} {r.after_json ? '→ ' + r.after_json.slice(0, 40) : ''}
                </td>
                <td className="mono dim">{r.ip}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
