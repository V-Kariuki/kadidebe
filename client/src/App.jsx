import { Routes, Route, Navigate } from 'react-router-dom';
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
import StreamCustody from './pages/StreamCustody.jsx';
import StreamBooklets from './pages/StreamBooklets.jsx';
import StreamTurnout from './pages/StreamTurnout.jsx';
import Results from './pages/Results.jsx';
import Agents from './pages/Agents.jsx';
import Incidents from './pages/Incidents.jsx';
import Reports from './pages/Reports.jsx';
import Users from './pages/Users.jsx';
import AuditLog from './pages/AuditLog.jsx';
import Settings from './pages/Settings.jsx';
import SettingsTeam from './pages/SettingsTeam.jsx';
import ThemeToggleFloating from './components/ThemeToggleFloating.jsx';
import ModuleRoute from './components/ModuleRoute.jsx';
import Platform from './pages/Platform.jsx';
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
  const { user, tenant, loading } = useAuth();
  if (loading) return <div className="screen-loading">Loading Campaign HQ…</div>;
  if (!user) return <Landing />;
  // A superadmin has no instance of their own, so the dashboard has nothing
  // to show them until they open one — send them to the platform console.
  if (user.role === 'superadmin' && !tenant) return <Navigate to="/platform" replace />;
  return <Shell><Overview /></Shell>;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/" element={<Home />} />
      <Route path="/stations" element={<ModuleRoute module="stations"><Shell><Stations /></Shell></ModuleRoute>} />
      <Route path="/streams/:id" element={<ModuleRoute module="stations"><Shell><StreamDetail /></Shell></ModuleRoute>} />
      <Route path="/streams/:id/custody" element={<ModuleRoute module="ballot_custody"><Shell><StreamCustody /></Shell></ModuleRoute>} />
      <Route path="/streams/:id/booklets" element={<ModuleRoute module="booklets"><Shell><StreamBooklets /></Shell></ModuleRoute>} />
      <Route path="/streams/:id/turnout" element={<ModuleRoute module="turnout"><Shell><StreamTurnout /></Shell></ModuleRoute>} />
      <Route path="/streams/:id/results" element={<ModuleRoute module="results"><Shell><StreamResults /></Shell></ModuleRoute>} />
      <Route path="/results" element={<ModuleRoute module="results"><Shell><Results /></Shell></ModuleRoute>} />
      <Route path="/agents" element={<ModuleRoute module="agents"><Shell><Agents /></Shell></ModuleRoute>} />
      <Route path="/incidents" element={<ModuleRoute module="incidents"><Shell><Incidents /></Shell></ModuleRoute>} />
      <Route path="/reports" element={<ModuleRoute module="reports"><Shell><Reports /></Shell></ModuleRoute>} />
      <Route path="/users" element={<RoleRoute roles={['coordinator', 'admin', 'superadmin']}><Shell><Users /></Shell></RoleRoute>} />
      <Route path="/platform" element={<RoleRoute roles={['superadmin']}><Shell><Platform /></Shell></RoleRoute>} />
      <Route path="/platform/register" element={<RoleRoute roles={['superadmin']}><Shell><SettingsTeam /></Shell></RoleRoute>} />
      <Route path="/audit" element={<ModuleRoute module="audit"><Shell><AuditLog /></Shell></ModuleRoute>} />
      <Route path="/settings" element={<ProtectedRoute><Shell><Settings /></Shell></ProtectedRoute>} />
      <Route path="/settings/team" element={<RoleRoute roles={['coordinator', 'admin', 'superadmin']}><Shell><SettingsTeam /></Shell></RoleRoute>} />
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
