import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.me()
      .then((res) => setUser(res.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  // Any request that comes back 401 (session expired, cookie cleared, etc.)
  // dispatches this from api.js. Clearing `user` here — from one place —
  // means every page's ProtectedRoute/RoleRoute naturally redirects to
  // /login instead of each page needing its own expiry handling.
  useEffect(() => {
    const onExpired = () => setUser(null);
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await api.login(email, password);
    setUser(res.user);
    return res.user;
  }, []);

  // Self-signup creates a pending account only — it does not log the user
  // in. A coordinator or admin for the requested jurisdiction has to
  // approve it first (Users page).
  const register = useCallback(async (body) => {
    return api.register(body);
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* cookie may already be gone */ }
    setUser(null);
  }, []);

  const changePassword = useCallback(async (currentPassword, newPassword) => {
    return api.changePassword(currentPassword, newPassword);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, register, changePassword }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
