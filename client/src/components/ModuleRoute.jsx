import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

// Mirrors the server's requireModule guard. The server is the real
// enforcement point; this exists so a disabled module renders an
// explanation instead of a page full of failed requests.
export default function ModuleRoute({ module, children }) {
  const { user, loading, hasModule } = useAuth();
  if (loading) return <div className="screen-loading">Loading Campaign HQ…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!hasModule(module)) {
    return (
      <div className="panel" style={{ maxWidth: 520, marginTop: 24 }}>
        <div className="panel-head"><h2>Not available in this instance</h2></div>
        <p className="dim" style={{ fontSize: 13, lineHeight: 1.6 }}>
          This feature isn't enabled for your instance. If you need it, ask your platform
          administrator to switch it on.
        </p>
      </div>
    );
  }
  return children;
}
