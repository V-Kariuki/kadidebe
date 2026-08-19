import { Routes, Route } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext.jsx';
import ProtectedRoute from './components/ProtectedRoute.jsx';
import RoleRoute from './components/RoleRoute.jsx';
import Sidebar from './components/Sidebar.jsx';
import Login from './pages/Login.jsx';
import Signup from './pages/Signup.jsx';
import Overview from './pages/Overview.jsx';
import Stations from './pages/Stations.jsx';
import Agents from './pages/Agents.jsx';
import Incidents from './pages/Incidents.jsx';
import Reports from './pages/Reports.jsx';
import Users from './pages/Users.jsx';
import AuditLog from './pages/AuditLog.jsx';
import Settings from './pages/Settings.jsx';

function Shell({ children }) {
  return (
    <div className="app-shell">
      <Sidebar />
      <main>{children}</main>
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/" element={<ProtectedRoute><Shell><Overview /></Shell></ProtectedRoute>} />
      <Route path="/stations" element={<ProtectedRoute><Shell><Stations /></Shell></ProtectedRoute>} />
      <Route path="/agents" element={<RoleRoute roles={['coordinator', 'admin']}><Shell><Agents /></Shell></RoleRoute>} />
      <Route path="/incidents" element={<ProtectedRoute><Shell><Incidents /></Shell></ProtectedRoute>} />
      <Route path="/reports" element={<RoleRoute roles={['coordinator', 'admin']}><Shell><Reports /></Shell></RoleRoute>} />
      <Route path="/users" element={<RoleRoute roles={['admin']}><Shell><Users /></Shell></RoleRoute>} />
      <Route path="/audit" element={<RoleRoute roles={['admin']}><Shell><AuditLog /></Shell></RoleRoute>} />
      <Route path="/settings" element={<ProtectedRoute><Shell><Settings /></Shell></ProtectedRoute>} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
