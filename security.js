/**
 * BSMNT — small security helpers (no extra dependencies)
 * ──────────────────────────────────────────────────────
 *   rateLimit(opts)        -> express middleware, in-memory fixed-window limiter
 *   clientIp(req)          -> best-effort client IP behind Railway's proxy
 *   safeFetchText(url, o)  -> SSRF-safe GET (http/https only, public IPs only,
 *                             pinned DNS, manual redirects, size + time caps)
 *   isPublicAddress(ip)    -> false for private/loopback/link-local/metadata/etc.
 *   escapeHtml(s)          -> HTML-escape for email templates
 *   maskEmail(e)           -> '***@domain' for logs (no local part)
 *
 * Rate limits are per process (Railway runs one instance). Set RATE_LIMITS=off
 * in Railway to disable every limiter without a redeploy of code.
 */

const net = require('net');
const dns = require('dns');
const http = require('http');
const https = require('https');

const LIMITS_OFF = String(process.env.RATE_LIMITS || '').toLowerCase() === 'off';

// ── Client IP ────────────────────────────────────────────────────────────────
// Railway's edge appends the connecting client's address to X-Forwarded-For, so
// the right-most entry is the one a client can't forge (left-most entries can be
// supplied by the client). Falls back to the socket address.
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const parts = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// ── Rate limiter ─────────────────────────────────────────────────────────────
const _buckets = new Map(); // name|key -> { count, reset }
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of _buckets) if (b.reset <= now) _buckets.delete(k);
}, 60 * 1000).unref();

function _hit(bucketKey, windowMs, max) {
  const now = Date.now();
  let b = _buckets.get(bucketKey);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + windowMs }; _buckets.set(bucketKey, b); }
  b.count++;
  return b.count > max ? Math.ceil((b.reset - now) / 1000) : 0;
}

/**
 * rateLimit({ name, windowMs, max, by })
 *   by: 'ip' (default) | 'user' (req.authUser.id, falls back to IP) | 'ip+user'
 * Several limiters can be stacked on one route (e.g. per-minute and per-hour).
 */
function rateLimit({ name, windowMs, max, by = 'ip', message }) {
  return function (req, res, next) {
    if (LIMITS_OFF) return next();
    const keys = [];
    const uid = req.authUser && req.authUser.id ? String(req.authUser.id) : null;
    if (by === 'user') keys.push(uid ? 'u:' + uid : 'ip:' + clientIp(req));
    else if (by === 'ip+user') { keys.push('ip:' + clientIp(req)); if (uid) keys.push('u:' + uid); }
    else keys.push('ip:' + clientIp(req));
    for (const k of keys) {
      const retry = _hit(name + '|' + k, windowMs, max);
      if (retry) {
        res.setHeader('Retry-After', String(retry));
        return res.status(429).json({ error: message || 'Too many requests. Please wait a moment and try again.' });
      }
    }
    next();
  };
}

// Non-middleware check (for WebSocket messages). Returns true when over limit.
function overLimit(name, key, windowMs, max) {
  if (LIMITS_OFF) return false;
  return _hit(name + '|' + key, windowMs, max) > 0;
}

// ── Address filtering (SSRF) ─────────────────────────────────────────────────
const _block = new net.BlockList();
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16],            // link-local incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([a, p]) => _block.addSubnet(a, p, 'ipv4'));
[
  // (::ffff:0:0/96 is NOT listed: net.BlockList matches plain IPv4 against it,
  //  which would block every IPv4 address. Mapped addresses are unwrapped by
  //  _embeddedV4 and checked against the IPv4 list instead.)
  ['::', 128], ['::1', 128], ['64:ff9b:1::', 48],
  ['100::', 64], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16],
  ['fc00::', 7],                  // unique local (incl. fd00:ec2::254 metadata)
  ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
].forEach(([a, p]) => _block.addSubnet(a, p, 'ipv6'));

