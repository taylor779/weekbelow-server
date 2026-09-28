/**
 * BSMNT — request authentication helpers
 * ───────────────────────────────────────
 * Verifies `Authorization: Bearer <supabase access token>` against Supabase
 * Auth using the service-role key, and checks agency membership.
 *
 *   requireUser(req)                 -> Promise<user|null>   (null = no/invalid token)
 *   requireMember(userId, agencyId)  -> Promise<member|null> (active agency_members row)
 *   softAuth                         -> middleware: sets req.authUser when a valid
 *                                       token is present, NEVER rejects
 *   requireAuth                      -> middleware: 401 unless a valid token is present
 *   forgetUser(userId)               -> drop cached user/membership entries
 *
 * Usage (server.js):
 *   const makeAuth = require('./auth');
 *   const { softAuth, requireAuth, requireMember } = makeAuth(supabaseAdmin);
 */

const USER_CACHE_TTL_MS   = 60 * 1000;
const MEMBER_CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 2000;

function _bearer(req) {
  const h = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  const tok = m && m[1].trim();
  // Supabase access tokens are JWTs (three dot-separated segments).
  if (!tok || tok.split('.').length !== 3) return null;
  return tok;
}

function _cacheSet(map, key, value, ttl) {
  if (map.size >= CACHE_MAX) {
    // Drop the oldest entry (Map preserves insertion order).
    const first = map.keys().next().value;
    map.delete(first);
  }
  map.set(key, { value, exp: Date.now() + ttl });
}
function _cacheGet(map, key) {
  const e = map.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) { map.delete(key); return undefined; }
  return e.value;
}

module.exports = function makeAuth(supabaseAdmin) {
  const userCache = new Map();    // token -> user
  const memberCache = new Map();  // userId|agencyId -> member row (or null)

  async function requireUser(req) {
    if (!supabaseAdmin || !supabaseAdmin.auth) return null;
    const token = _bearer(req);
    if (!token) return null;
    const cached = _cacheGet(userCache, token);
    if (cached !== undefined) return cached;
    let user = null;
    try {
      const { data, error } = await supabaseAdmin.auth.getUser(token);
      user = (!error && data && data.user && data.user.id) ? data.user : null;
    } catch (e) {
      user = null;
    }
    // Only cache positive results; a transient Supabase failure shouldn't
    // lock a valid user out for the TTL.
    if (user) _cacheSet(userCache, token, user, USER_CACHE_TTL_MS);
    return user;
  }

  async function requireMember(userId, agencyId) {
    if (!supabaseAdmin || !userId || !agencyId) return null;
    const key = String(userId) + '|' + String(agencyId);
    const cached = _cacheGet(memberCache, key);
    if (cached !== undefined) return cached;
    const { data, error } = await supabaseAdmin.from('agency_members')
      .select('id,user_id,agency_id,role,active')
      .eq('user_id', String(userId)).eq('agency_id', String(agencyId))
      .limit(5);
    if (error) throw new Error('membership lookup failed: ' + error.message);
    const row = (Array.isArray(data) ? data : []).find(r => r && r.active !== false) || null;
    _cacheSet(memberCache, key, row, MEMBER_CACHE_TTL_MS);
    return row;
  }

  // Opt-in, non-rejecting: existing web callers send no token and keep working.
  async function softAuth(req, res, next) {
    try { req.authUser = await requireUser(req); }
    catch (e) { req.authUser = null; }
    next();
  }

  // Strict: for new endpoints only.
  async function requireAuth(req, res, next) {
    try {
      const user = await requireUser(req);
      if (!user) return res.status(401).json({ error: 'Unauthorized: valid Supabase access token required' });
      req.authUser = user;
      next();
    } catch (e) {
      res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Drop cached user/membership entries for a user (e.g. after account deletion),
  // so a still-unexpired token isn't honoured from cache for the rest of the TTL.
  function forgetUser(userId) {
    if (!userId) return;
    const id = String(userId);
    for (const [k, e] of userCache) if (e && e.value && String(e.value.id) === id) userCache.delete(k);
    for (const k of memberCache.keys()) if (k.startsWith(id + '|')) memberCache.delete(k);
  }

  return { requireUser, requireMember, softAuth, requireAuth, forgetUser };
};
