// Networking. The host's browser is the server, reached two ways:
//  - direct WebRTC (PeerJS), signalled through the free PeerJS cloud broker;
//  - a WebSocket relay (relay/worker.js on Cloudflare) for players whose network
//    blocks WebRTC (mobile data, CGNAT, strict routers). It only forwards frames.
// A host listens on both. A guest tries direct first and races the relay in if
// that is slow or fails (or uses the relay only, from Settings).
// Public rooms live in well-known "slot" ids so players can find each other
// without a lobby server: Quick Play / Server Browser just probe those slots.
import { NET } from './sim/config.js';
const { PEER_PREFIX, PUBLIC_SLOTS } = NET;

// Relay address: NET.RELAY in production; on localhost ?relay=ws://localhost:8787
// points at `npx wrangler dev` for testing.
const RELAY = (() => {
  let u = NET.RELAY || '';
  try {
    const q = new URLSearchParams(location.search).get('relay');
    if (q && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) u = q;
  } catch { /* no location (headless) */ }
  return u.replace(/\/+$/, '');
})();
export const relayAvailable = () => !!RELAY;
// HTTP base of the HOME TURF server (accounts live there too).
export const apiBase = () => RELAY.replace(/^ws/, 'http');
const RELAY_HEDGE_MS = 3000;   // direct link not open by then? start the relay too
const relayUrl = (code, q) => `${RELAY.replace(/^http/, 'ws')}/room/${PEER_PREFIX}${code}${q}`;
const relayInfoUrl = code => `${RELAY.replace(/^ws/, 'http')}/room/${PEER_PREFIX}${code}/info`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
// Relay links carry whole messages (up to 256 KB), so they skip the splitting.
const sendOn = (ch, m) => ch.relay ? ch.send(m) : sendPacked(ch, m);

// ---------------------------------------------------------------- relay links
// Tiny event emitter so relay links look like PeerJS DataConnections.
class Link {
  constructor() { this.h = {}; this.open = true; this.relay = true; this.metadata = { k: 'r' }; }
  on(e, f) { (this.h[e] ||= []).push(f); return this; }
  off(e, f) { const a = this.h[e]; const i = a ? a.indexOf(f) : -1; if (i >= 0) a.splice(i, 1); return this; }
  emit(e, v) { for (const f of [...(this.h[e] || [])]) { try { f(v); } catch (err) { console.error(err); } } }
}

// Host side: one guest behind the relay.
class RelayGuest extends Link {
  constructor(host, id) { super(); this.host = host; this.gid = id; this.peer = `relay:${id}`; }
  send(m) { if (this.open) this.host.out(`>${this.gid}|${JSON.stringify(m)}`); }
  close() {
    if (!this.open) return;
    this.open = false;
    this.host.guests.delete(this.gid);
    this.host.out(`#${this.gid}`);
    this.emit('close');
  }
  gone() { if (!this.open) return; this.open = false; this.host.guests.delete(this.gid); this.emit('close'); }
}

