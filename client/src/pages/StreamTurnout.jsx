import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';

export default function StreamTurnout() {
  const { id } = useParams();
  const [stream, setStream] = useState(null);
  const [error, setError] = useState('');
  function reload() { api.streamDetail(id).then(setStream).catch((e) => setError(e.message)); }
  useEffect(reload, [id]);

  if (error) return <div className="form-error" style={{ margin: 24 }}>{error}</div>;
  if (!stream) return <div className="screen-loading">Loading…</div>;

  const has = (t) => stream.events.some((e) => e.eventType === t);
  const open = has('polling_opened') && !has('polling_closed');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Live turnout — {stream.stationCode} {stream.label}</h1>
          <p>{stream.wardName} Ward · cumulative voters processed while polling is open</p>
        </div>
        <Link to={`/streams/${id}`} className="btn-sm">← Back to stream</Link>
      </div>
      <div className="panel" style={{ maxWidth: 520 }}>
        {open && stream.canEdit
          ? <TurnoutForm streamId={id} registered={stream.registered} history={stream.turnoutHistory} onDone={reload} />
          : <div className="dim">
              {!has('polling_opened') ? 'Turnout can be logged once polling has been declared open.'
                : has('polling_closed') ? 'Polling has closed — turnout is no longer tracked live.'
                : 'You have view-only access to this stream.'}
              {stream.turnoutHistory.length > 0 && <div style={{ marginTop: 10 }}>Last recorded: <b>{stream.turnoutHistory[0].votersProcessed}</b> of {stream.registered}</div>}
            </div>}
      </div>
      {stream.turnoutHistory.length > 0 && (
        <div className="panel" style={{ maxWidth: 520, marginTop: 16 }}>
          <div className="panel-head"><h2>History</h2></div>
          <table><thead><tr><th>Time</th><th>Voters processed</th></tr></thead>
            <tbody>{stream.turnoutHistory.map((t) => (
              <tr key={t.id}><td className="dim">{new Date(t.reportedAt).toLocaleTimeString()}</td><td className="mono">{t.votersProcessed}</td></tr>
            ))}</tbody></table>
        </div>
      )}
    </>
  );
}

function TurnoutForm({ streamId, registered, history, onDone }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = history[0];

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.logTurnout(streamId, Number(value));
      setValue('');
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <>
      {latest && <div className="dim" style={{ marginBottom: 12, fontSize: 12.5 }}>Latest: <b>{latest.votersProcessed}</b> of {registered} — {new Date(latest.reportedAt).toLocaleTimeString()}</div>}
      <form onSubmit={submit} className="stack-form">
        <label>Voters processed so far</label>
        <input type="number" min="0" max={registered} value={value} onChange={(e) => setValue(e.target.value)} required />
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="primary" disabled={busy || value === ''}>{busy ? 'Saving…' : 'Log turnout'}</button>
      </form>
    </>
  );
}

