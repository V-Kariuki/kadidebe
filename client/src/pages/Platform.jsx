import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../auth/AuthContext.jsx';

const LEVELS = ['national', 'county', 'constituency', 'ward'];

export default function Platform() {
  const { viewInstance } = useAuth();
  const navigate = useNavigate();
  async function openInstance(t) { await viewInstance(t); navigate('/'); }
  const [tenants, setTenants] = useState(null);
  const [catalogue, setCatalogue] = useState([]);
  const [positions, setPositions] = useState([]);
  const [geo, setGeo] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  function reload() {
    api.tenants().then(setTenants).catch((e) => setError(e.message));
  }

  useEffect(() => {
    reload();
    api.platformModules().then(setCatalogue).catch(() => setCatalogue([]));
    api.positions().then(setPositions).catch(() => setPositions([]));
    api.publicGeo().then(setGeo).catch(() => setGeo(null));
  }, []);

  if (!tenants) return <div className="screen-loading">Loading instances…</div>;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Instances</h1>
          <p>{tenants.length} client instance{tenants.length === 1 ? '' : 's'} · each is fully isolated from the others</p>
        </div>
        <button className="btn-sm primary" onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : '+ New instance'}
        </button>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}

      {showCreate && (
        <CreateInstance
          catalogue={catalogue} positions={positions} geo={geo}
          onCreated={() => { setShowCreate(false); reload(); }}
        />
      )}

      <div className="panel">
        <table>
          <thead>
            <tr><th>Instance</th><th>Slug</th><th>Covers</th><th>Races</th><th>Modules off</th><th>Users</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {tenants.map((t) => {
              const off = Object.entries(t.modules || {}).filter(([, v]) => !v).map(([k]) => k);
              return (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td className="mono dim">{t.slug}</td>
                  <td>{t.jurisdictionLabel} <span className="dim">({t.jurisdictionType})</span></td>
                  <td className="dim">{t.positionIds ? t.positionIds.length : 'all'}</td>
                  <td className="dim" style={{ fontSize: 11.5 }}>{off.length ? off.join(', ') : '—'}</td>
                  <td className="mono">{t.userCount}</td>
                  <td><span className={`status-badge ${t.status === 'active' ? 'active' : 'st-flag'}`}>{t.status}</span></td>
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn-sm primary" onClick={() => openInstance(t)}>Open</button>
                    <button className="btn-sm" onClick={() => setExpanded(expanded === t.id ? null : t.id)}>{expanded === t.id ? 'Close' : 'Configure'}</button>
                  </td>
                </tr>
              );
            })}
            {tenants.length === 0 && <tr><td className="dim" colSpan={8}>No instances yet.</td></tr>}
          </tbody>
        </table>
      </div>

      {tenants.filter((t) => t.id === expanded).map((t) => (
        <ConfigureInstance key={t.id} tenant={t} catalogue={catalogue} positions={positions} onSaved={reload} />
      ))}
    </>
  );
}

function CreateInstance({ catalogue, positions, geo, onCreated }) {
  const [form, setForm] = useState({
    name: '', slug: '', jurisdictionType: 'county', jurisdictionId: '',
    contactEmail: '', notes: '', adminName: '', adminEmail: '', adminPassword: ''
  });
  const [modules, setModules] = useState({});
  const [chosenPositions, setChosenPositions] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const units = !geo ? [] :
    form.jurisdictionType === 'county' ? geo.counties :
    form.jurisdictionType === 'constituency' ? geo.constituencies :
    form.jurisdictionType === 'ward' ? geo.wards : [];

  function autoSlug(name) {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.createTenant({
        name: form.name.trim(),
        slug: (form.slug || autoSlug(form.name)).trim(),
        jurisdictionType: form.jurisdictionType,
        jurisdictionId: form.jurisdictionType === 'national' ? null : form.jurisdictionId,
        contactEmail: form.contactEmail.trim() || null,
        notes: form.notes.trim() || null,
        modules,
        positionIds: chosenPositions.length ? chosenPositions : undefined,
        admin: form.adminEmail && form.adminPassword
          ? { name: form.adminName.trim() || undefined, email: form.adminEmail.trim(), password: form.adminPassword }
          : undefined
      });
      onCreated();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head">
        <h2>Provision a new instance</h2>
        <span className="sub">Everything here can be changed later except the slug</span>
      </div>
      <form onSubmit={submit} className="stack-form">
        <div className="grid-2">
          <div>
            <label>Client / campaign name</label>
            <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, slug: f.slug || autoSlug(e.target.value) }))} placeholder="Kaburu for MCA — Chuka" required />
            <label>Slug (used at sign-in)</label>
            <input value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} placeholder="kaburu-mca-chuka" required />
            <label>Contact email</label>
            <input type="email" value={form.contactEmail} onChange={(e) => setForm((f) => ({ ...f, contactEmail: e.target.value }))} />
          </div>
          <div>
            <label>Jurisdiction ceiling</label>
            <select value={form.jurisdictionType} onChange={(e) => setForm((f) => ({ ...f, jurisdictionType: e.target.value, jurisdictionId: '' }))}>
              {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
            </select>
            {form.jurisdictionType !== 'national' && (
              <>
                <label>Which one</label>
                <select value={form.jurisdictionId} onChange={(e) => setForm((f) => ({ ...f, jurisdictionId: e.target.value }))} required>
                  <option value="">Select…</option>
                  {units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </>
            )}
            <p className="dim" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.5 }}>
              Users in this instance can never see or act outside the ceiling, whatever role they hold.
            </p>
          </div>
        </div>

        <label style={{ marginTop: 14 }}>Races tracked (none selected = all six)</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {positions.map((p) => {
            const on = chosenPositions.includes(p.id);
            return (
              <button type="button" key={p.id} className={`btn-sm${on ? ' primary' : ''}`}
                onClick={() => setChosenPositions((c) => on ? c.filter((x) => x !== p.id) : [...c, p.id])}>
                {on ? '✓ ' : '+ '}{p.name}
              </button>
            );
          })}
        </div>

        <label style={{ marginTop: 14 }}>Modules</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {catalogue.map((m) => (
            <label key={m.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, textTransform: 'none', fontSize: 12.5, color: 'var(--text)' }}>
              <input type="checkbox" style={{ width: 'auto', marginTop: 3 }}
                disabled={m.core}
                checked={m.core ? true : (m.key in modules ? modules[m.key] : m.default)}
                onChange={(e) => setModules((x) => ({ ...x, [m.key]: e.target.checked }))} />
              <span>
                <b>{m.label}</b>{m.core && <span className="dim"> (always on)</span>}
                <br /><span className="dim" style={{ fontSize: 11.5 }}>{m.description}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="panel-head" style={{ marginTop: 18 }}><h2 style={{ fontSize: 14 }}>First administrator</h2></div>
        <div className="grid-2">
          <div>
            <label>Name</label>
            <input value={form.adminName} onChange={(e) => setForm((f) => ({ ...f, adminName: e.target.value }))} />
            <label>Email</label>
            <input type="email" value={form.adminEmail} onChange={(e) => setForm((f) => ({ ...f, adminEmail: e.target.value }))} />
          </div>
          <div>
            <label>Temporary password</label>
            <input type="text" value={form.adminPassword} onChange={(e) => setForm((f) => ({ ...f, adminPassword: e.target.value }))} minLength={8} />
            <p className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>They can change it from Profile after signing in.</p>
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Creating…' : 'Create instance'}</button>
      </form>
    </div>
  );
}

