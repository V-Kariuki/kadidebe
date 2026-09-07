import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api.js';

export default function StreamResults() {
  const { id } = useParams();
  const [stream, setStream] = useState(null);
  const [positions, setPositions] = useState([]);
  const [error, setError] = useState('');

  function reload() {
    api.streamDetail(id).then(setStream).catch((err) => setError(err.message));
    if (positions.length === 0) api.positions().then(setPositions);
  }
  useEffect(reload, [id]);

  if (error) return <div className="form-error" style={{ margin: 24 }}>{error}</div>;
  if (!stream) return <div className="screen-loading">Loading…</div>;

  const tallyingStarted = ['counting_started', 'counting_completed', 'results_declared', 'materials_departed', 'materials_arrived_tally_centre'].includes(stream.status);

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Results — {stream.stationCode} {stream.label}</h1>
          <p>{stream.wardName} Ward · full ballot accounting per position, with a photo of the signed form</p>
        </div>
        <Link to={`/streams/${id}`} className="btn-sm">← Back to stream</Link>
      </div>

      {!tallyingStarted ? (
        <div className="panel"><div className="dim">Results can't be submitted yet — tallying hasn't been logged as started for this stream.</div></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {positions.map((p) => (
            <PositionResultForm key={p.id} streamId={id} stream={stream} position={p} existing={stream.results.find((r) => r.positionId === p.id)} onDone={reload} />
          ))}
        </div>
      )}
    </>
  );
}

function PositionResultForm({ streamId, stream, position, existing, onDone }) {
  const navigate = useNavigate();
  const initialVotes = Object.fromEntries(position.candidates.map((c) => [c.name, existing?.candidateVotes?.[c.name] ?? '']));
  const [votes, setVotes] = useState(initialVotes);
  const [rejected, setRejected] = useState(existing ? String(existing.rejectedVotes) : '0');
  const [disputed, setDisputed] = useState(existing ? String(existing.disputedVotes) : '0');
  const [spoilt, setSpoilt] = useState(existing ? String(existing.spoiltVotes) : '0');
  const [stray, setStray] = useState(existing ? String(existing.strayVotes) : '0');
  const [totalCast, setTotalCast] = useState(existing ? String(existing.totalCast) : '');
  const [remaining, setRemaining] = useState(existing ? String(existing.remainingBallots) : '');
  const [valid, setValid] = useState(existing ? String(existing.validVotes) : '');
  const [formReference, setFormReference] = useState(existing?.formReference || '');
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [anomalies, setAnomalies] = useState([]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError(''); setAnomalies([]);
    try {
      const candidateVotes = Object.fromEntries(Object.entries(votes).map(([k, v]) => [k, Number(v || 0)]));
      const res = await api.submitResult(streamId, {
        positionId: position.id, candidateVotes,
        rejectedVotes: Number(rejected || 0), disputedVotes: Number(disputed || 0), spoiltVotes: Number(spoilt || 0), strayVotes: Number(stray || 0),
        totalCast: Number(totalCast || 0), remainingBallots: Number(remaining || 0), validVotes: Number(valid || 0),
        formReference, photo
      });
      setAnomalies(res.anomalies || []);
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  function fileIncident() {
    navigate('/incidents', {
      state: {
        prefill: {
          streamId, stationCode: stream.stationCode, wardName: stream.wardName, severity: 'high', urgent: true,
          note: `Ballot reconciliation anomaly for ${position.name} at ${stream.stationCode} — ${stream.label}: ${anomalies.join(' ')}`
        }
      }
    });
  }

  return (
    <form onSubmit={submit} className="panel" style={{ background: 'var(--surface-raised)' }}>
      <div className="panel-head">
        <h2 style={{ fontSize: 14 }}>{position.name}</h2>
        {existing && <span className="status-badge active">Submitted {new Date(existing.submittedAt).toLocaleTimeString()}</span>}
      </div>
      <div className="stack-form">
        {position.candidates.map((c) => (
          <div key={c.id}>
            <label>{c.name}{c.party ? ` (${c.party})` : ''}</label>
            <input type="number" min="0" value={votes[c.name]} onChange={(e) => setVotes((v) => ({ ...v, [c.name]: e.target.value }))} required />
          </div>
        ))}
        <label>Rejected votes</label>
        <input type="number" min="0" value={rejected} onChange={(e) => setRejected(e.target.value)} required />
        <label>Disputed votes</label>
        <input type="number" min="0" value={disputed} onChange={(e) => setDisputed(e.target.value)} />
        <label>Spoilt ballots</label>
        <input type="number" min="0" value={spoilt} onChange={(e) => setSpoilt(e.target.value)} />
        <label>Stray ballots</label>
        <input type="number" min="0" value={stray} onChange={(e) => setStray(e.target.value)} />
        <label>Total ballots cast (all categories combined)</label>
        <input type="number" min="0" value={totalCast} onChange={(e) => setTotalCast(e.target.value)} required />
        <label>Ballots remaining unused</label>
        <input type="number" min="0" value={remaining} onChange={(e) => setRemaining(e.target.value)} required />
        <label>Valid votes (total)</label>
        <input type="number" min="0" value={valid} onChange={(e) => setValid(e.target.value)} required />
        <label>Form reference (optional)</label>
        <input value={formReference} onChange={(e) => setFormReference(e.target.value)} placeholder="34A" />
        <label>Photo of signed form {existing ? '(optional to replace)' : '(required)'}</label>
        <input type="file" accept="image/*" capture="environment" onChange={(e) => setPhoto(e.target.files?.[0] || null)} required={!existing} />
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Submitting…' : existing ? 'Update result' : 'Submit result'}</button>

        {anomalies.length > 0 && (
          <div className="form-error" style={{ marginTop: 4 }}>
            <b>Ballot count doesn't reconcile:</b>
            <ul style={{ margin: '6px 0 10px 18px' }}>
              {anomalies.map((a, i) => <li key={i}>{a}</li>)}
            </ul>
            The result has been saved as entered, but this needs an incident report.
            <button type="button" className="btn-sm primary" style={{ marginTop: 8 }} onClick={fileIncident}>File incident report</button>
          </div>
        )}
      </div>
    </form>
  );
}