// Host side: the host's own socket to its relay room. Guests show up as
// RelayGuest links handed to HostNet.handle(), exactly like PeerJS connections.
class RelayHost {
  constructor(code, net) {
    this.code = code; this.net = net;
    this.guests = new Map();
    this.ws = null; this.dead = false; this.infoS = ''; this.timer = 0;
    // The same key lets a reloaded host tab take its room back at once.
    const k = `hometurf-relay-key-${code}`;
    try { this.key = sessionStorage.getItem(k); } catch { /* storage blocked */ }
    if (!this.key) {
      this.key = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 8);
      try { sessionStorage.setItem(k, this.key); } catch { /* ignore */ }
    }
  }

  open(timeout = 8000) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(relayUrl(this.code, `?role=host&key=${this.key}`)); } catch (err) { reject(Object.assign(err, { type: 'relay' })); return; }
      const fail = (msg, type = 'relay') => {
        clearTimeout(t); ws.onmessage = ws.onclose = ws.onerror = null;
        try { ws.close(); } catch { /* ignore */ }
        reject(Object.assign(new Error(msg), { type }));
      };
      const t = setTimeout(() => fail('The relay did not answer.'), timeout);
      ws.onerror = ws.onclose = () => fail('Could not reach the relay.');
      ws.onmessage = e => {
        if (e.data === '!taken') return fail('That room code is in use.', 'unavailable-id');
        if (e.data !== '!ok') return;
        clearTimeout(t);
        if (this.dead) { try { ws.close(1000); } catch { /* ignore */ } reject(Object.assign(new Error('closed'), { type: 'relay' })); return; }
        this.attach(ws);
        resolve(this);
      };
    });
  }

  attach(ws) {
    this.ws = ws;
    ws.onmessage = e => this.route(e.data);
    ws.onerror = null;
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // The relay drops every guest when the host's socket goes; tell the game, then reconnect.
      for (const g of [...this.guests.values()]) g.gone();
      if (!this.dead) this.reconnect();
    };
    clearInterval(this.timer);
    this.infoS = '';
    let quiet = 0;
    this.timer = setInterval(() => {
      // Room info for the server browser, sent only when it changes.
      try {
        const s = JSON.stringify(this.net.onInfo ? this.net.onInfo() : {});
        if (s !== this.infoS && s.length < 1400) { this.infoS = s; this.out('@' + s); quiet = 0; }
        else if (++quiet >= 10) { quiet = 0; this.out('.'); }   // keepalive; the relay answers it without waking up
      } catch { /* room closing */ }
    }, 3000);
  }

  async reconnect() {
    for (let wait = 1000; !this.dead; wait = Math.min(wait * 2, 15000)) {
      await sleep(wait);
      if (this.dead) return;
      try { await this.open(); return; } catch (err) {
        if (err.type === 'unavailable-id') { console.warn('[relay] room code taken by another host'); return; }
      }
    }
  }

  route(d) {
    if (typeof d !== 'string') return;
    const c = d[0];
    if (c === '+') {
      const g = new RelayGuest(this, +d.slice(1));
      this.guests.set(g.gid, g);
      this.net.handle(g);
      g.emit('open');
    } else if (c === '-') {
      this.guests.get(+d.slice(1))?.gone();
    } else if (c >= '0' && c <= '9') {
      const bar = d.indexOf('|');
      const g = this.guests.get(+d.slice(0, bar));
      if (!g) return;
      let m; try { m = JSON.parse(d.slice(bar + 1)); } catch { return; }
      g.emit('data', m);
    }
  }

  out(s) { if (this.ws && this.ws.readyState === 1) { try { this.ws.send(s); } catch { /* closing */ } } }
  multicast(ids, m) { if (ids.length) this.out(`>${ids.join(',')}|${JSON.stringify(m)}`); }

  destroy() {
    this.dead = true;
    clearInterval(this.timer);
    const ws = this.ws; this.ws = null;
    for (const g of [...this.guests.values()]) g.gone();
    try { ws && ws.close(1000); } catch { /* ignore */ }
  }
}

// Guest side: a socket to the host's relay room.
class RelayConn extends Link {
  constructor(ws) {
    super();
    this.ws = ws; this.peer = 'relay';
    ws.onmessage = e => {
      const d = e.data;
      if (typeof d !== 'string' || d[0] !== '{') return;   // control frames and keepalive echoes
      let m; try { m = JSON.parse(d); } catch { return; }
      this.emit('data', m);
    };
    ws.onerror = null;
    ws.onclose = () => { clearInterval(this.ka); if (this.open) { this.open = false; this.emit('close'); } };
    this.ka = setInterval(() => { if (ws.readyState === 1) ws.send('.'); }, 30000);
  }
  send(m) { if (this.open && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
  close() {
    clearInterval(this.ka);
    if (!this.open) return;
    this.open = false;
    try { this.ws.close(1000); } catch { /* ignore */ }
    this.emit('close');
  }
}

function connectRelay(code, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(relayUrl(code, '?role=guest')); } catch (err) { reject(Object.assign(err, { type: 'relay' })); return; }
    const fail = (msg, type) => {
      clearTimeout(t); ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(); } catch { /* ignore */ }
      reject(Object.assign(new Error(msg), { type }));
    };
    const t = setTimeout(() => fail('The relay did not answer.', 'timeout'), timeout);
    ws.onerror = ws.onclose = () => fail('Could not reach the relay.', 'relay');
    ws.onmessage = e => {
      if (e.data === '!none') return fail('No such room.', 'peer-unavailable');
      if (e.data === '!full') return fail('Room is full.', 'full');
      if (e.data !== '!ok') return;
      clearTimeout(t);
      resolve(new RelayConn(ws));
    };
  });
}

