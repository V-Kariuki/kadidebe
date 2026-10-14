import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { api } from '../api.js';

// Ballot custody follows the physical sequence on polling day, so the page is
// split into four stages. Each stage lists every seat being tracked with one
// small form per seat, rather than one long table of everything at once.
const STAGES = [
  { key: 'before', label: '1 · Before voting', blurb: 'For each seat: log the ballot box serial, confirm it is empty, then seal it. Polling can only be declared open once every seat is done.' },
  { key: 'close', label: '2 · Close of voting', blurb: 'Record the extra seal placed over the ballot slot of each box. Polling can only be declared closed once every seat is done.' },
  { key: 'count', label: '3 · Start of counting', blurb: 'As each box is opened, record the serials of the seals cut and whether they match those applied. Counting can only start once every seat is done.' },
  { key: 'after', label: '4 · After counting', blurb: 'Record the new seal applied when each box is re-sealed after the count.' }
];

export default function StreamCustody() {
  const { id } = useParams();
  const [stream, setStream] = useState(null);
  const [positions, setPositions] = useState([]);
  const [stage, setStage] = useState(null);
  const [error, setError] = useState('');

  function reload() { api.streamDetail(id).then(setStream).catch((e) => setError(e.message)); }
  useEffect(() => { reload(); api.positions().then(setPositions); }, [id]);

  if (error) return <div className="form-error" style={{ margin: 24 }}>{error}</div>;
  if (!stream) return <div className="screen-loading">Loading…</div>;

  const has = (t) => stream.events.some((e) => e.eventType === t);
  const boxFor = (pid) => stream.ballotBoxes.find((b) => b.positionId === pid);
  const avail = {
    before: !has('polling_closed'),
    close: has('polling_opened'),
    count: has('polling_closed'),
    after: has('counting_started')
  };
  const done = {
    before: (b) => !!b?.sealedAt,
    close: (b) => !!b?.closingSealedAt,
    count: (b) => !!b?.sealMatchConfirmedAt,
    after: (b) => !!b?.resealedAt
  };
  const progress = (k) => positions.filter((p) => done[k](boxFor(p.id))).length;
  const complete = (k) => positions.length > 0 && progress(k) === positions.length;

  // Land on the first stage that's open and not yet finished.
  const active = stage || STAGES.find((s) => avail[s.key] && !complete(s.key))?.key || 'before';
  const cur = STAGES.find((s) => s.key === active);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Ballot custody — {stream.stationCode} {stream.label}</h1>
          <p>{stream.wardName} Ward · box serials and seals, one seat at a time</p>
        </div>
        <Link to={`/streams/${id}`} className="btn-sm">← Back to stream</Link>
      </div>

      <div className="stage-tabs">
        {STAGES.map((s) => (
          <button key={s.key} disabled={!avail[s.key]} className={`stage-tab${s.key === active ? ' active' : ''}${complete(s.key) ? ' complete' : ''}`}
            onClick={() => setStage(s.key)}>
            {complete(s.key) ? '✓ ' : !avail[s.key] ? '🔒 ' : ''}{s.label}
            <span>{progress(s.key)}/{positions.length}</span>
          </button>
        ))}
      </div>

      <div className="panel" style={{ marginTop: 14 }}>
        <p className="dim" style={{ marginBottom: 14 }}>{cur.blurb}</p>
        {!stream.canEdit && <div className="form-notice" style={{ marginBottom: 12 }}>You have view-only access to this stream.</div>}
        <div className="seat-list">
          {positions.map((p) => {
            const box = boxFor(p.id);
            return (
              <SeatCard key={p.id} stage={active} position={p} box={box} streamId={id}
                stream={stream} editable={stream.canEdit && avail[active]} onDone={reload} />
            );
          })}
        </div>
      </div>
    </>
  );
}

function SeatCard({ stage, position, box, streamId, stream, editable, onDone }) {
  const complete = { before: !!box?.sealedAt, close: !!box?.closingSealedAt, count: !!box?.sealMatchConfirmedAt, after: !!box?.resealedAt }[stage];
  return (
    <div className={`seat-card${complete ? ' done' : ''}`}>
      <div className="seat-head">
        <b>{position.name}</b>
        {box && <span className="mono dim">Box {box.boxSerial}</span>}
        {complete && <span className="status-badge active">Done</span>}
      </div>
      {complete
        ? <Recorded stage={stage} box={box} />
        : editable
          ? <SeatForm stage={stage} position={position} box={box} streamId={streamId} stream={stream} onDone={onDone} />
          : <div className="dim" style={{ fontSize: 12 }}>Not recorded yet.</div>}
    </div>
  );
}

