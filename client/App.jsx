import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.jsx';
import { ThemeProvider } from './theme/ThemeContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import RoleRoute from './components/RoleRoute.jsx';
import Sidebar from './components/Sidebar.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Landing from './pages/Landing.jsx';
import Overview from './pages/Overview.jsx';
import Stations from './pages/Stations.jsx';
import StreamDetail from './pages/StreamDetail.jsx';
import StreamResults from './pages/StreamResults.jsx';
import Results from './pages/Results.jsx';
import Agents from './pages/Agents.jsx';
import Incidents from './pages/Incidents.jsx';
import Reports from './pages/Reports.jsx';
import Users from './pages/Users.jsx';
import AuditLog from './pages/AuditLog.jsx';
import Settings from './pages/Settings.jsx';
import SettingsTeam from './pages/SettingsTeam.jsx';
import ThemeToggleFloating from './components/ThemeToggleFloating.jsx';
import { useAuth } from './auth/AuthContext.jsx';

function Shell({ children }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <main>{children}</main>
    </div>
  );
}

// "/" shows the public marketing landing page to logged-out visitors, and
// the authenticated dashboard to everyone else — unlike every other route,
// it isn't a hard redirect-to-login, since the whole point is to be an
// inviting front door rather than an immediate wall.
function Home() {
  const { user, loading } = useAuth();
  if (loading) return <div className="screen-loading">Loading Campaign HQ…</div>;
  if (!user) return <Landing />;
  return <Shell><Overview /></Shell>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/" element={<Home />} />
      <Route path="/stations" element={<ProtectedRoute><Shell><Stations /></Shell></ProtectedRoute>} />
      <Route path="/streams/:id" element={<ProtectedRoute><Shell><StreamDetail /></Shell></ProtectedRoute>} />
      <Route path="/streams/:id/results" element={<ProtectedRoute><Shell><StreamResults /></Shell></ProtectedRoute>} />
      <Route path="/results" element={<ProtectedRoute><Shell><Results /></Shell></ProtectedRoute>} />
      <Route path="/agents" element={<RoleRoute roles={['coordinator', 'admin']}><Shell><Agents /></Shell></RoleRoute>} />
      <Route path="/incidents" element={<ProtectedRoute><Shell><Incidents /></Shell></ProtectedRoute>} />
      <Route path="/reports" element={<RoleRoute roles={['coordinator', 'admin']}><Shell><Reports /></Shell></RoleRoute>} />
      <Route path="/users" element={<RoleRoute roles={['coordinator', 'admin']}><Shell><Users /></Shell></RoleRoute>} />
      <Route path="/audit" element={<RoleRoute roles={['admin']}><Shell><AuditLog /></Shell></RoleRoute>} />
      <Route path="/settings" element={<ProtectedRoute><Shell><Settings /></Shell></ProtectedRoute>} />
      <Route path="/settings/team" element={<RoleRoute roles={['coordinator', 'admin']}><Shell><SettingsTeam /></Shell></RoleRoute>} />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <ThemeToggleFloating />
        <AppRoutes />
      </AuthProvider>
    </ThemeProvider>
  );
}
