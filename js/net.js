// P2P networking over WebRTC (PeerJS). The host's browser is the server.
// Signaling uses the free PeerJS cloud broker; no backend of our own is needed.
// Public rooms live in well-known "slot" ids so players can find each other
// without a lobby server: Quick Play / Server Browser just probe those slots.
import { NET } from './sim/config.js';
const { PEER_PREFIX, PUBLIC_SLOTS } = NET;

export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  ...(window.HOMETURF_EXTRA_ICE || []),
];

const PEER_OPTS = { debug: 1, config: { iceServers: ICE_SERVERS } };
const CODE_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

export function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}
export const publicCode = i => `pub-${i}`;
export const normalizeCode = c => String(c || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');

function PeerCtor() {
  if (!window.Peer) throw new Error('Networking library failed to load (check your connection / ad blocker).');
  return window.Peer;
}

// Wait for a Peer to open with a specific id. Rejects with err.type on failure.
function openPeer(id) {
  return new Promise((resolve, reject) => {
    const Peer = PeerCtor();
    const peer = id ? new Peer(id, PEER_OPTS) : new Peer(PEER_OPTS);
    const fail = err => { cleanup(); try { peer.destroy(); } catch { /* ignore */ } reject(err); };
    const ok = () => { cleanup(); resolve(peer); };
    const timer = setTimeout(() => fail(Object.assign(new Error('Could not reach the matchmaking server.'), { type: 'timeout' })), 12000);
    const cleanup = () => { clearTimeout(timer); peer.off('open', ok); peer.off('error', fail); };
    peer.on('open', ok);
    peer.on('error', fail);
  });
}

// A shared anonymous peer used for joining / probing.
let clientPeer = null;
let clientPeerPromise = null;
const pendingTargets = new Map(); // target id -> reject fn (for peer-unavailable)

export async function getClientPeer() {
  if (clientPeer && !clientPeer.destroyed && !clientPeer.disconnected) return clientPeer;
  if (clientPeer && clientPeer.disconnected && !clientPeer.destroyed) {
    try { clientPeer.reconnect(); } catch { /* fall through */ }
    await new Promise(r => setTimeout(r, 800));
    if (!clientPeer.disconnected) return clientPeer;
  }
  if (!clientPeerPromise) {
    clientPeerPromise = openPeer(null).then(p => {
      clientPeer = p;
      p.on('error', err => {
        if (err.type === 'peer-unavailable') {
          const m = /peer\s+(\S+)/i.exec(err.message || '');
          const id = m ? m[1] : null;
          for (const [target, rej] of pendingTargets) if (!id || id === target) rej(err);
        }
      });
      p.on('disconnected', () => { setTimeout(() => { if (!p.destroyed && p.disconnected) try { p.reconnect(); } catch { /* ignore */ } }, 1000); });
      return p;
    }).finally(() => { clientPeerPromise = null; });
  }
  return clientPeerPromise;
}

function connectTo(peer, target, opts, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const conn = peer.connect(target, opts);
    const done = (fn, v) => { clearTimeout(t); pendingTargets.delete(target); fn(v); };
    const t = setTimeout(() => { try { conn.close(); } catch { /* ignore */ } done(reject, Object.assign(new Error('Timed out connecting.'), { type: 'timeout' })); }, timeout);
    pendingTargets.set(target, err => { done(reject, err); });
    conn.on('open', () => done(resolve, conn));
    conn.on('error', err => done(reject, err));
  });
}

// PeerJS's JSON channel silently drops any message over ~16 KB, so bigger
// ones (tracks with lots of buildings, full room states) are split into
// numbered parts and rebuilt on the other side.
const PART_BYTES = 14000;
const enc = new TextEncoder();
let partSeq = 0;
export function pack(m) {
  const s = JSON.stringify(m);
  if (s.length * 3 < PART_BYTES || enc.encode(s).length < PART_BYTES) return [m];
  const id = `${Date.now().toString(36)}.${(partSeq++).toString(36)}`;
  const parts = [];
  let i = 0;
  while (i < s.length) {
    let size = 12000, piece = s.slice(i, i + size);
    while (enc.encode(JSON.stringify(piece)).length > PART_BYTES - 200) { size = Math.floor(size / 2); piece = s.slice(i, i + size); }
    parts.push(piece);
    i += piece.length;
  }
  return parts.map((d, k) => ({ t: '_p', id, i: k, n: parts.length, d }));
}
export class Unpacker {
  constructor() { this.bufs = new Map(); }
  take(m) {
    if (!m || m.t !== '_p') return m;
    let b = this.bufs.get(m.id);
    if (!b) { b = { n: m.n, got: 0, parts: [] }; this.bufs.set(m.id, b); }
    if (b.parts[m.i] == null) { b.parts[m.i] = m.d; b.got++; }
    if (b.got < b.n) return null;
    this.bufs.delete(m.id);
    try { return JSON.parse(b.parts.join('')); } catch { return null; }
  }
}
const sendPacked = (ch, m) => { for (const part of pack(m)) ch.send(part); };

