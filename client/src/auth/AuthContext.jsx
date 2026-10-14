import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setViewingTenantId } from '../api.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [tenant, setTenant] = useState(null);
  const [modules, setModules] = useState(null);
  const [positionIds, setPositionIds] = useState(null);
  const [loading, setLoading] = useState(true);
  // Only meaningful for a superadmin: the instance they've opened to inspect.
  const [viewing, setViewing] = useState(() => {
    try { return JSON.parse(sessionStorage.getItem('kadidebe-viewing') || 'null'); } catch { return null; }
  });

  // Apply the stored selection to the api layer before the first request.
  if (viewing?.id) setViewingTenantId(viewing.id);

  function applySession(res) {
    setUser(res.user || null);
    setTenant(res.tenant || null);
    setModules(res.modules || null);
    setPositionIds(res.positionIds ?? null);
  }

  useEffect(() => {
    api.me()
      .then(applySession)
      .catch(() => { setUser(null); setTenant(null); setModules(null); })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const onExpired = () => { setUser(null); setTenant(null); setModules(null); };
    window.addEventListener('auth:expired', onExpired);
    return () => window.removeEventListener('auth:expired', onExpired);
  }, []);

  const login = useCallback(async (email, password, tenantSlug) => {
    const res = await api.login(email, password, tenantSlug);
    applySession(res);
    return res.user;
  }, []);

  const register = useCallback(async (body) => api.register(body), []);

  const logout = useCallback(async () => {
    try { await api.logout(); } catch { /* cookie may already be gone */ }
    setViewingTenantId(null);
    try { sessionStorage.removeItem('kadidebe-viewing'); } catch { /* ignore */ }
    setViewing(null);
    setUser(null); setTenant(null); setModules(null); setPositionIds(null);
  }, []);

  const changePassword = useCallback(async (currentPassword, newPassword) =>
    api.changePassword(currentPassword, newPassword), []);

  // The single question the UI asks before rendering any feature. The
  // server enforces this independently — this only avoids showing dead
  // links for modules the instance doesn't have.
  const hasModule = useCallback((key) => {
    // A superadmin outside any instance sees everything; once they open one
    // they see exactly what that instance's users see.
    if (user?.role === 'superadmin' && !tenant) return true;
    if (!modules) return false;
    return !!modules[key];
  }, [modules, user, tenant]);

  const viewInstance = useCallback(async (t) => {
    const next = t ? { id: t.id, name: t.name } : null;
    setViewingTenantId(next?.id || null);
    try {
      if (next) sessionStorage.setItem('kadidebe-viewing', JSON.stringify(next));
      else sessionStorage.removeItem('kadidebe-viewing');
    } catch { /* storage unavailable */ }
    setViewing(next);
    const res = await api.me();     // now resolves the chosen tenant's config
    applySession(res);
  }, []);

  return (
    <AuthContext.Provider value={{
      user, tenant, modules, positionIds, loading, viewing,
      login, logout, register, changePassword, hasModule, viewInstance
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
