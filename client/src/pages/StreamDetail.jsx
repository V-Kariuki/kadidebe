import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { EVENT_LABEL, EVENT_FORMS, summariseDetails } from '../streamEvents.js';

function useGps() {
  const [coords, setCoords] = useState(null);
  const [capturing, setCapturing] = useState(false);
  const [error, setError] = useState('');
  function capture() {
    if (!navigator.geolocation) { setError('GPS is not available on this device'); return; }
    setCapturing(true); setError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => { setCoords({ lat: pos.coords.latitude, lng: pos.coords.longitude }); setCapturing(false); },
      (err) => { setError(err.message); setCapturing(false); },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }
  return { coords, capturing, error, capture };
}

const fmt = (iso) => new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });

export default function StreamDetail() {
  const { id } = useParams();
  const { user, hasModule } = useAuth();
  const [stream, setStream] = useState(null);
  const [error, setError] = useState('');

  function reload() { api.streamDetail(id).then(setStream).catch((e) => setError(e.message)); }
  useEffect(reload, [id]);

  if (error) return <div className="form-error" style={{ margin: 24 }}>{error}</div>;
  if (!stream) return <div className="screen-loading">Loading stream…</div>;

  const eventFor = (t) => stream.events.find((e) => e.eventType === t);
  const has = (t) => !!eventFor(t);
  const c = stream.custody;                 // null when the custody module is off
  const custodyOn = !!c;
  const canEdit = stream.canEdit;

  // The whole sequence, in order. Each step knows whether it's done, whether
  // something earlier is blocking it, and — if the work happens on another
  // page — where to send the user.
  const steps = [
    { key: 'materials_dispatched', kind: 'form' },
    { key: 'materials_arrived', kind: 'form' },
    { key: 'agent_arrived', kind: 'form' },
    ...(custodyOn ? [{
      key: 'boxes_confirmed_empty', kind: 'link', to: `/streams/${id}/custody`, cta: 'Record box serials & seals',
      hint: `Every seat needs its box serial, an empty-box confirmation and its seals — ${c.sealed} of ${c.expected} seats done.`
    }] : []),
    {
      key: 'polling_opened', kind: 'form',
      blocked: custodyOn && !has('boxes_confirmed_empty') ? 'Record every seat\'s ballot box serial and seals first.' : null
    },
    ...(custodyOn && has('polling_opened') && !has('polling_closed') && c.closed < c.expected ? [{
      key: 'closing_seals', label: 'Closing seals recorded', kind: 'link', to: `/streams/${id}/custody`, cta: 'Record closing seals',
      hint: `The extra seal over each ballot slot — ${c.closed} of ${c.expected} seats done.`,
      done: false
    }] : []),
    {
      key: 'polling_closed', kind: 'form',
      blocked: !has('polling_opened') ? 'Polling has not been declared open.' : (custodyOn && c.closed < c.expected ? 'Record the closing seal for every seat first.' : null)
    },
    ...(custodyOn && has('polling_closed') && !has('counting_started') && c.matched < c.expected ? [{
      key: 'seal_check', label: 'Seals checked against those applied', kind: 'link', to: `/streams/${id}/custody`, cta: 'Check seals before counting',
      hint: `Confirm for each seat that the seals cut match those applied — ${c.matched} of ${c.expected} seats done.`,
      done: false
    }] : []),
    {
      key: 'counting_started', kind: 'form',
      blocked: !has('polling_closed') ? 'Polling has not been declared closed.' : (custodyOn && c.matched < c.expected ? 'Check the seals for every seat first.' : null)
    },
    {
      key: 'results_declared', label: 'Results submitted', kind: 'link', to: `/streams/${id}/results`, cta: 'Go to results submission',
      hint: 'Enter the ballot accounting for each seat, with a photo of the signed form.',
      blocked: !has('counting_started') ? 'Counting has not started.' : null
    },
    { key: 'materials_departed', kind: 'form', blocked: !has('results_declared') ? 'Results have not been submitted.' : null },
    { key: 'materials_arrived_tally_centre', kind: 'form', blocked: !has('materials_departed') ? 'Materials have not departed yet.' : null }
  ];
  steps.forEach((s) => { if (s.done === undefined) s.done = has(s.key); });
  const currentKey = steps.find((s) => !s.done && !s.blocked)?.key
    || steps.find((s) => !s.done)?.key;

  const polling = has('polling_opened') && !has('polling_closed');
  const areas = [
    ...(custodyOn ? [{ to: `/streams/${id}/custody`, title: 'Ballot custody', sub: `${c.sealed}/${c.expected} sealed · ${c.closed}/${c.expected} closed`, open: true }] : []),
    ...(hasModule('booklets') ? [{ to: `/streams/${id}/booklets`, title: 'Ballot booklets', sub: 'Serial ranges & quantities', open: polling, why: has('polling_closed') ? 'Voting is closed' : 'Opens when polling opens' }] : []),
    ...(hasModule('turnout') ? [{ to: `/streams/${id}/turnout`, title: 'Live turnout', sub: `${stream.votersProcessed} of ${stream.registered} so far`, open: polling, why: has('polling_closed') ? 'Voting is closed' : 'Opens when polling opens' }] : []),
    ...(hasModule('results') ? [{ to: `/streams/${id}/results`, title: 'Results', sub: `${stream.results.length} seat(s) submitted`, open: has('counting_started'), why: 'Opens when counting starts' }] : [])
  ];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{stream.stationCode} — {stream.label}</h1>
          <p>
            {stream.stationName || stream.wardName} · {stream.wardName} Ward · {stream.registered} registered
            {' · '}{stream.agents.length ? stream.agents.map((a) => a.name).join(', ') : 'No agent assigned'}
          </p>
        </div>
        <Link to="/stations" className="btn-sm">← Back to stations</Link>
      </div>

      {!canEdit && <div className="form-notice" style={{ marginBottom: 14 }}>You have view-only access to this stream.</div>}

      <div className="panel">
        <div className="panel-head">
          <div><h2>Progress</h2><div className="sub">Complete each step in order — only the current step is open</div></div>
        </div>
        <div className="steps">
          {steps.map((s) => (
            <Step
              key={s.key} step={s} streamId={id} current={s.key === currentKey}
              event={eventFor(s.key)} canEdit={canEdit} defaultName={user.name} onDone={reload}
            />
          ))}
        </div>
      </div>

      {areas.length > 0 && (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-head"><div><h2>Work areas</h2><div className="sub">Detailed entry screens for this stream</div></div></div>
          <div className="area-grid">
            {areas.map((a) => a.open ? (
              <Link key={a.title} to={a.to} className="area-card">
                <b>{a.title}</b><span>{a.sub}</span><em>Open →</em>
              </Link>
            ) : (
              <div key={a.title} className="area-card locked">
                <b>{a.title}</b><span>{a.sub}</span><em>🔒 {a.why}</em>
              </div>
            ))}
          </div>
        </div>
      )}

      <details className="panel" style={{ marginTop: 16 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Activity log ({stream.events.length})</summary>
        <div className="feed" style={{ marginTop: 14 }}>
          {stream.events.length === 0 && <div className="dim">Nothing logged yet.</div>}
          {[...stream.events].reverse().map((e) => (
            <div className="feed-item ok" key={e.id}>
              <div className="feed-dot"></div>
              <div>
                <div className="feed-text">
                  <b>{EVENT_LABEL[e.eventType] || e.eventType}</b>
                  {e.recordedBy && <span className="dim"> · {e.recordedBy}</span>}
                  {e.gpsLat != null && <span className="dim"> · GPS {e.gpsLat.toFixed(4)}, {e.gpsLng.toFixed(4)}</span>}
                </div>
                {summariseDetails(e.eventType, e.details).map((d) => (
                  <div key={d.label} className="dim" style={{ fontSize: 11.5 }}>{d.label}: {d.value}</div>
                ))}
                {e.note && <div className="dim" style={{ fontSize: 11.5 }}>Note: {e.note}</div>}
                <div className="feed-time">{fmt(e.at)}</div>
              </div>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}

function Step({ step, streamId, current, event, canEdit, defaultName, onDone }) {
  const label = step.label || EVENT_LABEL[step.key] || step.key;
  const state = step.done ? 'done' : step.blocked ? 'blocked' : current ? 'current' : 'pending';
  return (
    <div className={`step ${state}`}>
      <div className="step-marker">{step.done ? '✓' : state === 'blocked' ? '🔒' : '•'}</div>
      <div className="step-body">
        <div className="step-title">
          {label}
          {step.done && event && <span className="dim"> · {fmt(event.at)}{event.recordedBy && event.recordedBy !== 'Recorded automatically' ? ` · ${event.recordedBy}` : ''}</span>}
          {step.done && event?.recordedBy === 'Recorded automatically' && <span className="dim"> · recorded automatically</span>}
        </div>

        {state === 'blocked' && <div className="dim step-note">{step.blocked}</div>}

        {current && !step.done && step.kind === 'link' && (
          <div className="step-open">
            {step.hint && <p className="dim">{step.hint}</p>}
            {canEdit
              ? <Link to={step.to} className="btn-sm primary">{step.cta} →</Link>
              : <div className="dim">View-only.</div>}
          </div>
        )}

        {current && !step.done && step.kind === 'form' && canEdit && (
          <EventForm eventType={step.key} streamId={streamId} defaultName={defaultName} onDone={onDone} />
        )}
        {current && !step.done && step.kind === 'form' && !canEdit && <div className="dim step-note">Waiting for the assigned agent.</div>}
      </div>
    </div>
  );
}

function EventForm({ eventType, streamId, defaultName, onDone }) {
  const cfg = EVENT_FORMS[eventType];
  const gps = useGps();
  const [recordedBy, setRecordedBy] = useState(defaultName || '');
  const [details, setDetails] = useState({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.logEvent(streamId, {
        eventType, recordedBy: recordedBy.trim(),
        details: Object.fromEntries(Object.entries(details).filter(([, v]) => String(v).trim() !== '').map(([k, v]) => [k, String(v).trim()])),
        note: note.trim() || null,
        gpsLat: gps.coords?.lat ?? null, gpsLng: gps.coords?.lng ?? null
      });
      onDone();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="stack-form step-open">
      <p className="dim" style={{ marginBottom: 6 }}>{cfg.help}</p>

      {cfg.gps && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '4px 0 8px' }}>
          <button type="button" className="btn-sm" onClick={gps.capture} disabled={gps.capturing}>
            {gps.capturing ? 'Capturing…' : gps.coords ? 'Re-capture location' : '📍 Capture my location'}
          </button>
          {gps.coords && <span className="dim mono" style={{ fontSize: 11.5 }}>{gps.coords.lat.toFixed(5)}, {gps.coords.lng.toFixed(5)}</span>}
          {gps.error && <span className="form-error" style={{ margin: 0 }}>{gps.error}</span>}
        </div>
      )}

      {cfg.fields.map((f) => (
        <div key={f.key}>
          <label>{f.label}{f.required ? ' *' : ''}</label>
          {f.type === 'select' ? (
            <select value={details[f.key] || ''} required={f.required} onChange={(e) => setDetails((d) => ({ ...d, [f.key]: e.target.value }))}>
              <option value="">Select…</option>
              {f.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          ) : (
            <input type={f.type === 'number' ? 'number' : 'text'} min={f.type === 'number' ? 0 : undefined}
              value={details[f.key] || ''} required={f.required}
              onChange={(e) => setDetails((d) => ({ ...d, [f.key]: e.target.value }))} />
          )}
        </div>
      ))}

      <label>Confirmed by (your name) *</label>
      <input value={recordedBy} onChange={(e) => setRecordedBy(e.target.value)} required minLength={2} />
      <label>Note (optional)</label>
      <textarea rows="2" value={note} onChange={(e) => setNote(e.target.value)} />

      {error && <div className="form-error">{error}</div>}
      <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : `Confirm — ${cfg.title.toLowerCase()}`}</button>
    </form>
  );
}
