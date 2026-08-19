import { useEffect, useState } from 'react';
import { api, connectLiveSync } from '../api.js';

export default function Agents() {
  const [agents, setAgents] = useState([]);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    api.agents().then(setAgents);
    const socket = connectLiveSync((msg) => {
      if (msg.type === 'agent_update') {
        setAgents((prev) => prev.map((a) => (a.id === msg.payload.id ? msg.payload : a)));
      }
    });
    return () => socket.close();
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

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Field Agents</h1>
          <p>{agents.filter((a) => a.status === 'active').length} active of {agents.length} · check-ins sync live</p>
        </div>
      </div>

      <div className="panel">
        <table>
          <thead>
            <tr><th>Agent</th><th>Ward</th><th>Phone</th><th>Last check-in</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id}>
                <td><div className="agent-name"><div className="mini-avatar"></div>{a.name}</div></td>
                <td>{a.wardName}</td>
                <td className="mono dim">{a.phone}</td>
                <td className="dim">{new Date(a.lastCheckIn).toLocaleTimeString()}</td>
                <td><span className={`status-badge ${a.status}`}>{a.status === 'active' ? 'Active' : 'Idle'}</span></td>
                <td>
                  <button className="btn-sm" disabled={busyId === a.id} onClick={() => toggle(a)}>
                    {a.status === 'active' ? 'Mark idle' : 'Check in'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
