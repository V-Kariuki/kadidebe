import { useEffect, useState } from 'react';
import { api, connectLiveSync } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

const STATUS_LABEL = { done: 'Reported', progress: 'Tallying', pending: 'Pending', flag: 'Flagged' };
const WARD_FILTER_ALL = 'All wards';

export default function Stations() {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const [stations, setStations] = useState([]);
  const [wardOptions, setWardOptions] = useState([]);
  const [wardFilter, setWardFilter] = useState(WARD_FILTER_ALL);

  const [editing, setEditing] = useState(null); // results edit (votesCast/status)
  const [draft, setDraft] = useState({ votesCast: 0, status: 'progress' });
  const [saving, setSaving] = useState(false);

  const [structEditing, setStructEditing] = useState(null); // admin structural edit (code/ward/registered)
  const [structDraft, setStructDraft] = useState({ code: '', wardId: '', registered: '' });
  const [structBusy, setStructBusy] = useState(false);

  const [error, setError] = useState('');

  useEffect(() => {
    api.stations().then(setStations);
    if (isAdmin) api.wards().then(setWardOptions);
    const socket = connectLiveSync((msg) => {
      if (msg.type === 'station_update') {
        setStations((prev) => {
          const exists = prev.some((s) => s.id === msg.payload.id);
          return exists ? prev.map((s) => (s.id === msg.payload.id ? msg.payload : s)) : [...prev, msg.payload];
        });
      }
      if (msg.type === 'station_delete') {
        setStations((prev) => prev.filter((s) => s.id !== msg.payload.id));
      }
    });
    return () => socket.close();
  }, [isAdmin]);

  const wards = [WARD_FILTER_ALL, ...Array.from(new Set(stations.map((s) => s.wardName)))];
  const visible = stations.filter((s) => wardFilter === WARD_FILTER_ALL || s.wardName === wardFilter);

  function canEdit(station) {
    if (user.role === 'coordinator' || user.role === 'admin') return true;
    return station.assignedAgentId === user.id;
  }

  function startEdit(station) {
    setError('');
    setEditing(station.id);
    setDraft({ votesCast: station.votesCast, status: station.status === 'pending' ? 'progress' : station.status });
  }

  async function saveEdit(station) {
    setSaving(true);
    setError('');
    try {
      const updated = await api.submitResult(station.id, {
        votesCast: Number(draft.votesCast),
        status: draft.status
      });
      setStations((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setEditing(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function startStructEdit(station) {
    setError('');
    setStructEditing(station.id);
    setStructDraft({ code: station.code, wardId: station.wardId, registered: String(station.registered) });
  }

  async function saveStructEdit(station) {
    setStructBusy(true);
    setError('');
    try {
      const updated = await api.updateStation(station.id, {
        code: structDraft.code.trim(),
        wardId: structDraft.wardId,
        registered: Number(structDraft.registered)
      });
      setStations((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setStructEditing(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setStructBusy(false);
    }
  }

  async function removeStation(station) {
    if (!window.confirm(`Remove station ${station.code}? This deletes its recorded results too.`)) return;
    setStructBusy(true);
    setError('');
    try {
      await api.deleteStation(station.id);
      setStations((prev) => prev.filter((s) => s.id !== station.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setStructBusy(false);
    }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Polling Stations</h1>
          <p>{stations.length} stations{user.role === 'agent' ? ' assigned to you' : ''} · submitting a result broadcasts live</p>
        </div>
        {wards.length > 2 && (
          <select className="ward-select" value={wardFilter} onChange={(e) => setWardFilter(e.target.value)}>
            {wards.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        )}
      </div>

      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="panel">
        <table>
          <thead>
            <tr>
              <th>Station</th><th>Ward</th><th>Registered</th><th>Votes Cast</th><th>Status</th><th>Updated</th><th></th>
              {isAdmin && <th></th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => (
              <tr key={s.id}>
                {structEditing === s.id ? (
                  <>
                    <td className="mono"><input value={structDraft.code} onChange={(e) => setStructDraft((d) => ({ ...d, code: e.target.value }))} className="inline-input" /></td>
                    <td>
                      <select value={structDraft.wardId} onChange={(e) => setStructDraft((d) => ({ ...d, wardId: e.target.value }))}>
                        {wardOptions.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                      </select>
                    </td>
                    <td className="mono">
                      <input
                        type="number" min={s.votesCast}
                        value={structDraft.registered}
                        onChange={(e) => setStructDraft((d) => ({ ...d, registered: e.target.value }))}
                        className="inline-input"
                      />
                    </td>
                    <td className="mono dim">{s.votesCast}</td>
                    <td><span className={`status-badge st-${s.status}`}>{STATUS_LABEL[s.status]}</span></td>
                    <td className="dim">{new Date(s.lastUpdated).toLocaleTimeString()}</td>
                    <td></td>
                    <td style={{ display: 'flex', gap: 6 }}>
                      <button className="btn-sm primary" disabled={structBusy} onClick={() => saveStructEdit(s)}>Save</button>
                      <button className="btn-sm" onClick={() => setStructEditing(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="mono">{s.code}</td>
                    <td>{s.wardName}</td>
                    <td className="mono">{s.registered}</td>
                    <td className="mono">
                      {editing === s.id ? (
                        <input
                          type="number" min="0" max={s.registered}
                          value={draft.votesCast}
                          onChange={(e) => setDraft((d) => ({ ...d, votesCast: e.target.value }))}
                          className="inline-input"
                        />
                      ) : s.votesCast}
                    </td>
                    <td>
                      {editing === s.id ? (
                        <select value={draft.status} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}>
                          <option value="progress">Tallying</option>
                          <option value="done">Reported</option>
                          <option value="flag">Flagged</option>
                        </select>
                      ) : (
                        <span className={`status-badge st-${s.status}`}>{STATUS_LABEL[s.status]}</span>
                      )}
                    </td>
                    <td className="dim">{new Date(s.lastUpdated).toLocaleTimeString()}</td>
                    <td>
                      {!canEdit(s) ? null : editing === s.id ? (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="btn-sm primary" disabled={saving} onClick={() => saveEdit(s)}>Save</button>
                          <button className="btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      ) : (
                        <button className="btn-sm" onClick={() => startEdit(s)}>Update</button>
                      )}
                    </td>
                    {isAdmin && (
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-sm" disabled={structBusy} onClick={() => startStructEdit(s)}>Edit</button>
                        <button className="btn-sm" disabled={structBusy} onClick={() => removeStation(s)}>Remove</button>
                      </td>
                    )}
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
