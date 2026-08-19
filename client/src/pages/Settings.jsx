import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { api } from '../api.js';

const ROLE_LABEL = { admin: 'Administrator', coordinator: 'Campaign Coordinator', agent: 'Field Agent' };

export default function Settings() {
  const { user, logout } = useAuth();

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Settings</h1>
          <p>Account, security{user?.role === 'admin' ? ', and structure' : ''}</p>
        </div>
      </div>

      <div className="panel" style={{ maxWidth: 480 }}>
        <div className="panel-head"><h2>Account</h2></div>
        <div className="settings-row"><span>Name</span><span>{user?.name}</span></div>
        <div className="settings-row"><span>Email</span><span>{user?.email}</span></div>
        <div className="settings-row"><span>Role</span><span>{ROLE_LABEL[user?.role]}</span></div>
        <button className="btn-sm" style={{ marginTop: 16 }} onClick={logout}>Log out</button>
      </div>

      {user?.role === 'admin' && <AdminStructure />}

      <div className="panel" style={{ maxWidth: 480, marginTop: 16 }}>
        <div className="panel-head"><h2>How this build is secured</h2></div>
        <ul className="dim" style={{ fontSize: 12.5, lineHeight: 1.8, paddingLeft: 18 }}>
          <li>Sessions use httpOnly, sameSite cookies — not readable by page JS</li>
          <li>Every write requires a matching CSRF token</li>
          <li>Passwords are bcrypt-hashed at 12 rounds, never stored in plain text</li>
          <li>Repeated failed logins lock the account for 15 minutes</li>
          <li>Every tally change, incident, and login is written to an immutable audit log</li>
          <li>Agents can only see and edit stations in their assigned ward</li>
        </ul>
      </div>
    </>
  );
}

