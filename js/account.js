// Player accounts. Sign up / sign in with a username and password, and the
// profile (progress, garage, the settings that follow you) and saved tracks
// sync to the HOME TURF server (relay/accounts.js), so they survive a cleared
// browser and follow you to other devices.
//
// The password never leaves this browser: it is stretched with PBKDF2 here and
// only the derived key is sent. Signing out puts this device's guest profile back.
import { apiBase } from './net.js';

const KEY = 'hometurf.account.v1';
const GUEST = 'hometurf.profile.guest';
const PUSH_DELAY = 4000;

const b64 = buf => {
  const a = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

// Tracks travel gzipped when the browser can ("g:"), as plain JSON otherwise ("j:").
async function packTrack(t) {
  const json = JSON.stringify(t);
  if (typeof CompressionStream === 'undefined') return 'j:' + json;
  const gz = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  return 'g:' + b64(gz);
}
async function unpackTrack(s) {
  if (s.startsWith('j:')) return JSON.parse(s.slice(2));
  const stream = new Blob([unb64(s.slice(2))]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

export class Account {
  constructor(profile, store) {
    this.profile = profile; this.store = store;
    let s = {};
    try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { s = {}; }
    this.user = s.user || null; this.token = s.token || null; this.lastSync = s.lastSync || 0;
    this.status = '';          // 'syncing' | 'error' | 'expired' | ''
    this.onChange = null;      // UI refresh
    this.onProfile = null;     // the profile was replaced by the account's copy
    this.pushT = 0; this.dirty = false; this.quiet = false;
    profile.onChange = () => this.schedulePush();
    // Saving tracks uploads them; deleting one deletes it everywhere.
    const put = store.put.bind(store), del = store.del.bind(store);
    store.put = async t => { const r = await put(t); if (this.signedIn && !this.quiet) this.uploadTrack(t).catch(err => console.warn('[account] track upload', err)); return r; };
    store.del = async id => {
      const r = await del(id);
      if (this.signedIn) {
        const gone = this.profile.d.deletedTracks;
        if (!gone.includes(id)) { gone.push(id); if (gone.length > 300) gone.shift(); this.profile.save(); }
        this.api('DELETE', `/tracks/${encodeURIComponent(id)}`).catch(() => {});
      }
      return r;
    };
    addEventListener('pagehide', () => this.flush());
    addEventListener('visibilitychange', () => { if (document.hidden) this.flush(); else if (this.signedIn && Date.now() - this.lastSync > 60e3) this.sync().catch(() => {}); });
  }

  get signedIn() { return !!this.token; }
  persist() { try { localStorage.setItem(KEY, JSON.stringify({ user: this.user, token: this.token, lastSync: this.lastSync })); } catch { /* private mode */ } }
  emit() { this.onChange?.(); }

  async api(method, path, body, opts = {}) {
    const base = apiBase();
    if (!base) throw new Error('Accounts need the HOME TURF server, which is not set up here.');
    let res;
    try {
      res = await fetch(`${base}/api${path}`, {
        method, keepalive: !!opts.keepalive, cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...(this.token && !opts.anon ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { throw new Error("Can't reach the HOME TURF server - check your connection."); }
    let j = null;
    try { j = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && !opts.anon && this.token) { this.token = null; this.status = 'expired'; this.persist(); this.emit(); }
    if (!res.ok) throw Object.assign(new Error(j?.error || `Server error (${res.status}).`), { status: res.status });
    return j;
  }

  // PBKDF2 in the browser: the server only ever sees this derived key.
  static async deriveKey(user, pass) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(`hometurf-account:${user.toLowerCase()}`), iterations: 200000 }, base, 256);
    return b64(bits);
  }

  static check(user, pass) {
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(user || '')) return 'Usernames are 3-20 letters, numbers, _ or -.';
    if (!pass || pass.length < 6) return 'Passwords need at least 6 characters.';
    if (pass.length > 200) return 'That password is too long.';
    return null;
  }

  stashGuest() {
    try { if (!localStorage.getItem(GUEST)) localStorage.setItem(GUEST, JSON.stringify(this.profile.d)); } catch { /* ignore */ }
  }

  // New account: this device's progress becomes the account's.
  async signup(user, pass) {
    const err = Account.check(user, pass);
    if (err) throw new Error(err);
    const key = await Account.deriveKey(user, pass);
    const r = await this.api('POST', '/signup', { user, key }, { anon: true });
    this.stashGuest();
    this.user = r.user; this.token = r.token; this.status = ''; this.persist();
    await this.push();
    await this.syncTracks();
    this.emit();
  }

  // Existing account: its progress replaces this device's (which is kept for sign-out).
  async login(user, pass) {
    const err = Account.check(user, pass);
    if (err) throw new Error(err);
    const key = await Account.deriveKey(user, pass);
    const r = await this.api('POST', '/login', { user, key }, { anon: true });
    this.stashGuest();
    this.user = r.user; this.token = r.token; this.status = ''; this.persist();
    await this.sync({ preferServer: true });
  }

  async logout() {
    await this.flush();
    try { await this.api('POST', '/logout'); } catch { /* the token dies with the session anyway */ }
    this.token = null; this.user = null; this.status = ''; this.lastSync = 0; this.persist();
    try {
      const g = localStorage.getItem(GUEST);
      if (g) { const d = JSON.parse(g); this.quiet = true; this.profile.importData(d, d.updated || 0); this.quiet = false; localStorage.removeItem(GUEST); this.onProfile?.(); }
    } catch { /* keep what we have */ }
    this.emit();
  }

  async deleteAccount(pass) {
    const key = await Account.deriveKey(this.user, pass);
    await this.api('DELETE', '/account', { key });
    clearTimeout(this.pushT); this.dirty = false;
    this.token = null; this.user = null; this.lastSync = 0; this.persist();
    try { localStorage.removeItem(GUEST); } catch { /* ignore */ }
    this.emit();
  }

  // Newest copy wins: the account's, or this device's if it changed offline.
  async sync({ preferServer = false } = {}) {
    if (!this.signedIn) return;
    this.status = 'syncing'; this.emit();
    try {
      const r = await this.api('GET', '/profile');
      if (r.user) this.user = r.user;
      if (!r.profile) await this.push();
      else if (preferServer || r.updated > (this.profile.d.updated || 0)) {
        this.quiet = true;
        this.profile.importData(r.profile, r.updated);
        this.quiet = false;
        this.onProfile?.();
      } else if ((this.profile.d.updated || 0) > r.updated) await this.push();
      await this.syncTracks();
      this.lastSync = Date.now(); this.status = ''; this.persist();
    } catch (err) {
      if (this.status !== 'expired') this.status = 'error';
      throw err;
    } finally { this.emit(); }
  }

  schedulePush() {
    if (!this.signedIn || this.quiet) return;
    this.dirty = true;
    clearTimeout(this.pushT);
    this.pushT = setTimeout(() => this.push().catch(err => { console.warn('[account] save failed', err.message); this.status = 'error'; this.emit(); }), PUSH_DELAY);
  }

  async push(opts = {}) {
    if (!this.signedIn) return;
    clearTimeout(this.pushT);
    this.dirty = false;
    await this.api('PUT', '/profile', { profile: this.profile.exportData(), updated: this.profile.d.updated || Date.now() }, opts);
    this.lastSync = Date.now(); if (this.status === 'error') this.status = ''; this.persist(); this.emit();
  }

  // Leaving the page: send what's pending (keepalive outlives the tab).
  flush() { if (this.dirty && this.signedIn) return this.push({ keepalive: true }).catch(() => {}); return Promise.resolve(); }

  async uploadTrack(t) {
    if (!t?.id || t.id.startsWith('preset-')) return;
    const data = await packTrack(t);
    await this.api('PUT', `/tracks/${encodeURIComponent(t.id)}`, { meta: { name: t.name, len: t.len, created: t.created }, data });
  }

  async syncTracks() {
    const gone = new Set(this.profile.d.deletedTracks || []);
    const [remote, local] = await Promise.all([this.api('GET', '/tracks'), this.store.list().catch(() => [])]);
    const have = new Set(local.map(t => t.id)), there = new Set(remote.tracks.map(t => t.id));
    this.quiet = true;
    try {
      for (const t of local) {
        if (gone.has(t.id)) { await this.store.del(t.id).catch(() => {}); continue; }   // deleted on another device
        if (!there.has(t.id)) await this.uploadTrack(await this.store.get(t.id));
      }
      for (const m of remote.tracks) {
        if (have.has(m.id)) continue;
        if (gone.has(m.id)) { this.api('DELETE', `/tracks/${encodeURIComponent(m.id)}`).catch(() => {}); continue; }
        const r = await this.api('GET', `/tracks/${encodeURIComponent(m.id)}`);
        await this.store.put(await unpackTrack(r.data));
      }
    } finally { this.quiet = false; }
  }
}
