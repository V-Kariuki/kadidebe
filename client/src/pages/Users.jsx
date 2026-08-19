import { useEffect, useState } from 'react';
import { api } from '../api.js';

const ROLE_LABEL = { admin: 'Admin', coordinator: 'Coordinator', agent: 'Agent' };
const ASSIGNABLE_ROLES = ['agent', 'coordinator', 'admin'];

export default function Users() {
  const [users, setUsers] = useState(null);
  const [wards, setWards] = useState([]);
  const [drafts, setDrafts] = useState({}); // userId -> { role, wardId }
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.users().then(setUsers);
    api.wards().then(setWards).catch(() => setWards([]));
  }, []);

  function draftFor(id) {
    return drafts[id] || { role: 'agent', wardId: '' };
  }

  function updateDraft(id, patch) {
    setDrafts((d) => ({ ...d, [id]: { ...draftFor(id), ...patch } }));
  }

  async function approve(id) {
    setError('');
    setBusyId(id);
    const { role, wardId } = draftFor(id);
    try {
      const res = await api.approveUser(id, role, role === 'agent' ? wardId || null : null);
      setUsers((list) => list.map((u) => (u.id === id ? res.user : u)));
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
          <p>{active.length} accounts · admin, coordinator, and per-ward agent roles</p>
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
            <thead><tr><th>Name</th><th>Email</th><th>Requested</th><th>Assign role</th><th>Ward</th><th></th></tr></thead>
            <tbody>
              {pending.map((u) => {
                const draft = draftFor(u.id);
                return (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td className="mono dim">{u.email}</td>
                    <td className="dim">{new Date(u.createdAt + 'Z').toLocaleDateString()}</td>
                    <td>
                      <select value={draft.role} onChange={(e) => updateDraft(u.id, { role: e.target.value })}>
                        {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                    </td>
                    <td>
                      {draft.role === 'agent' ? (
                        <select value={draft.wardId} onChange={(e) => updateDraft(u.id, { wardId: e.target.value })}>
                          <option value="">Select ward…</option>
                          {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                        </select>
                      ) : <span className="dim">—</span>}
                    </td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn-sm primary"
                        disabled={busyId === u.id || (draft.role === 'agent' && !draft.wardId)}
                        onClick={() => approve(u.id)}
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
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Ward</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            {active.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="mono dim">{u.email}</td>
                <td><span className={`status-badge ${u.role === 'admin' ? 'st-flag' : u.role === 'coordinator' ? 'st-done' : 'idle'}`}>{ROLE_LABEL[u.role]}</span></td>
                <td>{u.wardName || '—'}</td>
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