function AdminStructure() {
  const [constituencies, setConstituencies] = useState(null);
  const [wards, setWards] = useState(null);
  const [stations, setStations] = useState(null);
  const [team, setTeam] = useState(null);

  const [constituencyName, setConstituencyName] = useState('');
  const [wardForm, setWardForm] = useState({ name: '', registeredVoters: '', constituencyId: '' });
  const [stationForm, setStationForm] = useState({ code: '', wardId: '', registered: '' });

  const [editingConstituency, setEditingConstituency] = useState(null); // id
  const [constituencyDraft, setConstituencyDraft] = useState('');
  const [editingWard, setEditingWard] = useState(null); // id
  const [wardDraft, setWardDraft] = useState({ name: '', registeredVoters: '', constituencyId: '' });

  const [importFile, setImportFile] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const fileInputRef = useRef(null);

  const [busy, setBusy] = useState(null); // which sub-form / row is submitting
  const [errors, setErrors] = useState({});

  function reload() {
    api.constituencies().then(setConstituencies);
    api.wards().then(setWards);
    api.stations().then(setStations);
    api.users().then((rows) => setTeam(rows.filter((u) => u.status !== 'pending' && (u.role === 'coordinator' || u.role === 'agent'))));
  }

  useEffect(reload, []);

  // ---- Constituencies ----

  async function addConstituency(e) {
    e.preventDefault();
    setBusy('constituency');
    setErrors((x) => ({ ...x, constituency: '' }));
    try {
      const created = await api.createConstituency(constituencyName.trim());
      setConstituencies((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setConstituencyName('');
    } catch (err) {
      setErrors((x) => ({ ...x, constituency: err.message }));
    } finally {
      setBusy(null);
    }
  }

  function startEditConstituency(c) {
    setEditingConstituency(c.id);
    setConstituencyDraft(c.name);
    setErrors((x) => ({ ...x, [`c-${c.id}`]: '' }));
  }

  async function saveConstituency(id) {
    setBusy(`c-${id}`);
    try {
      const updated = await api.updateConstituency(id, constituencyDraft.trim());
      setConstituencies((prev) => prev.map((c) => (c.id === id ? updated : c)).sort((a, b) => a.name.localeCompare(b.name)));
      setWards((prev) => prev.map((w) => (w.constituencyId === id ? { ...w, constituencyName: updated.name } : w)));
      setEditingConstituency(null);
    } catch (err) {
      setErrors((x) => ({ ...x, [`c-${id}`]: err.message }));
    } finally {
      setBusy(null);
    }
  }

  async function removeConstituency(id) {
    if (!window.confirm('Remove this constituency?')) return;
    setBusy(`c-${id}`);
    try {
      await api.deleteConstituency(id);
      setConstituencies((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      setErrors((x) => ({ ...x, [`c-${id}`]: err.message }));
    } finally {
      setBusy(null);
    }
  }

  // ---- Wards ----

  async function addWard(e) {
    e.preventDefault();
    setBusy('ward');
    setErrors((x) => ({ ...x, ward: '' }));
    try {
      const created = await api.createWard({
        name: wardForm.name.trim(),
        registeredVoters: wardForm.registeredVoters ? Number(wardForm.registeredVoters) : 0,
        constituencyId: wardForm.constituencyId || null
      });
      const withName = { ...created, constituencyName: constituencies.find((c) => c.id === created.constituencyId)?.name || null };
      setWards((prev) => [...prev, withName].sort((a, b) => a.name.localeCompare(b.name)));
      setWardForm({ name: '', registeredVoters: '', constituencyId: '' });
    } catch (err) {
      setErrors((x) => ({ ...x, ward: err.message }));
    } finally {
      setBusy(null);
    }
  }

  function startEditWard(w) {
    setEditingWard(w.id);
    setWardDraft({ name: w.name, registeredVoters: String(w.registeredVoters), constituencyId: w.constituencyId || '' });
    setErrors((x) => ({ ...x, [`w-${w.id}`]: '' }));
  }

  async function saveWard(id) {
    setBusy(`w-${id}`);
    try {
      const updated = await api.updateWard(id, {
        name: wardDraft.name.trim(),
        registeredVoters: wardDraft.registeredVoters === '' ? undefined : Number(wardDraft.registeredVoters),
        constituencyId: wardDraft.constituencyId || null
      });
      setWards((prev) => prev.map((w) => (w.id === id ? updated : w)).sort((a, b) => a.name.localeCompare(b.name)));
      setEditingWard(null);
    } catch (err) {
      setErrors((x) => ({ ...x, [`w-${id}`]: err.message }));
    } finally {
      setBusy(null);
    }
  }

  async function removeWard(id) {
    if (!window.confirm('Remove this ward?')) return;
    setBusy(`w-${id}`);
    try {
      await api.deleteWard(id);
      setWards((prev) => prev.filter((w) => w.id !== id));
    } catch (err) {
      setErrors((x) => ({ ...x, [`w-${id}`]: err.message }));
    } finally {
      setBusy(null);
    }
  }

  // ---- Import ----

  async function runImport(e) {
    e.preventDefault();
    if (!importFile) return;
    setBusy('import');
    setErrors((x) => ({ ...x, import: '' }));
    setImportResult(null);
    try {
      const result = await api.importWards(importFile);
      setImportResult(result);
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      reload();
    } catch (err) {
      setErrors((x) => ({ ...x, import: err.message }));
    } finally {
      setBusy(null);
    }
  }

  async function downloadTemplate() {
    try {
      await api.downloadWardTemplate();
    } catch (err) {
      setErrors((x) => ({ ...x, import: err.message }));
    }
  }

  // ---- Polling stations (add only here — edit/delete live on the Stations page) ----

  async function addStation(e) {
    e.preventDefault();
    setBusy('station');
    setErrors((x) => ({ ...x, station: '' }));
    try {
      const created = await api.createStation({
        code: stationForm.code.trim(),
        wardId: stationForm.wardId,
        registered: stationForm.registered ? Number(stationForm.registered) : 0
      });
      setStations((prev) => [...prev, created]);
      setStationForm({ code: '', wardId: '', registered: '' });
    } catch (err) {
      setErrors((x) => ({ ...x, station: err.message }));
    } finally {
      setBusy(null);
    }
  }

  // ---- Team assignments ----

  async function reassignWard(personId, wardId) {
    setBusy(personId);
    try {
      const res = await api.setUserWard(personId, wardId || null);
      setTeam((prev) => prev.map((u) => (u.id === personId ? res.user : u)));
      api.stations().then(setStations);
    } catch (err) {
      setErrors((x) => ({ ...x, [personId]: err.message }));
    } finally {
      setBusy(null);
    }
  }

  async function assignStation(person, stationId) {
    setBusy(`station-${person.id}`);
    setErrors((x) => ({ ...x, [`station-${person.id}`]: '' }));
    try {
      const previous = stations.find((s) => s.assignedAgentId === person.id);
      if (previous && previous.id !== stationId) {
        await api.assignStationAgent(previous.id, null);
      }
      if (stationId) {
        const updated = await api.assignStationAgent(stationId, person.id);
        setStations((prev) => prev.map((s) => {
          if (s.id === updated.id) return updated;
          if (previous && s.id === previous.id) return { ...s, assignedAgentId: null };
          return s;
        }));
      } else if (previous) {
        setStations((prev) => prev.map((s) => (s.id === previous.id ? { ...s, assignedAgentId: null } : s)));
      }
    } catch (err) {
      setErrors((x) => ({ ...x, [`station-${person.id}`]: err.message }));
    } finally {
      setBusy(null);
    }
  }

  if (!constituencies || !wards || !stations || !team) {
    return (
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="dim">Loading structure…</div>
      </div>
    );
  }

  const coordinators = team.filter((u) => u.role === 'coordinator');
  const agents = team.filter((u) => u.role === 'agent');

  return (
    <>
      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <h2>Constituencies</h2>
            <span className="sub">{constituencies.length}</span>
          </div>
          <table>
            <thead><tr><th>Name</th><th></th></tr></thead>
            <tbody>
              {constituencies.map((c) => (
                <tr key={c.id}>
                  {editingConstituency === c.id ? (
                    <>
                      <td>
                        <input value={constituencyDraft} onChange={(e) => setConstituencyDraft(e.target.value)} className="inline-input" />
                        {errors[`c-${c.id}`] && <div className="form-error">{errors[`c-${c.id}`]}</div>}
                      </td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-sm primary" disabled={busy === `c-${c.id}`} onClick={() => saveConstituency(c.id)}>Save</button>
                        <button className="btn-sm" onClick={() => setEditingConstituency(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{c.name}</td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-sm" onClick={() => startEditConstituency(c)}>Edit</button>
                        <button className="btn-sm" disabled={busy === `c-${c.id}`} onClick={() => removeConstituency(c.id)}>Remove</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {constituencies.length === 0 && <tr><td className="dim">None yet</td><td></td></tr>}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Add a constituency</h2></div>
          <form onSubmit={addConstituency} className="stack-form">
            <label>Name</label>
            <input value={constituencyName} onChange={(e) => setConstituencyName(e.target.value)} placeholder="Tharaka" required />
            {errors.constituency && <div className="form-error">{errors.constituency}</div>}
            <button type="submit" className="primary" disabled={busy === 'constituency'}>
              {busy === 'constituency' ? 'Adding…' : 'Add constituency'}
            </button>
          </form>
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>Wards</h2>
            <span className="sub">{wards.length}</span>
          </div>
          <table>
            <thead><tr><th>Name</th><th>Constituency</th><th>Registered</th><th></th></tr></thead>
            <tbody>
              {wards.map((w) => (
                <tr key={w.id}>
                  {editingWard === w.id ? (
                    <>
                      <td><input value={wardDraft.name} onChange={(e) => setWardDraft((d) => ({ ...d, name: e.target.value }))} className="inline-input" /></td>
                      <td>
                        <select value={wardDraft.constituencyId} onChange={(e) => setWardDraft((d) => ({ ...d, constituencyId: e.target.value }))}>
                          <option value="">Unassigned</option>
                          {constituencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </td>
                      <td>
                        <input
                          type="number" min="0" value={wardDraft.registeredVoters}
                          onChange={(e) => setWardDraft((d) => ({ ...d, registeredVoters: e.target.value }))}
                          className="inline-input"
                        />
                      </td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-sm primary" disabled={busy === `w-${w.id}`} onClick={() => saveWard(w.id)}>Save</button>
                        <button className="btn-sm" onClick={() => setEditingWard(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{w.name}</td>
                      <td className="dim">{w.constituencyName || '—'}</td>
                      <td className="mono">{w.registeredVoters.toLocaleString()}</td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-sm" onClick={() => startEditWard(w)}>Edit</button>
                        <button className="btn-sm" disabled={busy === `w-${w.id}`} onClick={() => removeWard(w.id)}>Remove</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {wards.length === 0 && <tr><td className="dim">None yet</td><td></td><td></td></tr>}
            </tbody>
          </table>
          {Object.entries(errors).filter(([k]) => k.startsWith('w-')).map(([k, msg]) => msg && (
            <div key={k} className="form-error" style={{ marginTop: 8 }}>{msg}</div>
          ))}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Add a ward</h2></div>
          <form onSubmit={addWard} className="stack-form">
            <label>Name</label>
            <input value={wardForm.name} onChange={(e) => setWardForm((f) => ({ ...f, name: e.target.value }))} placeholder="Chuka" required />
            <label>Constituency</label>
            <select value={wardForm.constituencyId} onChange={(e) => setWardForm((f) => ({ ...f, constituencyId: e.target.value }))}>
              <option value="">Unassigned</option>
              {constituencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <label>Registered voters</label>
            <input type="number" min="0" value={wardForm.registeredVoters} onChange={(e) => setWardForm((f) => ({ ...f, registeredVoters: e.target.value }))} placeholder="5400" />
            {errors.ward && <div className="form-error">{errors.ward}</div>}
            <button type="submit" className="primary" disabled={busy === 'ward'}>
              {busy === 'ward' ? 'Adding…' : 'Add ward'}
            </button>
          </form>

          <div className="panel-head" style={{ marginTop: 20 }}><h2>Import from a spreadsheet</h2></div>
          <p className="dim" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 10 }}>
            Upload a CSV with <code>constituency</code>, <code>ward</code>, and <code>registeredVoters</code> columns.
            Existing wards (matched by name) are updated; new ones are created — same for constituencies.
          </p>
          <form onSubmit={runImport} className="stack-form">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setImportFile(e.target.files?.[0] || null)}
            />
            {errors.import && <div className="form-error">{errors.import}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="submit" className="primary" disabled={busy === 'import' || !importFile}>
                {busy === 'import' ? 'Importing…' : 'Upload CSV'}
              </button>
              <button type="button" className="btn-sm" onClick={downloadTemplate}>Download template</button>
            </div>
          </form>
          {importResult && (
            <div className="dim" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
              {importResult.constituenciesCreated} constituency(ies) created ·{' '}
              {importResult.wardsCreated} ward(s) created ·{' '}
              {importResult.wardsUpdated} ward(s) updated
              {importResult.skipped.length > 0 && (
                <div style={{ marginTop: 6, color: 'var(--red)' }}>
                  {importResult.skipped.length} row(s) skipped: {importResult.skipped.map((s) => `line ${s.row} (${s.reason})`).join('; ')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid-2">
        <div className="panel">
          <div className="panel-head">
            <h2>Polling stations</h2>
            <span className="sub">{stations.length} total · edit or remove individual stations on the Stations page</span>
          </div>
          <table>
            <thead><tr><th>Ward</th><th>Stations</th></tr></thead>
            <tbody>
              {wards.map((w) => (
                <tr key={w.id}>
                  <td>{w.name}</td>
                  <td className="mono">{stations.filter((s) => s.wardId === w.id).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Add a polling station</h2></div>
          <form onSubmit={addStation} className="stack-form">
            <label>Station code</label>
            <input value={stationForm.code} onChange={(e) => setStationForm((f) => ({ ...f, code: e.target.value }))} placeholder="ST-201" required />
            <label>Ward</label>
            <select value={stationForm.wardId} onChange={(e) => setStationForm((f) => ({ ...f, wardId: e.target.value }))} required>
              <option value="">Select ward…</option>
              {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <label>Registered voters</label>
            <input type="number" min="0" value={stationForm.registered} onChange={(e) => setStationForm((f) => ({ ...f, registered: e.target.value }))} placeholder="450" />
            {errors.station && <div className="form-error">{errors.station}</div>}
            <button type="submit" className="primary" disabled={busy === 'station'}>
              {busy === 'station' ? 'Adding…' : 'Add station'}
            </button>
          </form>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 0 }}>
        <div className="panel-head">
          <h2>Team assignments</h2>
          <span className="sub">Assign coordinators to a ward, agents to a ward and a station</span>
        </div>
        <table>
          <thead><tr><th>Name</th><th>Role</th><th>Ward</th><th>Station</th><th></th></tr></thead>
          <tbody>
            {[...coordinators, ...agents].map((person) => {
              const personWardId = wards.find((w) => w.name === person.wardName)?.id || '';
              const wardStations = stations.filter((s) => s.wardId === personWardId);
              const assignedStation = stations.find((s) => s.assignedAgentId === person.id);
              return (
                <tr key={person.id}>
                  <td>{person.name}</td>
                  <td className="dim">{ROLE_LABEL[person.role]}</td>
                  <td>
                    <select
                      value={personWardId}
                      onChange={(e) => reassignWard(person.id, e.target.value)}
                      disabled={busy === person.id}
                    >
                      <option value="">Unassigned</option>
                      {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                    </select>
                  </td>
                  <td>
                    {person.role === 'agent' ? (
                      <select
                        value={assignedStation?.id || ''}
                        onChange={(e) => assignStation(person, e.target.value || null)}
                        disabled={busy === `station-${person.id}` || !person.wardName}
                      >
                        <option value="">Unassigned</option>
                        {wardStations.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
                      </select>
                    ) : <span className="dim">—</span>}
                  </td>
                  <td>{(errors[person.id] || errors[`station-${person.id}`]) && (
                    <span className="form-error" style={{ marginTop: 0 }}>{errors[person.id] || errors[`station-${person.id}`]}</span>
                  )}</td>
                </tr>
              );
            })}
            {coordinators.length + agents.length === 0 && <tr><td className="dim">No coordinators or agents yet</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}