// Open a guest's link to a room: direct first; the relay joins the race if the
// direct link hasn't opened within RELAY_HEDGE_MS or fails. First to open wins.
function openRoute(code, mode) {
  const direct = !(mode === 'relay' && RELAY);
  return new Promise((resolve, reject) => {
    let done = false, live = 0, relayOn = false, timer = 0;
    const errs = [];
    const win = conn => {
      if (done) { try { conn.close(); } catch { /* ignore */ } return; }
      done = true; clearTimeout(timer); resolve(conn);
    };
    const lose = err => {
      errs.push(err); live--;
      if (done) return;
      if (RELAY && !relayOn) { startRelay(); return; }
      if (live > 0) return;
      done = true; clearTimeout(timer);
      if (errs.some(e => e.type === 'full')) reject(new Error('Room is full.'));
      else if (errs.some(e => e.type === 'peer-unavailable')) reject(new Error(`Room "${code.toUpperCase()}" was not found.`));
      else reject(new Error(errs.find(e => e.type !== 'peer-unavailable')?.message || 'Could not connect to the room.'));
    };
    const startRelay = () => {
      if (relayOn || done) return;
      relayOn = true; clearTimeout(timer); live++;
      connectRelay(code).then(win, lose);
    };
    if (direct) {
      live++;
      getClientPeer()
        .then(peer => connectTo(peer, PEER_PREFIX + code, { reliable: true, serialization: 'json', metadata: { k: 'r' } }))
        .then(win, lose);
      if (RELAY) timer = setTimeout(startRelay, RELAY_HEDGE_MS);
    } else startRelay();
  });
}

// ---------------------------------------------------------------- host
export class HostNet {
  constructor() {
    this.peer = null; this.relay = null;
    this.code = null;
    this.conns = new Map();   // playerId -> { r, u, peerId, seen }
    this.byPeer = new Map();  // remote peer id -> playerId
    this.onJoin = null; this.onMessage = null; this.onLeave = null; this.onInfo = null;
    this.hb = null;
  }

  // Listens on PeerJS and the relay at once; either one alone is enough.
  async start(code, { retryFor = 0 } = {}) {
    const deadline = performance.now() + retryFor;
    for (;;) {
      const relay = RELAY ? new RelayHost(code, this) : null;
      const [p, r] = await Promise.allSettled([
        openPeer(PEER_PREFIX + code),
        relay ? relay.open() : Promise.reject(Object.assign(new Error('No relay configured.'), { type: 'relay' })),
      ]);
      const taken = [p, r].find(x => x.status === 'rejected' && x.reason?.type === 'unavailable-id');
      if (taken || (p.status === 'rejected' && r.status === 'rejected')) {
        if (p.status === 'fulfilled') { try { p.value.destroy(); } catch { /* ignore */ } }
        relay?.destroy();
        if (taken && performance.now() < deadline) { await sleep(1200); continue; }
        throw taken ? taken.reason : p.reason;
      }
      this.peer = p.status === 'fulfilled' ? p.value : null;
      if (r.status === 'fulfilled') this.relay = relay; else relay?.destroy();
      if (!this.peer) console.warn('[host] direct connections unavailable, relay only:', p.reason?.message);
      break;
    }
    this.code = code;
    const peer = this.peer;
    if (peer) {
      peer.on('connection', c => this.handle(c));
      peer.on('disconnected', () => {
        setTimeout(() => { if (this.peer === peer && !peer.destroyed && peer.disconnected) try { peer.reconnect(); } catch { /* ignore */ } }, 1000);
      });
      peer.on('error', err => console.warn('[host]', err.type, err.message));
    }
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
        sendOn(conn, { t: 'info', ...(this.onInfo ? this.onInfo() : {}) });
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
        sendOn(conn, res.welcome);
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
    if (ch && ch.open) { try { sendOn(ch, m); } catch { /* channel closing */ } }
  }

