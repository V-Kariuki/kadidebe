import { useEffect, useState } from 'react';
import { api } from '../api.js';

const ROLE_LABEL = { admin: 'Admin', coordinator: 'Coordinator', agent: 'Agent', aspirant: 'Aspirant' };
const JURISDICTION_LABEL = { ward: 'Ward', constituency: 'Constituency', county: 'County', national: 'National' };

export default function Users() {
  const [users, setUsers] = useState(null);
  const [geo, setGeo] = useState(null);
  const [drafts, setDrafts] = useState({}); // userId -> { role, jurisdictionType, jurisdictionId }
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.users().then(setUsers);
    api.publicGeo().then(setGeo).catch(() => setGeo({ counties: [], constituencies: [], wards: [] }));
  }, []);

  function draftFor(u) {
    return drafts[u.id] || { role: u.role, jurisdictionType: u.jurisdictionType, jurisdictionId: u.jurisdictionId || '' };
  }

  function updateDraft(id, patch) {
    setDrafts((d) => ({ ...d, [id]: { ...draftFor(users.find((u) => u.id === id)), ...d[id], ...patch } }));
  }

  function jurisdictionOptions(type) {
    if (!geo) return [];
    if (type === 'ward') return geo.wards;
    if (type === 'constituency') return geo.constituencies;
    if (type === 'county') return geo.counties;
    return [];
  }

  async function approve(u) {
    setError('');
    setBusyId(u.id);
    const d = draftFor(u);
    try {
      const res = await api.approveUser(u.id, {
        role: d.role,
        jurisdictionType: d.role === 'admin' ? 'national' : d.role === 'agent' ? 'ward' : d.jurisdictionType,
        jurisdictionId: d.role === 'admin' || d.jurisdictionType === 'national' ? null : d.jurisdictionId
      });
      setUsers((list) => list.map((x) => (x.id === u.id ? res.user : x)));
    } catch (err) {
      setError(err.message || 'Could not approve account');
    } finally {
      setBusyId(null);
    }
  }

  async function decline(id) {
    setError('');
    setBusyId(id);
    try {
      await api.declineUser(id);
      setUsers((list) => list.filter((u) => u.id !== id));
    } catch (err) {
      setError(err.message || 'Could not decline account');
    } finally {
      setBusyId(null);
    }
  }

  if (!users) return <div className="screen-loading">Loading users…</div>;

  const pending = users.filter((u) => u.status === 'pending');
  const active = users.filter((u) => u.status !== 'pending');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Users</h1>
          <p>{active.length} accounts in your jurisdiction · admin, coordinator, and agent roles</p>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h2>Pending requests</h2>
            <span className="sub">{pending.length} waiting for approval</span>
          </div>
          {error && <div className="form-error" style={{ marginBottom: 10 }}>{error}</div>}
          <table>
            <thead><tr><th>Name</th><th>Email</th><th>Requested</th><th>Role</th><th>Level</th><th>Jurisdiction</th><th></th></tr></thead>
            <tbody>
              {pending.map((u) => {
                const d = draftFor(u);
                return (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td className="mono dim">{u.email}</td>
                    <td className="dim">{new Date(u.createdAt + 'Z').toLocaleDateString()}</td>
                    <td>
                      <select value={d.role} onChange={(e) => updateDraft(u.id, { role: e.target.value })}>
                        <option value="agent">Agent</option>
                        <option value="coordinator">Coordinator</option>
                        <option value="aspirant">Aspirant</option>
                        <option value="admin">Admin</option>
                      </select>
                    </td>
                    <td>
                      {d.role === 'admin' ? <span className="dim">National</span> : d.role === 'agent' ? <span className="dim">Ward</span> : (
                        <select value={d.jurisdictionType} onChange={(e) => updateDraft(u.id, { jurisdictionType: e.target.value, jurisdictionId: '' })}>
                          <option value="ward">Ward</option>
                          <option value="constituency">Constituency</option>
                          <option value="county">County</option>
                          <option value="national">National</option>
                        </select>
                      )}
                    </td>
                    <td>
                      {d.role !== 'admin' && d.jurisdictionType !== 'national' ? (
                        <select value={d.jurisdictionId} onChange={(e) => updateDraft(u.id, { jurisdictionId: e.target.value })}>
                          <option value="">Select…</option>
                          {jurisdictionOptions(d.jurisdictionType).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                        </select>
                      ) : <span className="dim">—</span>}
                    </td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn-sm primary"
                        disabled={busyId === u.id || (d.role !== 'admin' && d.jurisdictionType !== 'national' && !d.jurisdictionId)}
                        onClick={() => approve(u)}
                      >
                        {busyId === u.id ? 'Working…' : 'Approve'}
                      </button>
                      <button className="btn-sm" disabled={busyId === u.id} onClick={() => decline(u.id)}>Decline</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Jurisdiction</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {active.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="mono dim">{u.email}</td>
                <td><span className={`status-badge ${u.role === 'admin' ? 'st-flag' : u.role === 'coordinator' ? 'st-done' : 'idle'}`}>{ROLE_LABEL[u.role]}</span></td>
                <td>{JURISDICTION_LABEL[u.jurisdictionType] || '—'}{u.jurisdictionLabel ? ` — ${u.jurisdictionLabel}` : ''}</td>
                <td><span className={`status-badge ${u.status === 'active' ? 'active' : 'idle'}`}>{u.status}</span></td>
                <td className="dim">{new Date(u.createdAt + 'Z').toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
