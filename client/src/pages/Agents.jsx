import { useEffect, useState } from 'react';
import { api, connectLiveSync } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

export default function Agents() {
  const { user } = useAuth();
  const isStaff = user.role === 'coordinator' || user.role === 'admin' || user.role === 'superadmin';
  const [agents, setAgents] = useState([]);
  const [streams, setStreams] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [assigningId, setAssigningId] = useState(null);
  const [error, setError] = useState('');

  function reload() {
    api.agents().then(setAgents);
    if (isStaff) api.streams().then(setStreams).catch(() => setStreams([]));
  }

  useEffect(() => {
    reload();
    const socket = connectLiveSync((msg) => {
      if (msg.type === 'agent_update') {
        setAgents((prev) => prev.map((a) => (a.id === msg.payload.id ? msg.payload : a)));
      }
      if (msg.type === 'stream_update' && isStaff) {
        api.streams().then(setStreams).catch(() => {});
      }
    });
    return () => socket.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function toggle(agent) {
    setBusyId(agent.id);
    const next = agent.status === 'active' ? 'idle' : 'active';
    try {
      const updated = await api.setAgentStatus(agent.id, next);
      setAgents((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
    } finally {
      setBusyId(null);
    }
  }

  async function assignToStream(agent, streamId) {
    if (!streamId) return;
    setBusyId(agent.id); setError('');
    try {
      await api.addStreamAgent(streamId, agent.id);
      reload();
      setAssigningId(null);
    } catch (err) { setError(err.message); } finally { setBusyId(null); }
  }

  const wardStreamsFor = (agent) => streams.filter((s) => s.wardId === agent.wardId);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Field Agents</h1>
          <p>{agents.filter((a) => a.status === 'active').length} active of {agents.length} · check-ins sync live</p>
        </div>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr><th>Agent</th><th>Home ward</th><th>Assigned streams</th><th>Phone</th><th>Last check-in</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td><div className="agent-name"><div className="mini-avatar"></div>{a.name}</div></td>
                <td>{a.wardName}</td>
                <td className="dim">
                  {a.streamLabels?.length ? a.streamLabels.join(', ') : 'Unassigned'}
                  {isStaff && assigningId === a.id && (
                    <div style={{ marginTop: 6 }}>
                      <select onChange={(e) => assignToStream(a, e.target.value)} disabled={busyId === a.id} defaultValue="">
                        <option value="" disabled>Pick a stream…</option>
                        {wardStreamsFor(a).map((s) => <option key={s.id} value={s.id}>{s.stationCode} — {s.label}</option>)}
                      </select>
                      <button className="btn-sm" style={{ marginLeft: 6 }} onClick={() => setAssigningId(null)}>Cancel</button>
                    </div>
                  )}
                </td>
                <td className="mono dim">{a.phone}</td>
                <td className="dim">{a.lastCheckIn ? new Date(a.lastCheckIn).toLocaleTimeString() : '—'}</td>
                <td><span className={`status-badge ${a.status}`}>{a.status === 'active' ? 'Active' : 'Idle'}</span></td>
                <td style={{ display: 'flex', gap: 6 }}>
                  <button className="btn-sm" disabled={busyId === a.id} onClick={() => toggle(a)}>
                    {a.status === 'active' ? 'Mark idle' : 'Check in'}
                  </button>
                  {isStaff && assigningId !== a.id && (
                    <button className="btn-sm" disabled={busyId === a.id} onClick={() => setAssigningId(a.id)}>Assign station</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