function Recorded({ stage, box }) {
  if (stage === 'before') return <div className="dim rec">IEBC seal <b>{box.iebcSealSerial}</b>{box.agentSealSerials?.length > 0 && <> · agent seals {box.agentSealSerials.join(', ')}</>}</div>;
  if (stage === 'close') return <div className="dim rec">Closing seal <b>{box.closingSealSerial}</b></div>;
  if (stage === 'count') return (
    <div className="dim rec">
      {box.sealsMatchAtTally ? 'Seals matched.' : <span style={{ color: 'var(--red)' }}>Seal mismatch reported.</span>}
      {box.sealMatchNote && <> {box.sealMatchNote}</>}
    </div>
  );
  return <div className="dim rec">Re-sealed with <b>{box.resealSerial}</b></div>;
}

function SeatForm({ stage, position, box, streamId, stream, onDone }) {
  const navigate = useNavigate();
  const [f, setF] = useState({ boxSerial: box?.boxSerial || '', empty: !!box?.confirmedEmptyAt, iebc: '', agents: '', closing: '', cut: '', match: '', note: '', reseal: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (stage === 'before') {
        // One form, three recorded facts: the serial, the empty-box
        // confirmation, and the seals — each still timestamped separately.
        let b = box;
        if (!b || b.boxSerial !== f.boxSerial.trim()) b = await api.logBallotBox(streamId, { positionId: position.id, boxSerial: f.boxSerial.trim() });
        if (!b.confirmedEmptyAt) await api.confirmBallotBoxEmpty(streamId, b.id);
        await api.sealBallotBox(streamId, b.id, {
          iebcSealSerial: f.iebc.trim(),
          agentSealSerials: f.agents.split(',').map((s) => s.trim()).filter(Boolean)
        });
      } else if (stage === 'close') {
        await api.closeSealBallotBox(streamId, box.id, f.closing.trim());
      } else if (stage === 'count') {
        const matches = f.match === 'yes';
        const note = [`Seals cut: ${f.cut.trim()}`, f.note.trim()].filter(Boolean).join(' — ');
        await api.confirmSealMatch(streamId, box.id, matches, note);
        if (!matches) {
          onDone();
          navigate('/incidents', { state: { prefill: {
            streamId, stationCode: stream.stationCode, wardName: stream.wardName, severity: 'high', urgent: true,
            note: `Seal mismatch on the ${position.name} ballot box (${box.boxSerial}) at ${stream.stationCode} — ${stream.label}. Seals recorded at sealing: IEBC ${box.iebcSealSerial}${box.closingSealSerial ? `, closing ${box.closingSealSerial}` : ''}. ${note}`
          } } });
          return;
        }
      } else {
        await api.resealBallotBox(streamId, box.id, f.reseal.trim());
      }
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  const needsBox = stage !== 'before' && !box;
  if (needsBox) return <div className="dim" style={{ fontSize: 12 }}>No box was recorded for this seat before voting.</div>;

  return (
    <form onSubmit={submit} className="stack-form seat-form">
      {stage === 'before' && (
        <>
          <label>Ballot box serial number *</label>
          <input value={f.boxSerial} onChange={set('boxSerial')} required placeholder="BX-10021" />
          <label className="check"><input type="checkbox" checked={f.empty} onChange={set('empty')} required /> I have inspected the box and it is empty</label>
          <label>IEBC seal serial *</label>
          <input value={f.iebc} onChange={set('iebc')} required placeholder="IEBC-0001" />
          <label>Additional agent / party seal serials (comma-separated, optional)</label>
          <input value={f.agents} onChange={set('agents')} placeholder="AGT-001, AGT-002" />
        </>
      )}
      {stage === 'close' && (
        <>
          <label>Closing seal serial (over the ballot slot) *</label>
          <input value={f.closing} onChange={set('closing')} required placeholder="CLOSE-0001" />
        </>
      )}
      {stage === 'count' && (
        <>
          <label>Serial numbers of the seals cut to open the box *</label>
          <input value={f.cut} onChange={set('cut')} required placeholder="IEBC-0001, CLOSE-0001" />
          <label>Do they match the seals applied at sealing and closing? *</label>
          <div className="radio-row">
            <label className="check"><input type="radio" name={`m-${position.id}`} value="yes" checked={f.match === 'yes'} onChange={set('match')} required /> Yes, they match</label>
            <label className="check"><input type="radio" name={`m-${position.id}`} value="no" checked={f.match === 'no'} onChange={set('match')} /> No — mismatch</label>
          </div>
          <label>Note {f.match === 'no' ? '*' : '(optional)'}</label>
          <textarea rows="2" value={f.note} onChange={set('note')} required={f.match === 'no'} />
          {f.match === 'no' && <div className="form-error">A mismatch will open an urgent incident report for you to complete.</div>}
        </>
      )}
      {stage === 'after' && (
        <>
          <label>New seal serial applied after counting *</label>
          <input value={f.reseal} onChange={set('reseal')} required placeholder="RESEAL-0001" />
        </>
      )}
      {error && <div className="form-error">{error}</div>}
      <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  );
}
