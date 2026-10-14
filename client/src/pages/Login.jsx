import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { api } from '../api.js';

export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [tenantSlug, setTenantSlug] = useState('');
  const [needsTenant, setNeedsTenant] = useState(false);
  const [instances, setInstances] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const notice = location.state?.notice;

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await login(email, password, tenantSlug || undefined);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      // The same email can exist in several instances, in which case the
      // server asks which one rather than guessing.
      if (err.details?.needsTenant || /more than one instance/i.test(err.message || '')) {
        setNeedsTenant(true);
        api.publicInstances().then(setInstances).catch(() => setInstances([]));
        setError('That email is registered in more than one instance — choose which below.');
      } else {
        setError(err.message || 'Login failed');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="brand-mark" style={{ width: 44, height: 40, margin: '0 auto 14px' }}>
          <svg viewBox="0 0 34 30" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon points="17,0 30,7.5 30,22.5 17,30 4,22.5 4,7.5" fill="#E8A33D" />
            <polygon points="17,5 25,9.5 25,20.5 17,25 9,20.5 9,9.5" fill="#1B140A" />
            <circle cx="17" cy="15" r="3.2" fill="#E8A33D" />
          </svg>
        </div>
        <h1>Niko Kadi Twende kwa Debe</h1>
        <p className="sub">Sign in to Campaign HQ</p>

        {notice && <div className="form-notice">{notice}</div>}

        <form onSubmit={onSubmit}>
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          {needsTenant && (
            <>
              <label>Instance</label>
              <select value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value)} required>
                <option value="">Select your instance…</option>
                {instances.map((i) => <option key={i.slug} value={i.slug}>{i.name} — {i.jurisdictionLabel}</option>)}
              </select>
            </>
          )}
          {error && <div className="form-error">{error}</div>}
          <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>

        <p className="sub" style={{ marginTop: 18, marginBottom: 0 }}>
          Need access? <Link to="/signup">Request an account</Link>
        </p>
      </div>
    </div>
  );
}