// ---------------------------------------------------------------- host
export class HostNet {
  constructor() {
    this.peer = null;
    this.code = null;
    this.conns = new Map();   // playerId -> { r, u, peerId, seen }
    this.byPeer = new Map();  // remote peer id -> playerId
    this.onJoin = null; this.onMessage = null; this.onLeave = null; this.onInfo = null;
    this.hb = null;
  }

  async start(code, { retryFor = 0 } = {}) {
    const deadline = performance.now() + retryFor;
    for (;;) {
      try {
        this.peer = await openPeer(PEER_PREFIX + code);
        break;
      } catch (err) {
        if (err.type === 'unavailable-id' && performance.now() < deadline) { await new Promise(r => setTimeout(r, 1200)); continue; }
        throw err;
      }
    }
    this.code = code;
    this.peer.on('connection', c => this.handle(c));
    this.peer.on('disconnected', () => {
      setTimeout(() => { if (this.peer && !this.peer.destroyed && this.peer.disconnected) try { this.peer.reconnect(); } catch { /* ignore */ } }, 1000);
    });
    this.peer.on('error', err => console.warn('[host]', err.type, err.message));
    this.hb = setInterval(() => {
      const now = performance.now();
      for (const [pid, c] of this.conns) if (now - c.seen > 9000) this.drop(pid);
    }, 1000);
    return code;
  }

  handle(conn) {
    const meta = conn.metadata || {};
    const un = new Unpacker();
    conn.on('open', () => {
      if (meta.k === 'probe') {
        sendPacked(conn, { t: 'info', ...(this.onInfo ? this.onInfo() : {}) });
        setTimeout(() => { try { conn.close(); } catch { /* ignore */ } }, 1500);
      } else if (meta.k === 'u') {
        const pid = this.byPeer.get(conn.peer);
        const c = this.conns.get(pid);
        if (c) c.u = conn; else conn.close();
      }
    });
    conn.on('data', raw => {
      if (!raw || typeof raw !== 'object') return;
      if (meta.k === 'probe') return;
      const m = un.take(raw);
      if (!m) return;
      const pid = this.byPeer.get(conn.peer);
      if (meta.k === 'u') { if (pid != null) { const c = this.conns.get(pid); if (c) c.seen = performance.now(); this.onMessage(pid, m); } return; }
      if (m.t === 'hello') {
        if (!this.onJoin) { conn.send({ t: 'reject', err: 'Room is still starting - retrying...', retry: true }); setTimeout(() => conn.close(), 300); return; }
        const res = this.onJoin(m);
        if (res.err) { conn.send({ t: 'reject', err: res.err }); setTimeout(() => conn.close(), 500); return; }
        const old = this.conns.get(res.id);
        if (old && old.r !== conn) { try { old.r.close(); } catch { /* ignore */ } }
        this.conns.set(res.id, { r: conn, u: null, peerId: conn.peer, seen: performance.now() });
        this.byPeer.set(conn.peer, res.id);
        sendPacked(conn, res.welcome);
        return;
      }
      if (pid != null) {
        const c = this.conns.get(pid);
        if (c) c.seen = performance.now();
        this.onMessage(pid, m);
      }
    });
    conn.on('close', () => {
      const pid = this.byPeer.get(conn.peer);
      const c = this.conns.get(pid);
      if (c && c.r === conn) this.drop(pid);
    });
    conn.on('error', err => console.warn('[host conn]', err));
  }

  drop(pid) {
    const c = this.conns.get(pid);
    if (!c) return;
    this.conns.delete(pid);
    if (this.byPeer.get(c.peerId) === pid) this.byPeer.delete(c.peerId);
    try { c.r.close(); } catch { /* ignore */ }
    try { c.u && c.u.close(); } catch { /* ignore */ }
    this.onLeave?.(pid);
  }

  send(pid, m, reliable = true) {
    const c = this.conns.get(pid);
    if (!c) return;
    const ch = !reliable && c.u && c.u.open ? c.u : c.r;
    if (ch && ch.open) { try { sendPacked(ch, m); } catch { /* channel closing */ } }
  }