function ConfigureInstance({ tenant, catalogue, positions, onSaved }) {
  const [modules, setModules] = useState(tenant.modules || {});
  const [chosen, setChosen] = useState(tenant.positionIds || []);
  const [status, setStatus] = useState(tenant.status);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');

  async function saveModules() {
    setBusy('modules'); setError(''); setMsg('');
    try {
      const payload = {};
      catalogue.filter((m) => !m.core).forEach((m) => { payload[m.key] = m.key in modules ? modules[m.key] : m.default; });
      await api.setTenantModules(tenant.id, payload);
      setMsg('Modules updated.'); onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  async function savePositions() {
    setBusy('positions'); setError(''); setMsg('');
    try {
      await api.setTenantPositions(tenant.id, chosen);
      setMsg('Races updated.'); onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  async function saveStatus(next) {
    setBusy('status'); setError(''); setMsg('');
    try {
      await api.updateTenant(tenant.id, { status: next });
      setStatus(next); setMsg(`Instance ${next}.`); onSaved();
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h2>{tenant.name}</h2>
        <span className="sub">{tenant.jurisdictionLabel} · {tenant.userCount} user(s) · slug <code>{tenant.slug}</code></span>
      </div>

      {error && <div className="form-error" style={{ marginBottom: 10 }}>{error}</div>}
      {msg && <div className="form-notice" style={{ marginBottom: 10 }}>{msg}</div>}

      <div className="grid-2">
        <div>
          <div className="panel-head"><h2 style={{ fontSize: 14 }}>Modules</h2></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {catalogue.map((m) => (
              <label key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 8, textTransform: 'none', fontSize: 12.5, color: 'var(--text)' }}>
                <input type="checkbox" style={{ width: 'auto' }} disabled={m.core}
                  checked={m.core ? true : !!modules[m.key]}
                  onChange={(e) => setModules((x) => ({ ...x, [m.key]: e.target.checked }))} />
                {m.label}{m.core && <span className="dim"> (always on)</span>}
              </label>
            ))}
          </div>
          <button className="btn-sm primary" style={{ marginTop: 12 }} disabled={busy === 'modules'} onClick={saveModules}>
            {busy === 'modules' ? 'Saving…' : 'Save modules'}
          </button>
        </div>

        <div>
          <div className="panel-head"><h2 style={{ fontSize: 14 }}>Races tracked</h2></div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {positions.map((p) => {
              const on = chosen.includes(p.id);
              return (
                <button type="button" key={p.id} className={`btn-sm${on ? ' primary' : ''}`}
                  onClick={() => setChosen((c) => on ? c.filter((x) => x !== p.id) : [...c, p.id])}>
                  {on ? '✓ ' : '+ '}{p.name}
                </button>
              );
            })}
          </div>
          <p className="dim" style={{ fontSize: 11.5, marginTop: 8 }}>Empty selection means all six races.</p>
          <button className="btn-sm primary" style={{ marginTop: 8 }} disabled={busy === 'positions'} onClick={savePositions}>
            {busy === 'positions' ? 'Saving…' : 'Save races'}
          </button>

          <div className="panel-head" style={{ marginTop: 20 }}><h2 style={{ fontSize: 14 }}>Status</h2></div>
          <p className="dim" style={{ fontSize: 12, marginBottom: 8 }}>
            Suspending blocks every sign-in to this instance without touching its data.
          </p>
          <button className="btn-sm" disabled={busy === 'status'} onClick={() => saveStatus(status === 'active' ? 'suspended' : 'active')}>
            {status === 'active' ? 'Suspend instance' : 'Reactivate instance'}
          </button>
        </div>
      </div>
    </div>
  );
}
