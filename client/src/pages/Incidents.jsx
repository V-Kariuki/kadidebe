import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, connectLiveSync, attachmentUrl } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

const EMPTY_FORM = { streamId: '', stationCode: '', wardName: '', note: '', severity: 'low', urgent: false };

export default function Incidents() {
  const { user } = useAuth();
  const location = useLocation();
  const canResolve = user.role === 'coordinator' || user.role === 'admin' || user.role === 'superadmin';
  const [incidents, setIncidents] = useState([]);
  const [streams, setStreams] = useState([]);
  const [form, setForm] = useState({ ...EMPTY_FORM, ...(location.state?.prefill || {}) });
  const [files, setFiles] = useState([]);
  const fileInputRef = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [resolvingId, setResolvingId] = useState(null);
  const [resolveNote, setResolveNote] = useState('');
  const [escalatingId, setEscalatingId] = useState(null);

  useEffect(() => {
    api.incidents().then(setIncidents);
    api.streams().then(setStreams).catch(() => setStreams([]));
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

  function pickStream(streamId) {
    const stream = streams.find((s) => s.id === streamId);
    setForm((f) => ({ ...f, streamId, stationCode: stream?.stationCode || f.stationCode, wardName: stream?.wardName || f.wardName }));
  }

  async function submit(e) {
    e.preventDefault();
    if (!form.note.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      await api.createIncident({ ...form, files });
      setForm(EMPTY_FORM);
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function confirmResolve(id) {
    if (!resolveNote.trim()) return;
    const updated = await api.resolveIncident(id, resolveNote.trim());
    setIncidents((prev) => prev.map((i) => (i.id === id ? updated : i)));
    setResolvingId(null);
    setResolveNote('');
  }

  async function escalate(id, toType) {
    const updated = await api.escalateIncident(id, toType, true);
    setIncidents((prev) => prev.map((i) => (i.id === id ? updated : i)));
    setEscalatingId(null);
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
              <div className={`feed-item ${i.urgent || i.severity === 'high' ? 'alert' : 'info'}`} key={i.id}>
                <div className="feed-dot"></div>
                <div style={{ flex: 1 }}>
                  <div className="feed-text">
                    {i.urgent && <span className="status-badge st-flag" style={{ marginRight: 6 }}>Urgent</span>}
                    {i.escalatedToType && <span className="status-badge st-progress" style={{ marginRight: 6 }}>Escalated to {i.escalatedToType}</span>}
                    <b>{i.wardName} — {i.stationCode}</b> {i.note}
                  </div>
                  <div className="feed-time">{new Date(i.createdAt).toLocaleString()} · {i.status === 'open' ? 'Open' : 'Resolved'}</div>
                  {i.resolutionNote && <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>Resolution: {i.resolutionNote}</div>}
                  {i.attachments?.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                      {i.attachments.map((a) => (
                        a.fileType === 'image'
                          ? <a key={a.id} href={attachmentUrl(a.id)} target="_blank" rel="noreferrer"><img src={attachmentUrl(a.id)} alt="evidence" style={{ width: 48, height: 48, objectFit: 'cover', borderRadius: 6, border: '1px solid var(--line)' }} /></a>
                          : <a key={a.id} href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" className="btn-sm" style={{ fontSize: 10.5 }}>{a.fileType} evidence</a>
                      ))}
                    </div>
                  )}

                  {resolvingId === i.id && (
                    <div className="stack-form" style={{ marginTop: 8 }}>
                      <label>Resolution note (required)</label>
                      <textarea rows="2" value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} placeholder="How was this resolved?" />
                      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                        <button className="btn-sm primary" disabled={!resolveNote.trim()} onClick={() => confirmResolve(i.id)}>Confirm resolve</button>
                        <button className="btn-sm" onClick={() => { setResolvingId(null); setResolveNote(''); }}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {escalatingId === i.id && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      {['constituency', 'county', 'national'].map((t) => (
                        <button key={t} className="btn-sm" onClick={() => escalate(i.id, t)}>{t}</button>
                      ))}
                      <button className="btn-sm" onClick={() => setEscalatingId(null)}>Cancel</button>
                    </div>
                  )}
                </div>
                {i.status === 'open' && canResolve && resolvingId !== i.id && escalatingId !== i.id && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-sm" onClick={() => setEscalatingId(i.id)}>Escalate</button>
                    <button className="btn-sm primary" onClick={() => setResolvingId(i.id)}>Resolve</button>
                  </div>
                )}
              </div>
            ))}
            {incidents.length === 0 && <div className="dim">No incidents logged.</div>}
          </div>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Report an Incident</h2></div>
          <form onSubmit={submit} className="stack-form">
            <label>Stream (optional)</label>
            <select value={form.streamId} onChange={(e) => pickStream(e.target.value)}>
              <option value="">Not tied to a specific stream</option>
              {streams.map((s) => <option key={s.id} value={s.id}>{s.stationCode} — {s.label} ({s.wardName})</option>)}
            </select>
            <label>Station code</label>
            <input value={form.stationCode} onChange={(e) => setForm((f) => ({ ...f, stationCode: e.target.value }))} placeholder="ST-045" />
            <label>Ward</label>
            <input value={form.wardName} onChange={(e) => setForm((f) => ({ ...f, wardName: e.target.value }))} placeholder="Chuka" />
            <label>Severity</label>
            <select value={form.severity} onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}>
              <option value="low">Low</option>
              <option value="high">High</option>
            </select>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, textTransform: 'none', fontSize: 13, marginTop: 10 }}>
              <input type="checkbox" checked={form.urgent} onChange={(e) => setForm((f) => ({ ...f, urgent: e.target.checked }))} style={{ width: 'auto' }} />
              Mark as urgent
            </label>
            <label>Note</label>
            <textarea rows="3" value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="What happened?" required />
            <label>Evidence (photo, video, or audio — up to 5 files)</label>
            <input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*" multiple onChange={(e) => setFiles(Array.from(e.target.files || []).slice(0, 5))} />
            {error && <div className="form-error">{error}</div>}
            <button type="submit" className="primary" disabled={submitting}>{submitting ? 'Submitting…' : 'Submit incident'}</button>
          </form>
        </div>
      </div>
    </>
  );
}
