import { Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';

export default function RoleRoute({ roles, children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="screen-loading">Loading Campaign HQ…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}