// IPv4 embedded in an IPv6 address (::ffff:a.b.c.d, ::a.b.c.d, 64:ff9b::/96).
function _embeddedV4(ip) {
  const m = ip.match(/^(?:::ffff:|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) return m[1];
  const h = ip.match(/^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (h) {
    const hi = parseInt(h[1], 16), lo = parseInt(h[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return null;
}

function isPublicAddress(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0];
  const fam = net.isIP(bare);
  if (fam === 4) return !_block.check(bare, 'ipv4');
  if (fam === 6) {
    const v4 = _embeddedV4(bare);
    if (v4) return !_block.check(v4, 'ipv4');
    return !_block.check(bare, 'ipv6');
  }
  return false;
}

async function _resolvePublic(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new Error('blocked address');
    return { address: host, family: net.isIP(host) };
  }
  if (/^localhost$/i.test(host) || /\.(localhost|local|internal)$/i.test(host)) throw new Error('blocked host');
  const addrs = await dns.promises.lookup(host, { all: true, verbatim: true });
  if (!addrs.length) throw new Error('no address');
  // Every address must be public — otherwise a host with one public and one
  // private record could still be steered at the private one.
  for (const a of addrs) if (!isPublicAddress(a.address)) throw new Error('blocked address');
  return addrs[0];
}

/**
 * safeFetchText(url, { timeoutMs, maxBytes, maxRedirects, headers })
 * Resolves { status, url, contentType, text } or throws. DNS is resolved and
 * checked once per hop and the connection is pinned to that address (no DNS
 * rebinding between check and connect). Redirect targets are re-validated.
 */
async function safeFetchText(rawUrl, opts = {}) {
  const timeoutMs = opts.timeoutMs || 5000;
  const maxBytes = opts.maxBytes || 512 * 1024;
  const maxRedirects = opts.maxRedirects == null ? 3 : opts.maxRedirects;
  const deadline = Date.now() + timeoutMs;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u;
    try { u = new URL(current); } catch (e) { throw new Error('invalid url'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('unsupported protocol');
    if (u.username || u.password) throw new Error('credentials in url');
    const port = u.port ? parseInt(u.port, 10) : (u.protocol === 'https:' ? 443 : 80);
    if (port !== 80 && port !== 443 && port !== 8080 && port !== 8443) throw new Error('blocked port');
    const pinned = await _resolvePublic(u.hostname);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('timeout');

    const result = await new Promise((resolve, reject) => {
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        protocol: u.protocol,
        hostname: u.hostname.replace(/^\[|\]$/g, ''),
        port,
        path: (u.pathname || '/') + (u.search || ''),
        method: 'GET',
        headers: Object.assign({ 'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' }, opts.headers || {}),
        // Pin the connection to the address we validated.
        lookup: (hostname, o, cb) => {
          if (o && o.all) return cb(null, [{ address: pinned.address, family: pinned.family }]);
          cb(null, pinned.address, pinned.family);
        },
        timeout: remaining,
      }, res => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          return resolve({ redirect: new URL(res.headers.location, u).toString() });
        }
        let size = 0; const chunks = [];
        res.on('data', d => {
          size += d.length;
          if (size > maxBytes) { chunks.push(d.slice(0, Math.max(0, maxBytes - (size - d.length)))); res.destroy(); return; }
          chunks.push(d);
        });
        const done = () => resolve({ status, url: u.toString(), contentType: String(res.headers['content-type'] || ''), text: Buffer.concat(chunks).toString('utf8') });
        res.on('end', done);
        res.on('close', done);
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
    if (result.redirect) { current = result.redirect; continue; }
    return result;
  }
  throw new Error('too many redirects');
}

// ── Output helpers ───────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function maskEmail(e) {
  const s = String(e || '');
  const at = s.lastIndexOf('@');
  return at > 0 ? '***' + s.slice(at) : '***';
}

module.exports = { rateLimit, overLimit, clientIp, safeFetchText, isPublicAddress, escapeHtml, maskEmail };