  broadcast(m, except = null, reliable = true) {
    for (const pid of this.conns.keys()) if (pid !== except) this.send(pid, m, reliable);
  }

  get playerCount() { return this.conns.size; }

  destroy() {
    clearInterval(this.hb);
    for (const pid of [...this.conns.keys()]) {
      const c = this.conns.get(pid);
      try { c.r.close(); c.u && c.u.close(); } catch { /* ignore */ }
    }
    this.conns.clear();
    try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
    this.peer = null;
  }
}

// ---------------------------------------------------------------- client
export class ClientNet {
  constructor() {
    this.r = null; this.u = null;
    this.onMessage = null; this.onClose = null;
    this.lastRecv = 0; this.hb = null; this.closed = false;
    this.code = null;
  }

  async connect(code, hello) {
    const peer = await getClientPeer();
    this.code = code;
    const target = PEER_PREFIX + code;
    let r;
    try {
      r = await connectTo(peer, target, { reliable: true, serialization: 'json', metadata: { k: 'r' } });
    } catch (err) {
      if (err.type === 'peer-unavailable') throw new Error(`Room "${code.toUpperCase()}" was not found.`);
      throw new Error(err.message || 'Could not connect to the room.');
    }
    this.r = r;
    const un = new Unpacker();
    const welcome = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The host did not respond.')), 8000);
      const onData = raw => {
        const m = un.take(raw);
        if (!m) return;
        if (m.t === 'welcome') { clearTimeout(t); r.off('data', onData); resolve(m); }
        else if (m.t === 'reject') { clearTimeout(t); r.off('data', onData); reject(new Error(m.err)); }
      };
      r.on('data', onData);
      sendPacked(r, hello);
    });
    this.lastRecv = performance.now();
    r.on('data', raw => { this.lastRecv = performance.now(); const m = un.take(raw); if (m) this.onMessage?.(m); });
    r.on('close', () => this.fail('closed'));
    r.on('error', () => this.fail('error'));
    // second, unreliable channel for fast state updates
    connectTo(peer, target, { reliable: false, serialization: 'json', metadata: { k: 'u' } }).then(u => {
      if (this.closed) { u.close(); return; }
      this.u = u;
      const uu = new Unpacker();
      u.on('data', raw => { this.lastRecv = performance.now(); const m = uu.take(raw); if (m) this.onMessage?.(m); });
    }).catch(() => { /* reliable channel still works */ });
    this.hb = setInterval(() => { if (performance.now() - this.lastRecv > 6000) this.fail('timeout'); }, 1000);
    return welcome;
  }

  fail(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.hb);
    try { this.r && this.r.close(); } catch { /* ignore */ }
    try { this.u && this.u.close(); } catch { /* ignore */ }
    this.onClose?.(reason);
  }

  send(m, reliable = true) {
    const ch = !reliable && this.u && this.u.open ? this.u : this.r;
    if (ch && ch.open) { try { sendPacked(ch, m); } catch { /* closing */ } }
  }

  destroy() {
    this.closed = true;
    clearInterval(this.hb);
    try { this.r && this.r.close(); } catch { /* ignore */ }
    try { this.u && this.u.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- discovery
export async function probeRoom(code, timeout = 3500) {
  const peer = await getClientPeer();
  const target = PEER_PREFIX + code;
  try {
    const conn = await connectTo(peer, target, { reliable: true, serialization: 'json', metadata: { k: 'probe' } }, timeout);
    return await new Promise(resolve => {
      const t = setTimeout(() => { try { conn.close(); } catch { /* ignore */ } resolve(null); }, timeout);
      conn.on('data', m => { if (m.t === 'info') { clearTimeout(t); try { conn.close(); } catch { /* ignore */ } resolve({ ...m, code }); } });
    });
  } catch { return null; }
}

export async function probePublicRooms() {
  const codes = Array.from({ length: PUBLIC_SLOTS }, (_, i) => publicCode(i));
  const res = await Promise.all(codes.map(c => probeRoom(c)));
  return res.filter(Boolean);
}

export async function claimPublicSlot(knownTaken = []) {
  const taken = new Set(knownTaken);
  for (let i = 0; i < PUBLIC_SLOTS; i++) {
    const code = publicCode(i);
    if (taken.has(code)) continue;
    const net = new HostNet();
    try { await net.start(code); return net; }
    catch (err) { if (err.type !== 'unavailable-id') throw err; }
  }
  throw new Error('All public rooms are busy - try hosting a private room.');
}
