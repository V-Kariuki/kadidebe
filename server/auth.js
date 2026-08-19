import jwt from 'jsonwebtoken';
import crypto from 'crypto';

const isProd = process.env.NODE_ENV === 'production';

if (isProd && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16)) {
  throw new Error(
    'JWT_SECRET must be set to a strong random value in production. ' +
    'Generate one with: openssl rand -hex 32'
  );
}

export const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-do-not-use-in-production';
export const TOKEN_COOKIE = 'ncn_token';
export const CSRF_COOKIE = 'ncn_csrf';
const TOKEN_TTL = '8h';

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role, wardId: user.ward_id || null },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

// When the frontend and backend are on different domains (e.g. frontend on
// Vercel, backend on Render/Railway), the browser will only send cookies on
// cross-site requests if sameSite is 'none' — which in turn requires
// 'secure' (HTTPS). Same-origin deployments should leave this off and keep
// the stricter 'strict' setting.
const crossSite = process.env.CROSS_SITE_COOKIES === 'true';

if (crossSite && !isProd) {
  console.warn(
    'CROSS_SITE_COOKIES=true requires HTTPS to work (browsers refuse ' +
    'sameSite=none cookies without Secure). This is fine on your deployed ' +
    'host, but cookies will not be set when testing over plain http://localhost.'
  );
}

const cookieBase = {
  httpOnly: true,
  secure: isProd || crossSite,
  sameSite: crossSite ? 'none' : 'strict',
  maxAge: 8 * 60 * 60 * 1000
};

export function setAuthCookies(res, user) {
  const token = signToken(user);
  const csrfToken = crypto.randomBytes(24).toString('hex');
  res.cookie(TOKEN_COOKIE, token, cookieBase);
  res.cookie(CSRF_COOKIE, csrfToken, { ...cookieBase, httpOnly: false });
}

export function clearAuthCookies(res) {
  res.clearCookie(TOKEN_COOKIE, cookieBase);
  res.clearCookie(CSRF_COOKIE, { ...cookieBase, httpOnly: false });
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[TOKEN_COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

export function requireCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path === '/api/auth/login' || req.path === '/api/auth/register') return next();
  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do that' });
    }
    next();
  };
}
