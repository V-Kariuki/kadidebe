import { useEffect, useState } from 'react';
import { api, connectLiveSync } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

export default function Incidents() {
  const { user } = useAuth();
  const canResolve = user.role === 'coordinator' || user.role === 'admin';
  const [incidents, setIncidents] = useState([]);
  const [form, setForm] = useState({ stationCode: '', wardName: '', note: '', severity: 'low' });
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.incidents().then(setIncidents);
    const socket = connectLiveSync((msg) => {
      if (msg.type === 'incident') {
        setIncidents((prev) => {
          const exists = prev.some((i) => i.id === msg.payload.id);
          return exists ? prev.map((i) => (i.id === msg.payload.id ? msg.payload : i)) : [msg.payload, ...prev];
        });
      }
    });
    return () => socket.close();
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (!form.note.trim()) return;
    setSubmitting(true);
    try {
      await api.createIncident(form);
      setForm({ stationCode: '', wardName: '', note: '', severity: 'low' });
    } finally {
      setSubmitting(false);
    }
  }

  async function resolve(id) {
    await api.resolveIncident(id);
    setIncidents((prev) => prev.map((i) => (i.id === id ? { ...i, status: 'resolved' } : i)));
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Incidents</h1>
          <p>{incidents.filter((i) => i.status === 'open').length} open · flag anything that needs review</p>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head"><h2>Log</h2></div>
          <div className="feed">
            {incidents.map((i) => (
              <div className={`feed-item ${i.severity === 'high' ? 'alert' : 'info'}`} key={i.id}>
                <div className="feed-dot"></div>
                <div style={{ flex: 1 }}>
                  <div className="feed-text"><b>{i.wardName} — {i.stationCode}</b> {i.note}</div>
                  <div className="feed-time">{new Date(i.createdAt).toLocaleString()} · {i.status === 'open' ? 'Open' : 'Resolved'}</div>
                </div>
                {i.status === 'open' && canResolve && (
                  <button className="btn-sm" onClick={() => resolve(i.id)}>Resolve</button>
                )}
              </div>
            ))}
            {incidents.length === 0 && <div className="dim">No incidents logged.</div>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Report an Incident</h2></div>
          <form onSubmit={submit} className="stack-form">
            <label>Station code</label>
            <input value={form.stationCode} onChange={(e) => setForm((f) => ({ ...f, stationCode: e.target.value }))} placeholder="ST-045" />
            <label>Ward</label>
            <input value={form.wardName} onChange={(e) => setForm((f) => ({ ...f, wardName: e.target.value }))} placeholder="Chuka" />
            <label>Severity</label>
            <select value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}>
              <option value="low">Low</option>
              <option value="high">High</option>
            </select>
            <label>Note</label>
            <textarea rows="3" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="What happened?" required />
            <button type="submit" className="primary" disabled={submitting}>{submitting ? 'Submitting…' : 'Submit incident'}</button>
          </form>
        </div>
      </div>
    </>
  );
}
