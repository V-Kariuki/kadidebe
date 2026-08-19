import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function Signup() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e) {
    e.preventDefault();
    setError('');

    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }

    setBusy(true);
    try {
      await register(name, email, password);
      navigate('/login', {
        replace: true,
        state: { notice: 'Account requested. An admin needs to approve it and assign a role before you can sign in.' }
      });
    } catch (err) {
      setError(err.message || 'Could not create account');
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
        <p className="sub">Request access to Campaign HQ</p>

        <form onSubmit={onSubmit}>
          <label>Full name</label>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
          <label>Password</label>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required />
          <label>Confirm password</label>
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" minLength={8} required />
          {error && <div className="form-error">{error}</div>}
          <button type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Request account'}</button>
        </form>

        <p className="sub" style={{ marginTop: 18, marginBottom: 0 }}>
          Already approved? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
