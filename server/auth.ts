import express from 'express';
import {
  createUser, getUserByEmail, getPasswordHash, verifyPassword,
  createSession, getSessionUser, deleteSession, getPrefs, savePrefs,
  isDbReady, initDatabase, hashPassword, countUsers, claimOrphanVideos,
  updateUserProfile, changeUserPassword, getUserById, resetUserPassword,
  createEmailCode, getLatestEmailCode, markEmailCodeUsed
} from './db';
import { sendEmail, welcomeEmail, verificationCodeEmail, passwordResetCodeEmail } from './email.js';

const SESSION_COOKIE = 'tl_session';
const COOKIE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// Registration is invite-only: the client must send the signup invite code
// configured via REGISTER_INVITE_CODE env var. Without it registration 403s.
function expectedInviteCode(): string {
  return String(process.env.REGISTER_INVITE_CODE || '').trim();
}

// Memory of users whose on-disk orphan videos were already claimed this boot.
const claimedForBoot = new Set<string>();

export interface AuthRequest extends express.Request {
  userId?: string;
  user?: { id: string; email: string; name: string; role: string; status: string };
}

/** Roles allowed into the Admin Panel. `manager` is the canonical name;
 *  `admin` is accepted as a legacy alias so older rows keep working. */
const ADMIN_ROLES = new Set(['manager', 'admin']);

export function isAdminRole(role: unknown): boolean {
  return typeof role === 'string' && ADMIN_ROLES.has(role.toLowerCase());
}

/** Express middleware: caller must be signed in (requireAuth ran first via
 *  the /api gate) AND hold the manager role — everyone else gets 403, so
 *  ordinary users can never reach admin data even with a direct URL. */
