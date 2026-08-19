import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const ROLE_LABEL = { admin: 'Administrator', coordinator: 'Campaign Coordinator', agent: 'Field Agent' };

export default function Sidebar() {
  const { user, logout } = useAuth();
  const initials = (user?.name || '?').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const isStaff = user?.role === 'coordinator' || user?.role === 'admin';

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <svg viewBox="0 0 34 30" fill="none" xmlns="http://www.w3.org/2000/svg">
            <polygon points="17,0 30,7.5 30,22.5 17,30 4,22.5 4,7.5" fill="#E8A33D" />
            <polygon points="17,5 25,9.5 25,20.5 17,25 9,20.5 9,9.5" fill="#1B140A" />
            <circle cx="17" cy="15" r="3.2" fill="#E8A33D" />
          </svg>
        </div>
        <div className="brand-text">Niko Kadi<br />Twende kwa Debe<span>Campaign HQ</span></div>
      </div>

      <nav>
        <div className="nav-label">Monitor</div>
        <NavLink to="/" end className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}><span className="dot"></span> Overview</NavLink>
        <NavLink to="/stations" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}><span className="dot"></span> Polling Stations</NavLink>
        {isStaff && <NavLink to="/reports" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}><span className="dot"></span> Turnout & Reports</NavLink>}

        <div className="nav-label" style={{ marginTop: 10 }}>Ground Game</div>
        {isStaff && <NavLink to="/agents" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}><span className="dot"></span> Agents</NavLink>}
        <NavLink to="/incidents" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}><span className="dot"></span> Incidents</NavLink>

        {user?.role === 'admin' && (
          <>
            <div className="nav-label" style={{ marginTop: 10 }}>Admin</div>
            <NavLink to="/users" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}><span className="dot"></span> Users</NavLink>
            <NavLink to="/audit" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}><span className="dot"></span> Audit Log</NavLink>
          </>
        )}

        <div className="nav-label" style={{ marginTop: 10 }}></div>
        <NavLink to="/settings" className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}><span className="dot"></span> Settings</NavLink>
      </nav>

      <div className="sidebar-footer">
        <div className="avatar">{initials}</div>
        <div style={{ flex: 1 }}>
          <div className="who">{user?.name}</div>
          <div className="role">{ROLE_LABEL[user?.role] || user?.role}</div>
        </div>
        <button className="logout-btn" onClick={logout} title="Log out">⎋</button>
      </div>
    </aside>
  );
}
