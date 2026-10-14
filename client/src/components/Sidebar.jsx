import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

const ROLE_LABEL = {
  superadmin: 'Platform Administrator', admin: 'Administrator',
  coordinator: 'Campaign Coordinator', agent: 'Field Agent', aspirant: 'Aspirant (view-only)'
};

export default function Sidebar() {
  const { user, tenant, logout, hasModule, viewInstance } = useAuth();
  const navigate = useNavigate();
  const initials = (user?.name || '?').split(' ').map((s) => s[0]).join('').slice(0, 2).toUpperCase();
  const isSuper = user?.role === 'superadmin';
  const isStaff = user?.role === 'coordinator' || user?.role === 'admin' || isSuper;
  const canView = isStaff || user?.role === 'aspirant';
  // A superadmin has no instance of their own, so the operational screens
  // only make sense once they've opened one.
  const inInstance = !isSuper || !!tenant;

  async function handleLogout() { await logout(); navigate('/'); }
  async function exitInstance() { await viewInstance(null); navigate('/platform'); }

  const item = (to, label, opts = {}) => (
    <NavLink to={to} end={opts.end} className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
      <span className="dot"></span> {label}
    </NavLink>
  );

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
        <div className="brand-text">
          {tenant ? tenant.name : 'Niko Kadi'}
          <span>{tenant ? `${tenant.jurisdictionLabel} instance` : 'Platform Console'}</span>
        </div>
      </div>

      {isSuper && tenant && (
        <div className="form-notice" style={{ margin: '0 0 12px', fontSize: 11.5 }}>
          Viewing as <b>{tenant.name}</b>
          <button className="btn-sm" style={{ marginTop: 8, width: '100%' }} onClick={exitInstance}>← Back to platform</button>
        </div>
      )}

      <nav>
        {isSuper && (
          <>
            <div className="nav-label">Platform</div>
            {item('/platform', 'Instances')}
            {item('/platform/register', 'Shared register')}
          </>
        )}

        {inInstance && (
          <>
            <div className="nav-label" style={{ marginTop: isSuper ? 10 : 0 }}>Monitor</div>
            {item('/', 'Overview', { end: true })}
            {hasModule('stations') && item('/stations', 'Polling Stations')}
            {hasModule('results') && item('/results', 'Results')}
            {canView && hasModule('reports') && item('/reports', 'Turnout & Reports')}

            <div className="nav-label" style={{ marginTop: 10 }}>Ground Game</div>
            {canView && hasModule('agents') && item('/agents', 'Agents')}
            {hasModule('incidents') && item('/incidents', 'Incidents')}

            {isStaff && (
              <>
                <div className="nav-label" style={{ marginTop: 10 }}>Admin</div>
                {item('/users', 'Users')}
                {hasModule('audit') && item('/audit', 'Audit Log')}
              </>
            )}
          </>
        )}

        <div className="nav-label" style={{ marginTop: 10 }}></div>
        {isStaff && inInstance && item('/settings/team', 'Team & Structure')}
        {item('/settings', 'Profile')}
      </nav>

      <div className="sidebar-footer">
        <div className="avatar">{initials}</div>
        <div style={{ flex: 1 }}>
          <div className="who">{user?.name}</div>
          <div className="role">{ROLE_LABEL[user?.role] || user?.role}</div>
        </div>
        <button className="logout-btn" onClick={handleLogout} title="Log out of Campaign HQ">
          <span aria-hidden="true">⎋</span> Log out
        </button>
      </div>
    </aside>
  );
}
