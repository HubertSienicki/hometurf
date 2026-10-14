// HOME TURF server: the room relay below, plus accounts (accounts.js).
//
// Relay: the fallback for players whose network blocks direct
// browser-to-browser (WebRTC) links: mobile data, CGNAT, strict routers.
// It runs on Cloudflare Workers with one Durable Object per room code, and it
// only forwards text frames between the host's browser and its guests.
// The host's browser is still the game server.
//
// Host  -> relay   ">3,5|payload"  send payload to guests 3 and 5
//                  "#3"            close guest 3
//                  "@{...}"        room info shown in the server browser
//                  "."             keepalive
// Relay -> host    "+3" guest 3 connected, "-3" guest 3 left, "3|payload" a message from guest 3
// Guest <-> relay  the payload itself
// Relay -> anyone  "!ok" attached, "!taken" room code in use, "!none" no such room, "!full" room full
import { DurableObject } from 'cloudflare:workers';
export { Accounts } from './accounts.js';

const MAX_FRAME = 256 * 1024;
const MAX_GUESTS = 16;
const MAX_RATE = 120; // frames per second a guest may send; more are dropped
const MAX_INFO = 1500; // room info is kept in the host socket's attachment (2 KB max)
const ORIGINS = [
  /^https:\/\/hometurf-86d26fb3\.netlify\.app$/,
  /^https:\/\/[a-z0-9-]+--hometurf-86d26fb3\.netlify\.app$/,
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };

const API_CORS = { ...CORS, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin');
    if (origin && !ORIGINS.some(r => r.test(origin))) return new Response('forbidden', { status: 403 });
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: API_CORS });
      const res = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName('main')).fetch(req);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(API_CORS)) out.headers.set(k, v);
      return out;
    }
    const m = /^\/room\/([a-z0-9-]{3,48})(\/info)?$/.exec(url.pathname);
    if (!m) return new Response('HOME TURF server\n', { headers: CORS });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  },
};

const shut = (ws, code, why) => { try { ws.close(code, why); } catch { /* already closed */ } };
const tell = (ws, s) => { try { ws.send(s); } catch { /* closing */ } };
const refuse = (ws, msg, code, why) => { ws.accept(); tell(ws, msg); shut(ws, code, why); };

// One room. Sockets use the hibernation API, so a room idling in the lobby
// costs nothing; who is who lives in each socket's attachment:
//   host  { r: 'h', key, seq, info }     guest { r: 'g', id }     dead { r: 'x' }
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.gmap = null;          // guest id -> socket, rebuilt after waking up
    this.rate = new Map();     // guest socket -> { n, t0 }
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('.', '.'));
  }

  role(ws) { try { return ws.deserializeAttachment() || {}; } catch { return {}; } }
  host() { return this.ctx.getWebSockets('host').find(w => w.readyState === 1 && this.role(w).r === 'h') || null; }
  guests() {
    if (!this.gmap) {
      this.gmap = new Map();
      for (const w of this.ctx.getWebSockets()) { const a = this.role(w); if (a.r === 'g' && w.readyState === 1) this.gmap.set(a.id, w); }
    }
    return this.gmap;
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith('/info')) {
      const h = this.host();
      const body = `{"open":${!!h},"info":${(h && this.role(h).info) || 'null'}}`;
      return new Response(body, { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('expected a websocket', { status: 426, headers: CORS });
    const [client, ws] = Object.values(new WebSocketPair());
    if (url.searchParams.get('role') === 'host') this.addHost(ws, (url.searchParams.get('key') || '').slice(0, 32));
    else this.addGuest(ws);
    return new Response(null, { status: 101, webSocket: client });
  }

  addHost(ws, key) {
    const old = this.host();
    if (old) {
      // The same host coming back (reload, network blip) takes over; anyone else is refused.
      if (key.length >= 8 && key === this.role(old).key) this.dropHost(old, 'replaced');
      else return refuse(ws, '!taken', 4001, 'taken');
    }
    this.ctx.acceptWebSocket(ws, ['host']);
    ws.serializeAttachment({ r: 'h', key, seq: 0, info: null });
    tell(ws, '!ok');
  }

  dropHost(h, why) {
    try { h.serializeAttachment({ r: 'x' }); } catch { /* closed */ }
    shut(h, 1000, why);
    for (const g of this.guests().values()) { try { g.serializeAttachment({ r: 'x' }); } catch { /* closed */ } shut(g, 4002, 'host left'); }
    this.gmap = null; this.rate.clear();
  }

  addGuest(ws) {
    const h = this.host();
    if (!h) return refuse(ws, '!none', 4004, 'no such room');
    if (this.guests().size >= MAX_GUESTS) return refuse(ws, '!full', 4005, 'full');
    const ha = this.role(h);
    const id = ++ha.seq;
    h.serializeAttachment(ha);
    this.ctx.acceptWebSocket(ws, ['g' + id]);
    ws.serializeAttachment({ r: 'g', id });
    this.guests().set(id, ws);
    tell(ws, '!ok');
    tell(h, '+' + id);
  }

  webSocketMessage(ws, d) {
    if (typeof d !== 'string') return;
    const a = this.role(ws);
    if (a.r === 'h') return this.fromHost(ws, a, d);
    if (a.r !== 'g' || d.length > MAX_FRAME) return;
    let r = this.rate.get(ws);
    const now = Date.now();
    if (!r || now - r.t0 >= 1000) { r = { n: 0, t0: now }; this.rate.set(ws, r); }
    if (++r.n > MAX_RATE) return;
    const h = this.host();
    if (h) tell(h, a.id + '|' + d);
  }

  fromHost(ws, a, d) {
    const c = d[0];
    if (c === '>') {
      const bar = d.indexOf('|');
      if (bar < 0) return;
      const payload = d.slice(bar + 1), gs = this.guests();
      for (const id of d.slice(1, bar).split(',')) { const g = gs.get(+id); if (g) tell(g, payload); }
    } else if (c === '#') {
      const id = +d.slice(1), g = this.guests().get(id);
      if (!g) return;
      this.guests().delete(id); this.rate.delete(g);
      try { g.serializeAttachment({ r: 'x' }); } catch { /* closed */ }
      shut(g, 4003, 'closed by host');
    } else if (c === '@') {
      const info = d.slice(1);
      if (info.length > MAX_INFO) return;
      try { JSON.parse(info); } catch { return; }
      a.info = info;
      ws.serializeAttachment(a);
    }
  }

  webSocketClose(ws) { this.gone(ws); }
  webSocketError(ws) { this.gone(ws); }

  gone(ws) {
    const a = this.role(ws);
    shut(ws, 1000, 'bye');
    if (a.r === 'h') { this.dropHost(ws, 'host left'); return; }
    if (a.r !== 'g') return;
    try { ws.serializeAttachment({ r: 'x' }); } catch { /* closed */ }
    this.guests().delete(a.id); this.rate.delete(ws);
    const h = this.host();
    if (h) tell(h, '-' + a.id);
  }
}
