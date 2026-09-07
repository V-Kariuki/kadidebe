import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { api } from '../api.js';

export default function SettingsTeam() {
  const { user } = useAuth();
  const isStaff = user?.role === 'coordinator' || user?.role === 'admin';

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Team &amp; Structure</h1>
          <p>{user?.role === 'admin' ? 'Electoral structure and team assignments' : 'Team assignments within your jurisdiction'}</p>
        </div>
      </div>

      {user?.role === 'admin' && <AdminStructure />}
      {isStaff && <TeamAssignments />}
    </>
  );
}

// ---------------------------------------------------------------------
// Admin: counties to constituencies to wards to stations
// ---------------------------------------------------------------------

function AdminStructure() {
  const [counties, setCounties] = useState(null);
  const [constituencies, setConstituencies] = useState(null);
  const [wards, setWards] = useState(null);
  const [stations, setStations] = useState(null);

  const [countyName, setCountyName] = useState('');
  const [constituencyForm, setConstituencyForm] = useState({ name: '', countyId: '' });
  const [wardForm, setWardForm] = useState({ name: '', registeredVoters: '', constituencyId: '' });
  const [stationForm, setStationForm] = useState({ code: '', name: '', wardId: '', registered: '' });

  const [editingCounty, setEditingCounty] = useState(null);
  const [countyDraft, setCountyDraft] = useState('');
  const [editingConstituency, setEditingConstituency] = useState(null);
  const [constituencyDraft, setConstituencyDraft] = useState({ name: '', countyId: '' });
  const [editingWard, setEditingWard] = useState(null);
  const [wardDraft, setWardDraft] = useState({ name: '', registeredVoters: '', constituencyId: '' });

  const [importFile, setImportFile] = useState(null);
  const [importResult, setImportResult] = useState(null);
  const fileInputRef = useRef(null);

  const [busy, setBusy] = useState(null);
  const [errors, setErrors] = useState({});

  function reload() {
    api.counties().then(setCounties);
    api.constituencies().then(setConstituencies);
    api.wards().then(setWards);
    api.stations().then(setStations);
  }
  useEffect(reload, []);

  async function addCounty(e) {
    e.preventDefault();
    setBusy('county'); setErrors((x) => ({ ...x, county: '' }));
    try {
      const created = await api.createCounty(countyName.trim());
      setCounties((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setCountyName('');
    } catch (err) { setErrors((x) => ({ ...x, county: err.message })); } finally { setBusy(null); }
  }

  async function saveCounty(id) {
    setBusy(`co-${id}`);
    try {
      const updated = await api.updateCounty(id, countyDraft.trim());
      setCounties((prev) => prev.map((c) => (c.id === id ? updated : c)).sort((a, b) => a.name.localeCompare(b.name)));
      setEditingCounty(null);
    } catch (err) { setErrors((x) => ({ ...x, [`co-${id}`]: err.message })); } finally { setBusy(null); }
  }

  async function removeCounty(id) {
    if (!window.confirm('Remove this county?')) return;
    setBusy(`co-${id}`);
    try { await api.deleteCounty(id); setCounties((prev) => prev.filter((c) => c.id !== id)); }
    catch (err) { setErrors((x) => ({ ...x, [`co-${id}`]: err.message })); } finally { setBusy(null); }
  }

  async function addConstituency(e) {
    e.preventDefault();
    setBusy('constituency'); setErrors((x) => ({ ...x, constituency: '' }));
    try {
      const created = await api.createConstituency(constituencyForm.name.trim(), constituencyForm.countyId || null);
      setConstituencies((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setConstituencyForm({ name: '', countyId: '' });
    } catch (err) { setErrors((x) => ({ ...x, constituency: err.message })); } finally { setBusy(null); }
  }

  function startEditConstituency(c) {
    setEditingConstituency(c.id);
    setConstituencyDraft({ name: c.name, countyId: c.countyId || '' });
  }

  async function saveConstituency(id) {
    setBusy(`c-${id}`);
    try {
      const updated = await api.updateConstituency(id, { name: constituencyDraft.name.trim(), countyId: constituencyDraft.countyId || null });
      setConstituencies((prev) => prev.map((c) => (c.id === id ? updated : c)).sort((a, b) => a.name.localeCompare(b.name)));
      setWards((prev) => prev.map((w) => (w.constituencyId === id ? { ...w, constituencyName: updated.name } : w)));
      setEditingConstituency(null);
    } catch (err) { setErrors((x) => ({ ...x, [`c-${id}`]: err.message })); } finally { setBusy(null); }
  }

  async function removeConstituency(id) {
    if (!window.confirm('Remove this constituency?')) return;
    setBusy(`c-${id}`);
    try { await api.deleteConstituency(id); setConstituencies((prev) => prev.filter((c) => c.id !== id)); }
    catch (err) { setErrors((x) => ({ ...x, [`c-${id}`]: err.message })); } finally { setBusy(null); }
  }

  async function addWard(e) {
    e.preventDefault();
    setBusy('ward'); setErrors((x) => ({ ...x, ward: '' }));
    try {
      const created = await api.createWard({
        name: wardForm.name.trim(),
        registeredVoters: wardForm.registeredVoters ? Number(wardForm.registeredVoters) : 0,
        constituencyId: wardForm.constituencyId || null
      });
      const withName = { ...created, constituencyName: constituencies.find((c) => c.id === created.constituencyId)?.name || null };
      setWards((prev) => [...prev, withName].sort((a, b) => a.name.localeCompare(b.name)));
      setWardForm({ name: '', registeredVoters: '', constituencyId: '' });
    } catch (err) { setErrors((x) => ({ ...x, ward: err.message })); } finally { setBusy(null); }
  }

  function startEditWard(w) {
    setEditingWard(w.id);
    setWardDraft({ name: w.name, registeredVoters: String(w.registeredVoters), constituencyId: w.constituencyId || '' });
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
    } catch (err) { setErrors((x) => ({ ...x, [`w-${id}`]: err.message })); } finally { setBusy(null); }
  }

  async function removeWard(id) {
    if (!window.confirm('Remove this ward?')) return;
    setBusy(`w-${id}`);
    try { await api.deleteWard(id); setWards((prev) => prev.filter((w) => w.id !== id)); }
    catch (err) { setErrors((x) => ({ ...x, [`w-${id}`]: err.message })); } finally { setBusy(null); }
  }

  async function addStation(e) {
    e.preventDefault();
    setBusy('station'); setErrors((x) => ({ ...x, station: '' }));
    try {
      const created = await api.createStation({
        code: stationForm.code.trim(),
        name: stationForm.name.trim() || null,
        wardId: stationForm.wardId,
        registered: stationForm.registered ? Number(stationForm.registered) : 0
      });
      setStations((prev) => [...prev, created]);
      setStationForm({ code: '', name: '', wardId: '', registered: '' });
    } catch (err) { setErrors((x) => ({ ...x, station: err.message })); } finally { setBusy(null); }
  }

  async function removeStation(id) {
    if (!window.confirm('Remove this station and all its streams? This deletes recorded results too.')) return;
    setBusy(`st-${id}`);
    try { await api.deleteStation(id); setStations((prev) => prev.filter((s) => s.id !== id)); }
    catch (err) { setErrors((x) => ({ ...x, [`st-${id}`]: err.message })); } finally { setBusy(null); }
  }

  async function runImport(e) {
    e.preventDefault();
    if (!importFile) return;
    setBusy('import'); setErrors((x) => ({ ...x, import: '' })); setImportResult(null);
    try {
      const result = await api.importWards(importFile);
      setImportResult(result);
      reload();
      setImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) { setErrors((x) => ({ ...x, import: err.message })); } finally { setBusy(null); }
  }

  function downloadTemplate() { api.downloadWardTemplate(); }

  if (!counties || !constituencies || !wards || !stations) return <div className="dim" style={{ marginTop: 16 }}>Loading structure...</div>;

  return (
    <>
      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head"><h2>Counties</h2></div>
          <table>
            <thead><tr><th>Name</th><th></th></tr></thead>
            <tbody>
              {counties.map((c) => (
                <tr key={c.id}>
                  {editingCounty === c.id ? (
                    <>
                      <td><input className="inline-input" style={{ width: 160 }} value={countyDraft} onChange={(e) => setCountyDraft(e.target.value)} /></td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-sm primary" disabled={busy === `co-${c.id}`} onClick={() => saveCounty(c.id)}>Save</button>
                        <button className="btn-sm" onClick={() => setEditingCounty(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{c.name}</td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-sm" onClick={() => { setEditingCounty(c.id); setCountyDraft(c.name); }}>Edit</button>
                        <button className="btn-sm" disabled={busy === `co-${c.id}`} onClick={() => removeCounty(c.id)}>Remove</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {counties.length === 0 && <tr><td className="dim">None yet</td><td></td></tr>}
            </tbody>
          </table>
          {Object.entries(errors).filter(([k]) => k.startsWith('co-')).map(([k, msg]) => msg && <div key={k} className="form-error" style={{ marginTop: 8 }}>{msg}</div>)}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Add a county</h2></div>
          <form onSubmit={addCounty} className="stack-form">
            <label>Name</label>
            <input value={countyName} onChange={(e) => setCountyName(e.target.value)} placeholder="Tharaka Nithi" required />
            {errors.county && <div className="form-error">{errors.county}</div>}
            <button type="submit" className="primary" disabled={busy === 'county'}>{busy === 'county' ? 'Adding...' : 'Add county'}</button>
          </form>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head"><h2>Constituencies</h2></div>
          <table>
            <thead><tr><th>Name</th><th>County</th><th></th></tr></thead>
            <tbody>
              {constituencies.map((c) => (
                <tr key={c.id}>
                  {editingConstituency === c.id ? (
                    <>
                      <td><input className="inline-input" style={{ width: 130 }} value={constituencyDraft.name} onChange={(e) => setConstituencyDraft((d) => ({ ...d, name: e.target.value }))} /></td>
                      <td>
                        <select value={constituencyDraft.countyId} onChange={(e) => setConstituencyDraft((d) => ({ ...d, countyId: e.target.value }))}>
                          <option value="">Unassigned</option>
                          {counties.map((co) => <option key={co.id} value={co.id}>{co.name}</option>)}
                        </select>
                      </td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-sm primary" disabled={busy === `c-${c.id}`} onClick={() => saveConstituency(c.id)}>Save</button>
                        <button className="btn-sm" onClick={() => setEditingConstituency(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{c.name}</td>
                      <td className="dim">{c.countyName || '-'}</td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-sm" onClick={() => startEditConstituency(c)}>Edit</button>
                        <button className="btn-sm" disabled={busy === `c-${c.id}`} onClick={() => removeConstituency(c.id)}>Remove</button>
                      </td>
                    </>
                  )}
                </tr>
              ))}
              {constituencies.length === 0 && <tr><td className="dim">None yet</td><td></td><td></td></tr>}
            </tbody>
          </table>
          {Object.entries(errors).filter(([k]) => k.startsWith('c-')).map(([k, msg]) => msg && <div key={k} className="form-error" style={{ marginTop: 8 }}>{msg}</div>)}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Add a constituency</h2></div>
          <form onSubmit={addConstituency} className="stack-form">
            <label>Name</label>
            <input value={constituencyForm.name} onChange={(e) => setConstituencyForm((f) => ({ ...f, name: e.target.value }))} placeholder="Tharaka" required />
            <label>County</label>
            <select value={constituencyForm.countyId} onChange={(e) => setConstituencyForm((f) => ({ ...f, countyId: e.target.value }))}>
              <option value="">Unassigned</option>
              {counties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            {errors.constituency && <div className="form-error">{errors.constituency}</div>}
            <button type="submit" className="primary" disabled={busy === 'constituency'}>{busy === 'constituency' ? 'Adding...' : 'Add constituency'}</button>
          </form>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head"><h2>Wards</h2></div>
          <table>
            <thead><tr><th>Name</th><th>Constituency</th><th>Registered</th><th></th></tr></thead>
            <tbody>
              {wards.map((w) => (
                <tr key={w.id}>
                  {editingWard === w.id ? (
                    <>
                      <td><input className="inline-input" style={{ width: 110 }} value={wardDraft.name} onChange={(e) => setWardDraft((d) => ({ ...d, name: e.target.value }))} /></td>
                      <td>
                        <select value={wardDraft.constituencyId} onChange={(e) => setWardDraft((d) => ({ ...d, constituencyId: e.target.value }))}>
                          <option value="">Unassigned</option>
                          {constituencies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </td>
                      <td><input type="number" min="0" value={wardDraft.registeredVoters} onChange={(e) => setWardDraft((d) => ({ ...d, registeredVoters: e.target.value }))} className="inline-input" /></td>
                      <td style={{ display: 'flex', gap: 6 }}>
                        <button className="btn-sm primary" disabled={busy === `w-${w.id}`} onClick={() => saveWard(w.id)}>Save</button>
                        <button className="btn-sm" onClick={() => setEditingWard(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td>{w.name}</td>
                      <td className="dim">{w.constituencyName || '-'}</td>
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
          {Object.entries(errors).filter(([k]) => k.startsWith('w-')).map(([k, msg]) => msg && <div key={k} className="form-error" style={{ marginTop: 8 }}>{msg}</div>)}
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
            <button type="submit" className="primary" disabled={busy === 'ward'}>{busy === 'ward' ? 'Adding...' : 'Add ward'}</button>
          </form>

          <div className="panel-head" style={{ marginTop: 20 }}><h2>Import from a spreadsheet</h2></div>
          <p className="dim" style={{ fontSize: 12, lineHeight: 1.6, marginBottom: 10 }}>
            Upload a CSV with <code>constituency</code>, <code>ward</code>, and <code>registeredVoters</code> columns.
            Existing wards (matched by name) are updated; new ones are created, same for constituencies.
          </p>
          <form onSubmit={runImport} className="stack-form">
            <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={(e) => setImportFile(e.target.files?.[0] || null)} />
            {errors.import && <div className="form-error">{errors.import}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
              <button type="submit" className="primary" disabled={busy === 'import' || !importFile}>{busy === 'import' ? 'Importing...' : 'Upload CSV'}</button>
              <button type="button" className="btn-sm" onClick={downloadTemplate}>Download template</button>
            </div>
          </form>
          {importResult && (
            <div className="dim" style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
              {importResult.constituenciesCreated} constituency(ies) created, {importResult.wardsCreated} ward(s) created, {importResult.wardsUpdated} ward(s) updated
              {importResult.skipped.length > 0 && (
                <div style={{ marginTop: 6, color: 'var(--red)' }}>{importResult.skipped.length} row(s) skipped: {importResult.skipped.map((s) => `line ${s.row} (${s.reason})`).join('; ')}</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 16 }}>
        <div className="panel">
          <div className="panel-head">
            <h2>Polling stations</h2>
            <span className="sub">{stations.length} total - add streams from the Stations page workflow</span>
          </div>
          <table>
            <thead><tr><th>Code</th><th>Ward</th><th>Registered</th><th></th></tr></thead>
            <tbody>
              {stations.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.code}</td>
                  <td>{s.wardName}</td>
                  <td className="mono">{s.registered}</td>
                  <td><button className="btn-sm" disabled={busy === `st-${s.id}`} onClick={() => removeStation(s.id)}>Remove</button></td>
                </tr>
              ))}
              {stations.length === 0 && <tr><td className="dim">None yet</td></tr>}
            </tbody>
          </table>
          {Object.entries(errors).filter(([k]) => k.startsWith('st-')).map(([k, msg]) => msg && <div key={k} className="form-error" style={{ marginTop: 8 }}>{msg}</div>)}
        </div>

        <div className="panel">
          <div className="panel-head"><h2>Add a polling station</h2></div>
          <form onSubmit={addStation} className="stack-form">
            <label>Station code</label>
            <input value={stationForm.code} onChange={(e) => setStationForm((f) => ({ ...f, code: e.target.value }))} placeholder="ST-201" required />
            <label>Name (optional)</label>
            <input value={stationForm.name} onChange={(e) => setStationForm((f) => ({ ...f, name: e.target.value }))} placeholder="Chuka Primary School" />
            <label>Ward</label>
            <select value={stationForm.wardId} onChange={(e) => setStationForm((f) => ({ ...f, wardId: e.target.value }))} required>
              <option value="">Select ward...</option>
              {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
            <label>Registered voters (total across streams)</label>
            <input type="number" min="0" value={stationForm.registered} onChange={(e) => setStationForm((f) => ({ ...f, registered: e.target.value }))} placeholder="450" />
            {errors.station && <div className="form-error">{errors.station}</div>}
            <button type="submit" className="primary" disabled={busy === 'station'}>{busy === 'station' ? 'Adding...' : 'Add station'}</button>
          </form>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------
// Coordinators and admins: agent home-ward reassignment, and assigning
// agents to specific streams. Both operate on server-scoped lists, so a
// ward coordinator only ever sees their own ward's agents and streams.
// ---------------------------------------------------------------------

function TeamAssignments() {
  const [agents, setAgents] = useState(null);
  const [wards, setWards] = useState([]);
  const [streams, setStreams] = useState(null);
  const [busy, setBusy] = useState(null);
  const [errors, setErrors] = useState({});

  function reload() {
    api.agents().then(setAgents).catch(() => setAgents([]));
    api.wards().then(setWards).catch(() => setWards([]));
    api.streams().then(setStreams).catch(() => setStreams([]));
  }
  useEffect(reload, []);

  async function reassignWard(agentId, wardId) {
    setBusy(agentId); setErrors((x) => ({ ...x, [agentId]: '' }));
    try {
      await api.setUserJurisdiction(agentId, 'ward', wardId || null);
      reload();
    } catch (err) { setErrors((x) => ({ ...x, [agentId]: err.message })); } finally { setBusy(null); }
  }

  async function toggleStreamAgent(streamId, agentId, isAssigned) {
    setBusy(`s-${streamId}`); setErrors((x) => ({ ...x, [`s-${streamId}`]: '' }));
    try {
      if (isAssigned) await api.removeStreamAgent(streamId, agentId);
      else await api.addStreamAgent(streamId, agentId);
      reload();
    } catch (err) { setErrors((x) => ({ ...x, [`s-${streamId}`]: err.message })); } finally { setBusy(null); }
  }

  if (!agents || !streams) return <div className="dim" style={{ marginTop: 16 }}>Loading team...</div>;

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div className="panel-head">
        <h2>Team assignments</h2>
        <span className="sub">Scoped to your jurisdiction — a stream can have several agents, and an agent can cover several streams</span>
      </div>

      <table style={{ marginBottom: 20 }}>
        <thead><tr><th>Agent</th><th>Home ward</th><th></th></tr></thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>
                <select defaultValue={a.wardId || ''} onChange={(e) => reassignWard(a.id, e.target.value)} disabled={busy === a.id}>
                  <option value="">Unassigned</option>
                  {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </td>
              <td>{errors[a.id] && <span className="form-error" style={{ marginTop: 0 }}>{errors[a.id]}</span>}</td>
            </tr>
          ))}
          {agents.length === 0 && <tr><td className="dim">No agents in scope yet</td></tr>}
        </tbody>
      </table>
      <p className="dim" style={{ fontSize: 11.5, marginTop: -12, marginBottom: 20 }}>Reassigning a home ward requires a strictly higher jurisdiction than the agent's own (a ward coordinator can't do this — only constituency level and above).</p>

      <div className="panel-head"><h2 style={{ fontSize: 14 }}>Stream assignment</h2></div>
      <table>
        <thead><tr><th>Station</th><th>Stream</th><th>Ward</th><th>Agents assigned</th><th></th></tr></thead>
        <tbody>
          {streams.map((s) => {
            const wardAgents = agents.filter((a) => a.wardId === s.wardId);
            const assignedIds = new Set(s.agents.map((a) => a.id));
            return (
              <tr key={s.id}>
                <td className="mono">{s.stationCode}</td>
                <td>{s.label}</td>
                <td className="dim">{s.wardName}</td>
                <td>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {wardAgents.map((a) => {
                      const isAssigned = assignedIds.has(a.id);
                      return (
                        <button
                          key={a.id} type="button"
                          className={`btn-sm${isAssigned ? ' primary' : ''}`}
                          disabled={busy === `s-${s.id}`}
                          onClick={() => toggleStreamAgent(s.id, a.id, isAssigned)}
                        >
                          {isAssigned ? '✓ ' : '+ '}{a.name}
                        </button>
                      );
                    })}
                    {wardAgents.length === 0 && <span className="dim">No agents in this ward yet</span>}
                  </div>
                </td>
                <td>{errors[`s-${s.id}`] && <span className="form-error" style={{ marginTop: 0 }}>{errors[`s-${s.id}`]}</span>}</td>
              </tr>
            );
          })}
          {streams.length === 0 && <tr><td className="dim">No streams in scope yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
