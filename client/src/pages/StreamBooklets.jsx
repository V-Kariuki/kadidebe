import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';

export default function StreamBooklets() {
  const { id } = useParams();
  const [stream, setStream] = useState(null);
  const [positions, setPositions] = useState([]);
  const [error, setError] = useState('');
  function reload() { api.streamDetail(id).then(setStream).catch((e) => setError(e.message)); }
  useEffect(() => { reload(); api.positions().then(setPositions); }, [id]);

  if (error) return <div className="form-error" style={{ margin: 24 }}>{error}</div>;
  if (!stream) return <div className="screen-loading">Loading…</div>;

  const has = (t) => stream.events.some((e) => e.eventType === t);
  const open = has('polling_opened') && !has('polling_closed');

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Ballot booklets — {stream.stationCode} {stream.label}</h1>
          <p>{stream.wardName} Ward · serial ranges and quantities, used to reconcile ballots at the count</p>
        </div>
        <Link to={`/streams/${id}`} className="btn-sm">← Back to stream</Link>
      </div>
      {!open && (
        <div className="form-notice" style={{ marginBottom: 14 }}>
          {!has('polling_opened') ? 'Booklets can be logged once polling has been declared open.' : 'Voting is closed — booklet records are locked.'}
        </div>
      )}
      <div className="panel">
        {open && stream.canEdit
          ? <BookletTable streamId={id} positions={positions} booklets={stream.ballotBooklets} onDone={reload} />
          : (
            <table>
              <thead><tr><th>Seat</th><th>Booklets logged</th></tr></thead>
              <tbody>{positions.map((p) => {
                const logged = stream.ballotBooklets.filter((b) => b.positionId === p.id);
                return <tr key={p.id}><td>{p.name}</td><td className="dim mono" style={{ fontSize: 11.5 }}>{logged.length ? `${logged.map((b) => `${b.serialStart}–${b.serialEnd}`).join('; ')} (${logged.reduce((a, b) => a + (b.quantity || 0), 0)} ballots)` : '—'}</td></tr>;
              })}</tbody>
            </table>
          )}
      </div>
    </>
  );
}

function BookletTable({ streamId, positions, booklets, onDone }) {
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  function draftFor(positionId) { return drafts[positionId] || { serialStart: '', serialEnd: '', quantity: '' }; }

  async function save(positionId) {
    setBusy(positionId); setError('');
    const d = draftFor(positionId);
    try {
      await api.logBooklet(streamId, { positionId, serialStart: d.serialStart.trim(), serialEnd: d.serialEnd.trim(), quantity: Number(d.quantity || 0) });
      setDrafts((x) => ({ ...x, [positionId]: { serialStart: '', serialEnd: '', quantity: '' } }));
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  return (
    <>
      {error && <div className="form-error" style={{ marginBottom: 10 }}>{error}</div>}
      <table>
        <thead><tr><th>Position</th><th>Serial start</th><th>Serial end</th><th># ballots</th><th></th><th>Logged so far</th></tr></thead>
        <tbody>
          {positions.map((p) => {
            const d = draftFor(p.id);
            const logged = booklets.filter((b) => b.positionId === p.id);
            const totalIssued = logged.reduce((a, b) => a + (b.quantity || 0), 0);
            return (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td><input className="inline-input" style={{ width: 100 }} value={d.serialStart} onChange={(e) => setDrafts((x) => ({ ...x, [p.id]: { ...d, serialStart: e.target.value } }))} /></td>
                <td><input className="inline-input" style={{ width: 100 }} value={d.serialEnd} onChange={(e) => setDrafts((x) => ({ ...x, [p.id]: { ...d, serialEnd: e.target.value } }))} /></td>
                <td><input type="number" min="0" className="inline-input" style={{ width: 70 }} value={d.quantity} onChange={(e) => setDrafts((x) => ({ ...x, [p.id]: { ...d, quantity: e.target.value } }))} /></td>
                <td><button className="btn-sm" disabled={busy === p.id || !d.serialStart.trim() || !d.serialEnd.trim() || !d.quantity} onClick={() => save(p.id)}>Add</button></td>
                <td className="dim mono" style={{ fontSize: 11.5 }}>{logged.length ? `${logged.map((b) => `${b.serialStart}–${b.serialEnd}`).join('; ')} (${totalIssued} ballots)` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
