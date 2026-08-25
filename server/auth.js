const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'veridict-dev-secret-change-me';
const COOKIE = 'veridict_session';

function sign(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.display_name },
    SECRET,
    { expiresIn: '7d' }
  );
}

function setSession(res, user) {
  res.cookie(COOKIE, sign(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE);
}

/** Attaches req.user when a valid cookie is present. Never rejects. */
function readSession(req, _res, next) {
  const token = req.cookies?.[COOKIE];
  if (token) {
    try {
      const p = jwt.verify(token, SECRET);
      req.user = { id: p.sub, role: p.role, name: p.name };
    } catch {
      /* expired or tampered — treat as signed out */
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Your account does not have access to this.' });
    }
    next();
  };
}

module.exports = { sign, setSession, clearSession, readSession, requireAuth, requireRole, COOKIE };
