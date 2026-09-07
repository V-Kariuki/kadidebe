import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useTheme } from '../theme/ThemeContext.jsx';

const ROLE_LABEL = { admin: 'Administrator', coordinator: 'Campaign Coordinator', agent: 'Field Agent', aspirant: 'Aspirant (view-only)' };

export default function Settings() {
  const { user, logout } = useAuth();
  const { theme, toggleTheme } = useTheme();

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Profile</h1>
          <p>Your account and security</p>
        </div>
      </div>

      <div className="panel" style={{ maxWidth: 480 }}>
        <div className="panel-head"><h2>Account</h2></div>
        <div className="settings-row"><span>Name</span><span>{user?.name}</span></div>
        <div className="settings-row"><span>Email</span><span>{user?.email}</span></div>
        <div className="settings-row"><span>Phone</span><span>{user?.phone || '—'}</span></div>
        <div className="settings-row"><span>Role</span><span>{ROLE_LABEL[user?.role]}</span></div>
        <button className="btn-sm" style={{ marginTop: 16 }} onClick={logout}>Log out</button>
      </div>

      <div className="panel" style={{ maxWidth: 480, marginTop: 16 }}>
        <div className="panel-head"><h2>Appearance</h2></div>
        <div className="settings-row">
          <span>Theme</span>
          <button className="btn-sm" onClick={toggleTheme}>{theme === 'dark' ? '☀️ Switch to light' : '🌙 Switch to dark'}</button>
        </div>
      </div>

      <ChangePassword />

      <div className="panel" style={{ maxWidth: 480, marginTop: 16 }}>
        <div className="panel-head"><h2>How this build is secured</h2></div>
        <ul className="dim" style={{ fontSize: 12.5, lineHeight: 1.8, paddingLeft: 18 }}>
          <li>Sessions use httpOnly, sameSite cookies — not readable by page JS</li>
          <li>Every write requires a matching CSRF token</li>
          <li>Passwords are bcrypt-hashed at 12 rounds, never stored in plain text</li>
          <li>Repeated failed logins lock the account for 15 minutes</li>
          <li>Every tally change, incident, and login is written to an immutable audit log</li>
          <li>Coordinators only see agents and requests within their own jurisdiction; agents only see their assigned stream(s)</li>
          <li>Evidence files (result photos, incident media) require a session to view — never publicly served</li>
        </ul>
      </div>
    </>
  );
}

function ChangePassword() {
  const { changePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError(''); setDone(false);
    if (next !== confirm) return setError('New passwords do not match');
    if (next.length < 8) return setError('New password must be at least 8 characters');
    setBusy(true);
    try {
      await changePassword(current, next);
      setCurrent(''); setNext(''); setConfirm('');
      setDone(true);
    } catch (err) {
      setError(err.message || 'Could not change password');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ maxWidth: 480, marginTop: 16 }}>
      <div className="panel-head"><h2>Change password</h2></div>
      <form onSubmit={submit} className="stack-form">
        <label>Current password</label>
        <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        <label>New password</label>
        <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
        <label>Confirm new password</label>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required />
        {error && <div className="form-error">{error}</div>}
        {done && <div className="form-notice">Password updated.</div>}
        <button type="submit" className="primary" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button>
      </form>
    </div>
  );
}
