import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { api } from '../api.js';

const JURISDICTION_LABEL = { ward: 'Ward', constituency: 'Constituency', county: 'County', national: 'National' };

export default function Signup() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [geo, setGeo] = useState(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [roleRequested, setRoleRequested] = useState('agent');
  const [jurisdictionType, setJurisdictionType] = useState('ward');
  const [jurisdictionId, setJurisdictionId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.publicGeo().then(setGeo).catch(() => setGeo({ counties: [], constituencies: [], wards: [] })); }, []);

  // Agents are always ward-scoped. Admin is always national. Coordinators
  // and aspirants pick their own level.
  useEffect(() => {
    if (roleRequested === 'agent') setJurisdictionType('ward');
    if (roleRequested === 'admin') setJurisdictionType('national');
  }, [roleRequested]);

  useEffect(() => { setJurisdictionId(''); }, [jurisdictionType]);

  function jurisdictionOptions() {
    if (!geo) return [];
    if (jurisdictionType === 'ward') return geo.wards;
    if (jurisdictionType === 'constituency') return geo.constituencies;
    if (jurisdictionType === 'county') return geo.counties;
    return [];
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError('');

    if (password !== confirm) return setError('Passwords do not match');
    if (password.length < 8) return setError('Password must be at least 8 characters');
    if (jurisdictionType !== 'national' && !jurisdictionId) return setError('Please select a jurisdiction');

    setBusy(true);
    try {
      await register({
        name, email, phone, password, roleRequested, jurisdictionType,
        jurisdictionId: jurisdictionType === 'national' ? null : jurisdictionId
      });
      navigate('/login', {
        replace: true,
        state: { notice: 'Account requested. A coordinator or admin for that jurisdiction needs to approve it before you can sign in.' }
      });
    } catch (err) {
      setError(err.message || 'Could not create account');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card" style={{ maxWidth: 400 }}>
        <div className="brand-mark" style={{ width: 44, height: 40, margin: '0 auto 14px' }}>
          <svg viewBox="0 0 34 30" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon points="17,0 30,7.5 30,22.5 17,30 4,22.5 4,7.5" fill="#E8A33D" />
            <polygon points="17,5 25,9.5 25,20.5 17,25 9,20.5 9,9.5" fill="#1B140A" />
            <circle cx="17" cy="15" r="3.2" fill="#E8A33D" />
          </svg>
        </div>
        <h1>Niko Kadi Twende kwa Debe</h1>
        <p className="sub">Request access to Campaign HQ</p>

        <form onSubmit={onSubmit}>
          <label>Full name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          <label>Phone number</label>
          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} autoComplete="tel" placeholder="07XX XXX XXX" required />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
          <label>Confirm password</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required />

          <label>Requesting to be a</label>
          <select value={roleRequested} onChange={(e) => setRoleRequested(e.target.value)}>
            <option value="agent">Field Agent</option>
            <option value="coordinator">Coordinator</option>
            <option value="aspirant">Aspirant (view-only)</option>
            <option value="admin">Admin</option>
          </select>

          {roleRequested === 'admin' && (
            <p className="sub" style={{ marginTop: 8, marginBottom: 0 }}>Admin requests can only be approved by an existing admin.</p>
          )}

          {(roleRequested === 'coordinator' || roleRequested === 'aspirant') && (
            <>
              <label>{roleRequested === 'aspirant' ? 'Level of interest' : 'Coordinator level'}</label>
              <select value={jurisdictionType} onChange={(e) => setJurisdictionType(e.target.value)}>
                <option value="ward">Ward</option>
                <option value="constituency">Constituency</option>
                <option value="county">County</option>
                <option value="national">National</option>
              </select>
            </>
          )}

          {jurisdictionType !== 'national' && (
            <>
              <label>{JURISDICTION_LABEL[jurisdictionType]}</label>
              <select value={jurisdictionId} onChange={(e) => setJurisdictionId(e.target.value)} required>
                <option value="">Select {JURISDICTION_LABEL[jurisdictionType].toLowerCase()}…</option>
                {jurisdictionOptions().map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </>
          )}

          {error && <div className="form-error">{error}</div>}
          <button type="submit" disabled={busy || !geo}>{busy ? 'Submitting…' : 'Request account'}</button>
        </form>

        <p className="sub" style={{ marginTop: 18, marginBottom: 0 }}>
          Already approved? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
