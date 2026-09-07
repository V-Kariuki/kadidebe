import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

const EVENT_ORDER = [
  'materials_dispatched', 'materials_arrived', 'agent_arrived', 'boxes_confirmed_empty',
  'polling_opened', 'polling_closed', 'counting_started', 'counting_completed',
  'results_declared', 'materials_departed', 'materials_arrived_tally_centre'
];
const EVENT_LABEL = {
  materials_dispatched: 'Materials dispatched from tallying centre', materials_arrived: 'Materials arrived at station',
  agent_arrived: 'Agent arrived on site', boxes_confirmed_empty: 'Ballot boxes confirmed empty',
  polling_opened: 'Polling declared open', polling_closed: 'Polling declared closed',
  counting_started: 'Counting started', counting_completed: 'Counting completed',
  results_declared: 'Results declared', materials_departed: 'Materials departed station',
  materials_arrived_tally_centre: 'Materials arrived at tallying centre'
};

function useGps() {
  const [coords, setCoords] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState('');
  function capture() {
    if (!navigator.geolocation) { setError('GPS not available on this device'); return; }
    setCapturing(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setCapturing(false); },
      (err) => { setError(err.message); setCapturing(false); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }
  return { coords, capturing, error, capture };
}

export default function StreamDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [stream, setStream] = useState(null);
  const [positions, setPositions] = useState([]);
  const [error, setError] = useState('');
  const gps = useGps();

  const isStaff = user.role === 'coordinator' || user.role === 'admin';

  function reload() {
    api.streamDetail(id).then(setStream).catch((err) => setError(err.message));
    if (positions.length === 0) api.positions().then(setPositions);
  }
  useEffect(reload, [id]);

  if (error) return <div className="form-error" style={{ margin: 24 }}>{error}</div>;
  if (!stream) return <div className="screen-loading">Loading stream…</div>;

  const currentIndex = EVENT_ORDER.indexOf(stream.status);
  const nextEvent = currentIndex < EVENT_ORDER.length - 1 ? EVENT_ORDER[currentIndex + 1] : null;

  async function logEvent(eventType) {
    setError('');
    try {
      await api.logEvent(id, { eventType, gpsLat: gps.coords?.lat ?? null, gpsLng: gps.coords?.lng ?? null });
      reload();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{stream.stationCode} — {stream.label}</h1>
          <p>{stream.stationName || stream.wardName} · {stream.wardName} Ward · {stream.registered} registered voters · {stream.agents.length ? `Agents: ${stream.agents.map((a) => a.name).join(', ')}` : 'No agent assigned'}</p>
        </div>
        <Link to="/stations" className="btn-sm">← Back to stations</Link>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <div><h2>Timeline</h2><div className="sub">Current status: <b>{EVENT_LABEL[stream.status] || 'Not started'}</b></div></div>
          </div>

          <div className="feed" style={{ marginBottom: 16 }}>
            {stream.events.length === 0 && <div className="dim">No events logged yet.</div>}
            {stream.events.map((e) => (
              <div className="feed-item ok" key={e.id}>
                <div className="feed-dot"></div>
                <div>
                  <div className="feed-text">{EVENT_LABEL[e.eventType] || e.eventType}{e.gpsLat != null && <span className="dim"> · GPS {e.gpsLat.toFixed(4)}, {e.gpsLng.toFixed(4)}</span>}</div>
                  <div className="feed-time">{new Date(e.at).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>

          {nextEvent && (
            <div className="stack-form">
              <label>GPS (optional, recommended for arrival)</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button type="button" className="btn-sm" onClick={gps.capture} disabled={gps.capturing}>
                  {gps.capturing ? 'Capturing…' : gps.coords ? 'Re-capture GPS' : 'Capture GPS'}
                </button>
                {gps.coords && <span className="dim mono" style={{ fontSize: 11.5 }}>{gps.coords.lat.toFixed(4)}, {gps.coords.lng.toFixed(4)}</span>}
              </div>
              {gps.error && <div className="form-error">{gps.error}</div>}
              <button className="primary" style={{ marginTop: 12 }} onClick={() => logEvent(nextEvent)}>
                Log: {EVENT_LABEL[nextEvent]}
              </button>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Live turnout</h2><div className="sub">Cumulative voters processed, independent of final results</div></div>
          <TurnoutForm streamId={id} registered={stream.registered} history={stream.turnoutHistory} onDone={reload} />
        </div>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Ballot box &amp; seal custody</h2><div className="sub">One box per position — confirm empty before polling opens</div></div>
        <BallotBoxTable streamId={id} positions={positions} boxes={stream.ballotBoxes} onDone={reload} />
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Ballot booklets opened</h2><div className="sub">Serial ranges, one entry per position</div></div>
        <BookletTable streamId={id} positions={positions} booklets={stream.ballotBooklets} onDone={reload} />
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head"><h2>Results</h2></div>
        {stream.status && ['counting_started', 'counting_completed', 'results_declared', 'materials_departed', 'materials_arrived_tally_centre'].includes(stream.status) ? (
          <Link to={`/streams/${id}/results`} className="btn-sm primary">Go to results submission →</Link>
        ) : (
          <div className="dim">Locked until tallying is logged as started.</div>
        )}
      </div>
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

function BallotBoxTable({ streamId, positions, boxes, onDone }) {
  const [expanded, setExpanded] = useState(null);
  const [boxDraft, setBoxDraft] = useState({});
  const [sealDraft, setSealDraft] = useState({});
  const [closeDraft, setCloseDraft] = useState({});
  const [matchDraft, setMatchDraft] = useState({});
  const [resealDraft, setResealDraft] = useState({});
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  async function logBox(positionId) {
    const serial = (boxDraft[positionId] || '').trim();
    if (!serial) return;
    setBusy(`box-${positionId}`); setError('');
    try { await api.logBallotBox(streamId, { positionId, boxSerial: serial }); onDone(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function confirmEmpty(box) {
    setBusy(`confirm-${box.id}`); setError('');
    try { await api.confirmBallotBoxEmpty(streamId, box.id); onDone(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function seal(box) {
    const d = sealDraft[box.id] || { iebc: '', agents: '' };
    if (!d.iebc.trim()) return;
    setBusy(`seal-${box.id}`); setError('');
    try {
      await api.sealBallotBox(streamId, box.id, { iebcSealSerial: d.iebc.trim(), agentSealSerials: d.agents.split(',').map((s) => s.trim()).filter(Boolean) });
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function closeSeal(box) {
    const serial = (closeDraft[box.id] || '').trim();
    if (!serial) return;
    setBusy(`close-${box.id}`); setError('');
    try { await api.closeSealBallotBox(streamId, box.id, serial); onDone(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function confirmMatch(box, matches) {
    const note = matchDraft[box.id] || '';
    setBusy(`match-${box.id}`); setError('');
    try { await api.confirmSealMatch(streamId, box.id, matches, note || null); onDone(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  async function reseal(box) {
    const serial = (resealDraft[box.id] || '').trim();
    if (!serial) return;
    setBusy(`reseal-${box.id}`); setError('');
    try { await api.resealBallotBox(streamId, box.id, serial); onDone(); } catch (err) { setError(err.message); } finally { setBusy(null); }
  }

  function stageOf(box) {
    if (!box) return 'No box logged';
    if (box.resealedAt) return 'Re-sealed after count';
    if (box.sealMatchConfirmedAt) return box.sealsMatchAtTally ? 'Seals matched — ready to open' : 'Seal mismatch reported';
    if (box.closingSealedAt) return 'Closed — awaiting tally seal check';
    if (box.sealedAt) return 'Sealed — awaiting close';
    if (box.confirmedEmptyAt) return 'Confirmed empty — awaiting seal';
    return 'Box logged — awaiting confirm';
  }

  return (
    <>
      {error && <div className="form-error" style={{ marginBottom: 10 }}>{error}</div>}
      <table>
        <thead><tr><th>Position</th><th>Box serial</th><th>Stage</th><th></th></tr></thead>
        <tbody>
          {positions.map((p) => {
            const box = boxes.find((b) => b.positionId === p.id);
            return (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="mono">{box?.boxSerial || '—'}</td>
                <td className="dim" style={{ fontSize: 12 }}>{stageOf(box)}</td>
                <td><button className="btn-sm" onClick={() => setExpanded(expanded === p.id ? null : p.id)}>{expanded === p.id ? 'Close' : 'Open'}</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {positions.filter((p) => p.id === expanded).map((p) => {
        const box = boxes.find((b) => b.positionId === p.id);
        return (
          <div key={p.id} className="panel" style={{ background: 'var(--surface-raised)', marginTop: 10 }}>
            <div className="panel-head"><h2 style={{ fontSize: 13 }}>{p.name} — ballot box custody</h2></div>
            <div className="stack-form">
              {!box && (
                <>
                  <label>1. Box serial number</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="inline-input" style={{ width: 160 }} value={boxDraft[p.id] || ''} onChange={(e) => setBoxDraft((x) => ({ ...x, [p.id]: e.target.value }))} placeholder="BX-10021" />
                    <button className="btn-sm primary" disabled={busy === `box-${p.id}` || !(boxDraft[p.id] || '').trim()} onClick={() => logBox(p.id)}>Log box</button>
                  </div>
                </>
              )}

              {box && !box.confirmedEmptyAt && (
                <>
                  <label>2. Confirm the box is empty</label>
                  <button className="btn-sm primary" style={{ width: 'fit-content' }} disabled={busy === `confirm-${box.id}`} onClick={() => confirmEmpty(box)}>Confirm empty</button>
                </>
              )}

              {box?.confirmedEmptyAt && !box.sealedAt && (
                <>
                  <label>3. Seal the box — IEBC seal (required)</label>
                  <input className="inline-input" style={{ width: 160 }} value={(sealDraft[box.id] || {}).iebc || ''} onChange={(e) => setSealDraft((x) => ({ ...x, [box.id]: { ...(x[box.id] || {}), iebc: e.target.value } }))} placeholder="IEBC-0001" />
                  <label>Additional agent/party seals (optional, comma-separated)</label>
                  <input className="inline-input" style={{ width: 220 }} value={(sealDraft[box.id] || {}).agents || ''} onChange={(e) => setSealDraft((x) => ({ ...x, [box.id]: { ...(x[box.id] || {}), agents: e.target.value } }))} placeholder="AGT-001, AGT-002" />
                  <button className="btn-sm primary" style={{ width: 'fit-content', marginTop: 6 }} disabled={busy === `seal-${box.id}` || !((sealDraft[box.id] || {}).iebc || '').trim()} onClick={() => seal(box)}>Seal box</button>
                </>
              )}

              {box?.sealedAt && (
                <div className="dim" style={{ fontSize: 12 }}>IEBC seal: <b>{box.iebcSealSerial}</b>{box.agentSealSerials?.length > 0 && <> · Agent seals: {box.agentSealSerials.join(', ')}</>}</div>
              )}

              {box?.sealedAt && !box.closingSealedAt && (
                <>
                  <label>4. Closing seal (applied over the ballot slot at close of voting)</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="inline-input" style={{ width: 160 }} value={closeDraft[box.id] || ''} onChange={(e) => setCloseDraft((x) => ({ ...x, [box.id]: e.target.value }))} placeholder="CLOSE-0001" />
                    <button className="btn-sm primary" disabled={busy === `close-${box.id}` || !(closeDraft[box.id] || '').trim()} onClick={() => closeSeal(box)}>Apply closing seal</button>
                  </div>
                </>
              )}

              {box?.closingSealedAt && !box.sealMatchConfirmedAt && (
                <>
                  <label>5. At start of tallying — do the seals cut match those applied at sealing/closing?</label>
                  <textarea rows="2" value={matchDraft[box.id] || ''} onChange={(e) => setMatchDraft((x) => ({ ...x, [box.id]: e.target.value }))} placeholder="Optional note, especially if they don't match" />
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    <button className="btn-sm primary" disabled={busy === `match-${box.id}`} onClick={() => confirmMatch(box, true)}>Yes, seals match</button>
                    <button className="btn-sm" disabled={busy === `match-${box.id}`} onClick={() => confirmMatch(box, false)}>No — mismatch</button>
                  </div>
                </>
              )}

              {box?.sealMatchConfirmedAt && box.sealsMatchAtTally === false && (
                <div className="form-error">Seal mismatch was reported{box.sealMatchNote ? `: ${box.sealMatchNote}` : ''}. This should have an incident report filed.</div>
              )}

              {box?.sealMatchConfirmedAt && !box.resealedAt && (
                <>
                  <label>6. Re-seal after counting is complete</label>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <input className="inline-input" style={{ width: 160 }} value={resealDraft[box.id] || ''} onChange={(e) => setResealDraft((x) => ({ ...x, [box.id]: e.target.value }))} placeholder="RESEAL-0001" />
                    <button className="btn-sm primary" disabled={busy === `reseal-${box.id}` || !(resealDraft[box.id] || '').trim()} onClick={() => reseal(box)}>Re-seal box</button>
                  </div>
                </>
              )}

              {box?.resealedAt && <div className="status-badge active" style={{ width: 'fit-content' }}>Custody complete — re-sealed {new Date(box.resealedAt).toLocaleTimeString()}</div>}
            </div>
          </div>
        );
      })}
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
