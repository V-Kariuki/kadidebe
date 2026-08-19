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

  const login = useCallback(async (email, password) => {
    const res = await api.login(email, password);
    setUser(res.user);
    return res.user;
  }, []);

  // Self-signup creates a pending account only — it does not log the user
  // in. An admin has to approve it and assign a role first (Users page).
  const register = useCallback(async (name, email, password) => {
    return api.register(name, email, password);
  }, []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* cookie may already be gone */ }
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, register }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