  broadcast(m, except = null, reliable = true) {
    const viaRelay = [];   // relayed guests share one frame; the relay fans it out
    for (const [pid, c] of this.conns) {
      if (pid === except) continue;
      if (c.r.relay) { if (c.r.open) viaRelay.push(c.r.gid); } else this.send(pid, m, reliable);
    }
    this.relay?.multicast(viaRelay, m);
  }

  get relayed() { let n = 0; for (const c of this.conns.values()) if (c.r.relay) n++; return n; }

  get playerCount() { return this.conns.size; }

  destroy() {
    clearInterval(this.hb);
    for (const pid of [...this.conns.keys()]) {
      const c = this.conns.get(pid);
      try { c.r.close(); c.u && c.u.close(); } catch { /* ignore */ }
    }
    this.conns.clear();
    try { this.peer && this.peer.destroy(); } catch { /* ignore */ }
    this.relay?.destroy();
    this.peer = null; this.relay = null;
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

  // mode 'auto': direct first, relay as fallback; 'relay': relay only.
  async connect(code, hello, { mode = 'auto' } = {}) {
    this.code = code;
    const r = await openRoute(code, mode);
    this.via = r.relay ? 'relay' : 'direct';
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
      sendOn(r, hello);
    });
    this.lastRecv = performance.now();
    r.on('data', raw => { this.lastRecv = performance.now(); const m = un.take(raw); if (m) this.onMessage?.(m); });
    r.on('close', () => this.fail('closed'));
    r.on('error', () => this.fail('error'));
    // second, unreliable channel for fast state updates (direct links only)
    if (!r.relay) {
      getClientPeer().then(peer => connectTo(peer, PEER_PREFIX + code, { reliable: false, serialization: 'json', metadata: { k: 'u' } })).then(u => {
        if (this.closed) { u.close(); return; }
        this.u = u;
        const uu = new Unpacker();
        u.on('data', raw => { this.lastRecv = performance.now(); const m = uu.take(raw); if (m) this.onMessage?.(m); });
      }).catch(() => { /* reliable channel still works */ });
    }
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
    if (ch && ch.open) { try { sendOn(ch, m); } catch { /* closing */ } }
  }

  destroy() {
    this.closed = true;
    clearInterval(this.hb);
    try { this.r && this.r.close(); } catch { /* ignore */ }
    try { this.u && this.u.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- discovery
// What the relay knows about a room: an info object, null (no such room) or
// undefined (no relay, or unreachable).
async function relayInfo(code, timeout = 3000) {
  if (!RELAY) return undefined;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(relayInfoUrl(code), { signal: ctl.signal, cache: 'no-store' });
    if (!res.ok) return undefined;
    const j = await res.json();
    return j.open ? { ...(j.info || {}), t: 'info', code } : null;
  } catch { return undefined; } finally { clearTimeout(t); }
}

async function probeDirect(code, timeout) {
  try {
    const peer = await getClientPeer();
    const conn = await connectTo(peer, PEER_PREFIX + code, { reliable: true, serialization: 'json', metadata: { k: 'probe' } }, timeout);
    return await new Promise(resolve => {
      const t = setTimeout(() => { try { conn.close(); } catch { /* ignore */ } resolve(null); }, timeout);
      conn.on('data', m => { if (m.t === 'info') { clearTimeout(t); try { conn.close(); } catch { /* ignore */ } resolve({ ...m, code }); } });
    });
  } catch { return null; }
}

// Ask the relay and the room itself at once; a full answer from either wins.
export function probeRoom(code, timeout = 3500) {
  return new Promise(resolve => {
    let left = 2, partial = null;
    const take = v => {
      if (left <= 0) return;
      if (v && v.proto != null) { left = 0; resolve(v); return; }
      if (v) partial = v;
      if (--left === 0) resolve(partial);
    };
    relayInfo(code).then(take, () => take(null));
    probeDirect(code, timeout).then(take, () => take(null));
  });
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
