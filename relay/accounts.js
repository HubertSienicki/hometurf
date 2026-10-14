// HOME TURF accounts: username + password, a synced profile (progress, garage,
// settings that follow the player) and saved tracks. One Durable Object with
// SQLite storage holds everything.
//
// Passwords never reach the server: the game stretches them with PBKDF2 in the
// browser (see js/account.js) and sends that key; we store SHA-256(salt + key).
// Sessions are random bearer tokens, stored hashed.
//
//   POST   /api/signup        { user, key }          -> { token, user }
//   POST   /api/login         { user, key }          -> { token, user }
//   POST   /api/logout                               -> { ok }
//   GET    /api/profile                              -> { profile, updated }
//   PUT    /api/profile       { profile, updated }   -> { updated }
//   GET    /api/tracks                               -> { tracks: [meta] }
//   GET    /api/tracks/:id                           -> { meta, data }
//   PUT    /api/tracks/:id    { meta, data }         -> { ok }
//   DELETE /api/tracks/:id                           -> { ok }
//   DELETE /api/account       { key }                -> { ok }
import { DurableObject } from 'cloudflare:workers';

const USER_RE = /^[A-Za-z0-9_-]{3,20}$/;
const KEY_RE = /^[A-Za-z0-9+/=]{40,64}$/;
const TRACK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_PROFILE = 64 * 1024;
const MAX_TRACK = 900 * 1024;
const MAX_TRACKS = 60;
const SESSION_DAYS = 180;

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async s => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
const rand = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; };
const b64url = a => btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const same = (a, b) => {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

// Fixed-window counters (in memory: they reset if the object is evicted, which is fine).
class Limiter {
  constructor(max, windowMs) { this.max = max; this.win = windowMs; this.m = new Map(); }
  hit(key) {
    const now = Date.now();
    let e = this.m.get(key);
    if (!e || now - e.t > this.win) { e = { t: now, n: 0 }; this.m.set(key, e); }
    e.n++;
    if (this.m.size > 5000) for (const [k, v] of this.m) if (now - v.t > this.win) this.m.delete(k);
    return e.n <= this.max;
  }
}

export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL,
      created INTEGER NOT NULL, profile TEXT, updated INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (th TEXT PRIMARY KEY, uid TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS sessions_uid ON sessions (uid)');
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tracks (uid TEXT NOT NULL, id TEXT NOT NULL, meta TEXT NOT NULL, data TEXT NOT NULL,
      updated INTEGER NOT NULL, PRIMARY KEY (uid, id))`);
    this.loginByIp = new Limiter(30, 15 * 60e3);
    this.loginByUser = new Limiter(12, 15 * 60e3);
    this.signupByIp = new Limiter(6, 60 * 60e3);
  }

  async fetch(req) {
    try {
      return Response.json(await this.route(req));
    } catch (err) {
      if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status });
      console.error(err);
      return Response.json({ error: 'Server error.' }, { status: 500 });
    }
  }

  async body(req, max = 1024 * 1024) {
    const text = await req.text();
    if (text.length > max) fail(413, 'Too large.');
    try { return JSON.parse(text || '{}'); } catch { return fail(400, 'Bad request.'); }
  }

  async auth(req) {
    const m = /^Bearer ([A-Za-z0-9_-]{20,80})$/.exec(req.headers.get('Authorization') || '');
    if (!m) fail(401, 'Not signed in.');
    const th = await sha(m[1]);
    const s = this.sql.exec('SELECT uid, seen FROM sessions WHERE th = ?', th).toArray()[0];
    if (!s || Date.now() - s.seen > SESSION_DAYS * 864e5) fail(401, 'Your session expired - sign in again.');
    if (Date.now() - s.seen > 36e5) this.sql.exec('UPDATE sessions SET seen = ? WHERE th = ?', Date.now(), th);
    return { uid: s.uid, th };
  }

  async newSession(uid) {
    const token = b64url(rand(32));
    this.sql.exec('INSERT INTO sessions (th, uid, created, seen) VALUES (?, ?, ?, ?)', await sha(token), uid, Date.now(), Date.now());
    // keep the newest 10 sessions per account
    this.sql.exec('DELETE FROM sessions WHERE uid = ? AND th NOT IN (SELECT th FROM sessions WHERE uid = ? ORDER BY seen DESC LIMIT 10)', uid, uid);
    return token;
  }

  async route(req) {
    const url = new URL(req.url), path = url.pathname.replace(/^\/api/, ''), method = req.method;
    const ip = req.headers.get('CF-Connecting-IP') || 'local';

    if (path === '/signup' && method === 'POST') {
      if (!this.signupByIp.hit(ip)) fail(429, 'Too many new accounts from here - try again later.');
      const { user, key } = await this.body(req, 4096);
      if (!USER_RE.test(user || '')) fail(400, 'Usernames are 3-20 letters, numbers, _ or -.');
      if (!KEY_RE.test(key || '')) fail(400, 'Bad request.');
      const id = user.toLowerCase();
      if (this.sql.exec('SELECT 1 FROM users WHERE id = ?', id).toArray().length) fail(409, 'That username is taken.');
      const salt = hex(rand(16));
      this.sql.exec('INSERT INTO users (id, name, salt, hash, created) VALUES (?, ?, ?, ?, ?)', id, user, salt, await sha(salt + key), Date.now());
      return { token: await this.newSession(id), user };
    }
    if (path === '/login' && method === 'POST') {
      const { user, key } = await this.body(req, 4096);
      const id = String(user || '').toLowerCase();
      if (!this.loginByIp.hit(ip) || !this.loginByUser.hit(id)) fail(429, 'Too many attempts - wait a few minutes.');
      const u = USER_RE.test(user || '') && KEY_RE.test(key || '') ? this.sql.exec('SELECT * FROM users WHERE id = ?', id).toArray()[0] : null;
      if (!u || !same(await sha(u.salt + key), u.hash)) fail(401, 'Wrong username or password.');
      return { token: await this.newSession(id), user: u.name };
    }

    const { uid, th } = await this.auth(req);
    if (path === '/logout' && method === 'POST') {
      this.sql.exec('DELETE FROM sessions WHERE th = ?', th);
      return { ok: true };
    }
    if (path === '/profile' && method === 'GET') {
      const u = this.sql.exec('SELECT name, profile, updated FROM users WHERE id = ?', uid).toArray()[0];
      if (!u) fail(401, 'Account not found.');
      return { user: u.name, profile: u.profile ? JSON.parse(u.profile) : null, updated: u.updated };
    }
    if (path === '/profile' && method === 'PUT') {
      const { profile, updated } = await this.body(req, MAX_PROFILE + 1024);
      if (!profile || typeof profile !== 'object') fail(400, 'Bad request.');
      const s = JSON.stringify(profile);
      if (s.length > MAX_PROFILE) fail(413, 'Profile too large.');
      const t = Number.isFinite(updated) ? Math.min(updated, Date.now() + 60e3) : Date.now();
      this.sql.exec('UPDATE users SET profile = ?, updated = ? WHERE id = ?', s, t, uid);
      return { updated: t };
    }
    if (path === '/tracks' && method === 'GET') {
      const rows = this.sql.exec('SELECT meta FROM tracks WHERE uid = ? ORDER BY updated DESC', uid).toArray();
      return { tracks: rows.map(r => JSON.parse(r.meta)) };
    }
    const tm = /^\/tracks\/([^/]+)$/.exec(path);
    if (tm) {
      const id = decodeURIComponent(tm[1]);
      if (!TRACK_ID_RE.test(id)) fail(400, 'Bad track id.');
      if (method === 'GET') {
        const r = this.sql.exec('SELECT meta, data FROM tracks WHERE uid = ? AND id = ?', uid, id).toArray()[0];
        if (!r) fail(404, 'No such track.');
        return { meta: JSON.parse(r.meta), data: r.data };
      }
      if (method === 'PUT') {
        const { meta, data } = await this.body(req, MAX_TRACK + 8192);
        if (!meta || typeof meta !== 'object' || typeof data !== 'string' || data.length > MAX_TRACK) fail(400, 'Bad track.');
        const m = { id, name: String(meta.name || 'Track').slice(0, 60), len: +meta.len || 0, created: +meta.created || Date.now() };
        const exists = this.sql.exec('SELECT 1 FROM tracks WHERE uid = ? AND id = ?', uid, id).toArray().length;
        if (!exists && this.sql.exec('SELECT COUNT(*) AS n FROM tracks WHERE uid = ?', uid).one().n >= MAX_TRACKS) fail(409, `Track limit reached (${MAX_TRACKS}).`);
        this.sql.exec('INSERT OR REPLACE INTO tracks (uid, id, meta, data, updated) VALUES (?, ?, ?, ?, ?)', uid, id, JSON.stringify(m), data, Date.now());
        return { ok: true };
      }
      if (method === 'DELETE') {
        this.sql.exec('DELETE FROM tracks WHERE uid = ? AND id = ?', uid, id);
        return { ok: true };
      }
    }
    if (path === '/account' && method === 'DELETE') {
      const { key } = await this.body(req, 4096);
      const u = this.sql.exec('SELECT salt, hash FROM users WHERE id = ?', uid).toArray()[0];
      if (!u || !KEY_RE.test(key || '') || !same(await sha(u.salt + key), u.hash)) fail(401, 'Wrong password.');
      this.sql.exec('DELETE FROM tracks WHERE uid = ?', uid);
      this.sql.exec('DELETE FROM sessions WHERE uid = ?', uid);
      this.sql.exec('DELETE FROM users WHERE id = ?', uid);
      return { ok: true };
    }
    return fail(404, 'Not found.');
  }
}