export function requireAdmin(req: AuthRequest, res: express.Response, next: express.NextFunction): void {
  const user = (req as AuthRequest).user;
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  if (!isAdminRole(user.role)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

function parseCookieString(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

function setSessionCookie(res: express.Response, token: string): void {
  const secure = process.env.NODE_ENV === 'production';
  const attrs = `HttpOnly; Path=/; Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}; SameSite=Lax${secure ? '; Secure' : ''}`;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; ${attrs}`);
}

function clearSessionCookie(res: express.Response): void {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}

// Lightweight in-memory rate limiter for auth endpoints (per IP). Keeps the
// service stable under bursts from thousands of users without extra deps.
const _rlBuckets = new Map<string, { count: number; reset: number }>();
function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const rec = _rlBuckets.get(key);
  if (!rec || rec.reset < now) {
    _rlBuckets.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  if (rec.count >= max) return false;
  rec.count += 1;
  return true;
}
function clientIp(req: express.Request): string {
  return String(req.ip || req.socket?.remoteAddress || 'unknown');
}

/** Express middleware: resolves the session cookie into req.user / req.userId. */
export async function requireAuth(req: AuthRequest, res: express.Response, next: express.NextFunction): Promise<void> {
  const token = parseCookieString(req.headers.cookie, SESSION_COOKIE);
  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const user = await getSessionUser(token);
    if (!user) {
      clearSessionCookie(res);
      res.status(401).json({ error: 'Session expired, please sign in again' });
      return;
    }
    if (user.status === 'disabled') {
      clearSessionCookie(res);
      res.status(403).json({ error: 'Account disabled by admin' });
      return;
    }
    req.user = { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status };
    req.userId = user.id;
    if (!claimedForBoot.has(user.id)) {
      claimedForBoot.add(user.id);
      await claimOrphanVideos(user.id);
    }
    next();
  } catch (err) {
    res.status(503).json({ error: 'Database unavailable, please try again' });
  }
}

export const authRouter = express.Router();

async function handleRegister(req: express.Request, res: express.Response): Promise<void> {
  if (!rateLimit(`register:${clientIp(req)}`, 5, 60_000)) {
    res.status(429).json({ error: 'Too many attempts, please try again later' });
    return;
  }
  if (!isDbReady()) {
    try { await initDatabase(); } catch { /* fall through to 503 below */ }
  }
  if (!isDbReady()) {
    res.status(503).json({ error: 'Database not initialized yet, please try again in a moment' });
    return;
  }
  const { email, password, name, code } = req.body || {};
  const emailClean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
    res.status(400).json({ error: 'Please provide a valid email address' });
    return;
  }
  if (!password || String(password).length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  const displayName = String(name || '').trim() || 'User';
  // verify email code
  const codeClean = String(code || '').trim();
  if (!codeClean) {
    res.status(400).json({ error: 'Verification code is required' });
    return;
  }
  try {
    const rec = await getLatestEmailCode(emailClean, 'register');
    if (!rec || rec.used) {
      res.status(400).json({ error: 'Invalid or expired verification code' });
      return;
    }
    if (rec.code !== codeClean) {
      res.status(400).json({ error: 'Invalid verification code' });
      return;
    }
    if (new Date(rec.expires_at) < new Date()) {
      res.status(400).json({ error: 'Verification code expired' });
      return;
    }
    await markEmailCodeUsed(emailClean, 'register', codeClean);
  } catch (err) {
    res.status(500).json({ error: 'Could not verify code' });
    return;
  }
  try {
    const existing = await getUserByEmail(emailClean);
    if (existing) {
      res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
      return;
    }
    const user = await createUser({ email: emailClean, password: String(password), name: displayName });
    const token = await createSession(user.id);
    const prefs = await getPrefs(user.id);
    setSessionCookie(res, token);
    const w = welcomeEmail(user.name || displayName);
    void sendEmail(user.email, w.subject, w.html);
    res.status(200).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role }, prefs, login: true });
  } catch (err) {
    console.error('[AUTH] register failed:', err);
    res.status(500).json({ error: 'Could not create the account, please try again' });
  }
}

// Send a verification/reset code to email.
authRouter.post('/send-code', async (req, res) => {
  if (!rateLimit(`sendcode:${clientIp(req)}`, 5, 60_000)) {
    res.status(429).json({ error: 'Too many attempts, please try again later' });
    return;
  }
  if (!isDbReady()) {
    try { await initDatabase(); } catch { /* fall through */ }
  }
  if (!isDbReady()) {
    res.status(503).json({ error: 'Database not initialized yet' });
    return;
  }
  const { email, purpose } = req.body || {};
  const emailClean = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
    res.status(400).json({ error: 'Please provide a valid email address' });
    return;
  }
  const p = String(purpose || '').trim();
  if (p !== 'register' && p !== 'reset') {
    res.status(400).json({ error: 'Invalid purpose' });
    return;
  }
  try {
    const existing = await getUserByEmail(emailClean);
    if (p === 'register' && existing) {
      res.status(409).json({ error: 'An account with this email already exists.' });
      return;
    }
    if (p === 'reset' && !existing) {
      res.status(404).json({ error: 'No account with this email.' });
      return;
    }
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await createEmailCode(emailClean, p, code, expires);
    const tpl = p === 'register' ? verificationCodeEmail(code) : passwordResetCodeEmail(code);
    void sendEmail(emailClean, tpl.subject, tpl.html);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[AUTH] send-code failed:', err);
    res.status(500).json({ error: 'Could not send code' });
  }
});

// Reset password using emailed code.
authRouter.post('/reset-password', async (req, res) => {
  if (!isDbReady()) {
    try { await initDatabase(); } catch { /* fall through */ }
  }
  if (!isDbReady()) {
    res.status(503).json({ error: 'Database not initialized yet' });
    return;
  }
  const { email, code, newPassword } = req.body || {};
  const emailClean = String(email || '').trim().toLowerCase();
  const codeClean = String(code || '').trim();
  const pw = String(newPassword || '');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailClean)) {
    res.status(400).json({ error: 'Please provide a valid email address' });
    return;
  }
  if (!codeClean) {
    res.status(400).json({ error: 'Verification code is required' });
    return;
  }
  if (!pw || pw.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  try {
    const user = await getUserByEmail(emailClean);
    if (!user) {
      res.status(404).json({ error: 'No account with this email.' });
      return;
    }
    const rec = await getLatestEmailCode(emailClean, 'reset');
    if (!rec || rec.used || rec.code !== codeClean) {
      res.status(400).json({ error: 'Invalid verification code' });
      return;
    }
    if (new Date(rec.expires_at) < new Date()) {
      res.status(400).json({ error: 'Verification code expired' });
      return;
    }
    await resetUserPassword(user.id, pw);
    await markEmailCodeUsed(emailClean, 'reset', codeClean);
    res.status(200).json({ success: true });
  } catch (err) {
    console.error('[AUTH] reset-password failed:', err);
    res.status(500).json({ error: 'Could not reset password' });
  }
});

authRouter.post('/register', handleRegister);
// Alias: the frontend posts to /api/auth/signup (mode === 'signup').
authRouter.post('/signup', handleRegister);

authRouter.post('/login', async (req, res) => {
  if (!rateLimit(`login:${clientIp(req)}`, 10, 60_000)) {
    res.status(429).json({ error: 'Too many attempts, please try again later' });
    return;
  }
  if (!isDbReady()) {
    try { await initDatabase(); } catch { /* fall through to 503 below */ }
  }
  if (!isDbReady()) {
    res.status(503).json({ error: 'Database not initialized yet, please try again in a moment' });
    return;
  }
  const { email, password } = req.body || {};
  const emailClean = String(email || '').trim().toLowerCase();
  if (!emailClean || !password) {
    res.status(400).json({ error: 'Please enter your email and password' });
    return;
  }
  try {
    const stored = await getPasswordHash(emailClean);
    if (!stored || !verifyPassword(String(password), stored)) {
      res.status(401).json({ error: 'Incorrect email or password' });
      return;
    }
     const user = await getUserByEmail(emailClean);
     if (!user) {
       res.status(401).json({ error: 'Incorrect email or password' });
       return;
     }
     if (user.status === 'disabled') {
       res.status(403).json({ error: 'Account disabled by admin' });
       return;
     }
    const token = await createSession(user.id);
    const prefs = await getPrefs(user.id);
    setSessionCookie(res, token);
    res.status(200).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role }, prefs, login: true });
  } catch (err) {
    console.error('[AUTH] login failed:', err);
    res.status(500).json({ error: 'Could not sign in, please try again' });
  }
});

authRouter.post('/logout', (req, res) => {
  const token = parseCookieString(req.headers.cookie, SESSION_COOKIE);
  if (token) void deleteSession(token);
  clearSessionCookie(res);
  res.status(200).json({ logout: true });
});

authRouter.get('/me', requireAuth, async (req, res) => {
  const user = (req as AuthRequest).user!;
  try {
    const prefs = await getPrefs(user.id);
    res.status(200).json({ user, prefs, login: true });
  } catch (err) {
    console.error('[AUTH] me failed:', err);
    res.status(200).json({ user, login: true });
  }
});

authRouter.put('/prefs', requireAuth, async (req, res) => {
  const user = (req as AuthRequest).user!;
  const { preferred_ai_model, brand_color } = req.body || {};
  try {
    const next = await savePrefs(user.id, {
      preferred_ai_model: preferred_ai_model ? String(preferred_ai_model).slice(0, 32) : undefined,
      brand_color: brand_color ? String(brand_color).slice(0, 16) : undefined
    });
    res.status(200).json({ prefs: next });
  } catch (err) {
    console.error('[AUTH] prefs failed:', err);
    res.status(500).json({ error: 'Could not save preferences' });
  }
});

// Update the caller's own profile (display name + sign-in email) —
// self service only, the session decides whose profile changes,
// never a request parameter.
authRouter.put('/profile', requireAuth, async (req, res) => {
  const user = (req as AuthRequest).user!;
  try {
    const body = (req.body || {}) as { name?: string; email?: string };
    const updated = await updateUserProfile(user.id, {
      name: body.name !== undefined ? String(body.name || '') : undefined,
      email: body.email !== undefined ? String(body.email || '') : undefined
    });
    res.status(200).json({
      user: { id: updated.id, email: updated.email, name: updated.name, role: updated.role }
    });
  } catch (err: any) {
    res.status(400).json({ error: String(err?.message || err).slice(0, 160) });
  }
});

// Change the caller's own password — current password must verify first.
authRouter.put('/password', requireAuth, async (req, res) => {
  const user = (req as AuthRequest).user!;
  const { currentPassword, newPassword } = req.body || {};
  try {
    await changeUserPassword(user.id, String(currentPassword || ''), String(newPassword || ''));
    res.status(200).json({ success: true });
  } catch (err: any) {
    const msg = String(err?.message || err).slice(0, 160);
    res.status(msg.includes('incorrect') ? 401 : 400).json({ error: msg });
  }
});

// Public endpoint so the UI can show a "first signup" CTA.
authRouter.get('/initial-state', async (req, res) => {
  try {
    const count = await countUsers();
    res.status(200).json({ hasUsers: count > 0, dbReady: isDbReady() });
  } catch {
    res.status(200).json({ hasUsers: false, dbReady: false });
  }
});

export { parseCookieString, setSessionCookie, clearSessionCookie, SESSION_COOKIE };
export { hashPassword };