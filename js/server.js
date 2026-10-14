// Host-side room authority. Lives in the host's tab next to the host's own
// Game (which talks to it through a loopback link as player "p0").
// Owns: players, settings, bots, the track, sessions (practice / qualifying /
// race), sector timing, results and championship points. Car movement is
// owned by each player's browser; the server relays snapshots and events.
import { VERSION } from './version.js';
import { NET, DEFAULT_SETTINGS, BOT_NAMES, CAR_IDS, PAINT, POINTS, BOT_LEVELS } from './sim/config.js';
import { PARTS, SLOTS, LIVERIES, sanitizeBuild } from './sim/parts.js';
import { Track } from './sim/track.js';

const now = () => performance.now();
const HOST = 'p0';
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const cleanName = n => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18) || 'Driver';

export class HostServer {
  constructor({ net = null, hello, onLocal, code = null, saved = {}, hostSpectates = false }) {
    this.net = net;
    this.hostSpectates = hostSpectates;
    this.onLocal = onLocal;
    this.code = code;
    this.settings = { ...DEFAULT_SETTINGS, ...saved, public: !!saved.public };
    this.players = new Map();
    this.track = null; this.trackStr = ''; this.trackMeta = null;
    this.session = null; this.sessSeq = 0;
    this.phase = 'lobby';
    this.states = new Map();
    this.timing = {};
    this.sessBest = { secs: [null, null, null], lap: null, lapId: null };
    this.finOrder = [];
    this.results = null;
    this.standings = {};
    this.weekend = null;
    this.pidSeq = 1; this.botSeq = 0;
    this.snapT = 0;
    this.dirty = false;
    this.addPlayer(HOST, hello, true);
    this.syncBots();
    if (net) {
      net.onJoin = h => this.join(h);
      net.onMessage = (pid, m) => this.receive(pid, m);
      net.onLeave = pid => this.leave(pid);
      net.onInfo = () => this.info();
    }
  }

  // ------------------------------------------------------------ transport
  sendTo(pid, m, reliable = true) {
    if (pid === HOST) { queueMicrotask(() => this.onLocal(m)); return; }
    this.net?.send(pid, m, reliable);
  }
  broadcast(m, except = null, reliable = true) {
    if (except !== HOST) queueMicrotask(() => this.onLocal(m));
    this.net?.broadcast(m, except, reliable);
  }
  markDirty() {
    if (this.dirty) return;
    this.dirty = true;
    queueMicrotask(() => { this.dirty = false; this.broadcast(this.roomMsg()); });
  }

  info() {
    const ps = [...this.players.values()];
    const host = this.players.get(HOST);
    return {
      proto: NET.PROTO, name: `${host ? host.name : 'Host'}'s room`, players: ps.filter(p => !p.bot).length, bots: ps.filter(p => p.bot).length,
      max: NET.MAX_CARS, track: this.trackMeta?.name || '-', phase: this.phase, mode: this.settings.mode, ver: VERSION,
    };
  }

  roomMsg() {
    return {
      t: 'room', code: this.code, hostId: HOST, phase: this.phase, settings: this.settings,
      players: [...this.players.values()].map(p => ({ id: p.id, name: p.name, car: p.car, color: p.color, build: p.build, bot: !!p.bot, level: p.level, ready: !!p.ready, spectator: !!p.spectator, xpLevel: p.xpLevel || 1 })),
      track: this.trackMeta, session: this.session, timing: this.timing, best: this.sessBest,
      results: this.results, standings: this.standings, weekend: this.weekend,
    };
  }

  // ------------------------------------------------------------ players
  addPlayer(id, h, isHost = false) {
    const car = CAR_IDS.includes(h.car) ? h.car : 'comet';
    const p = {
      id, name: cleanName(h.name), car, color: PAINT.includes(h.color) ? h.color : PAINT[0],
      build: sanitizeBuild(car, h.build), bot: false, host: isHost, ready: isHost, spectator: false, token: h.token, xpLevel: Math.max(1, Math.min(99, h.xpLevel | 0)),
    };
    this.players.set(id, p);
    return p;
  }

  join(h) {
    if (h.t !== 'hello') return { err: 'Bad handshake.' };
    if (h.proto !== NET.PROTO) return { err: `Version mismatch: the host has v${VERSION}, you have ${h.ver ? 'v' + String(h.ver).slice(0, 12) : 'an older version'}. Refresh the page (Ctrl+F5) on both ends.` };
    const humans = [...this.players.values()].filter(p => !p.bot).length;
    if (humans >= NET.MAX_CARS) return { err: 'Room is full.' };
    // make room by dropping a bot if needed
    if (this.players.size >= NET.MAX_CARS) {
      const bot = [...this.players.values()].reverse().find(p => p.bot && !(this.session && this.session.grid.includes(p.id)));
      if (bot) this.players.delete(bot.id);
    }
    const id = 'p' + this.pidSeq++;
    const p = this.addPlayer(id, h);
    if (this.session && this.phase === 'session') {
      if (this.session.kind === 'practice' && this.session.grid.length < NET.MAX_CARS) this.addToSession(p);
      else p.spectator = true;
    }
    this.system(`${p.name} joined`);
    queueMicrotask(() => this.sendTrack(id));
    this.markDirty();
    return { id, welcome: { t: 'welcome', id, room: this.roomMsg() } };
  }

  leave(pid) {
    const p = this.players.get(pid);
    if (!p) return;
    this.players.delete(pid);
    this.states.delete(pid);
    this.system(`${p.name} left`);
    this.syncBots();
    this.checkSessionEnd();
    this.markDirty();
  }

  kick(id) {
    if (id === HOST) return;
    const p = this.players.get(id);
    if (!p) return;
    if (p.bot) {
      this.players.delete(id);
      this.settings.bots = Math.max(0, [...this.players.values()].filter(q => q.bot).length);
      this.markDirty();
      return;
    }
    this.sendTo(id, { t: 'kicked' });
    setTimeout(() => this.net?.drop(id), 300);
  }

  makeBot() {
    const used = new Set([...this.players.values()].map(p => p.name));
    const name = BOT_NAMES.find(n => !used.has(n)) || `Bot ${this.botSeq + 1}`;
    const car = CAR_IDS[Math.floor(Math.random() * CAR_IDS.length)];
    const build = { livery: LIVERIES[Math.floor(Math.random() * LIVERIES.length)] };
    for (const s of SLOTS) {
      const opts = Object.keys(PARTS[s].options);
      if (Math.random() < 0.45) build[s] = opts[Math.floor(Math.random() * opts.length)];
    }
    const id = 'b' + this.botSeq++;
    const p = {
      id, name, car, color: PAINT[Math.floor(Math.random() * PAINT.length)], build: sanitizeBuild(car, build),
      bot: true, level: this.settings.botLevel, ready: true, spectator: false,
    };
    this.players.set(id, p);
    return p;
  }

  syncBots() {
    if (this.phase === 'session') return;
    const bots = [...this.players.values()].filter(p => p.bot);
    const humans = this.players.size - bots.length;
    const want = Math.max(0, Math.min(this.settings.bots, NET.MAX_CARS - humans));
    for (let i = bots.length; i < want; i++) this.makeBot();
    for (let i = bots.length - 1; i >= want; i--) this.players.delete(bots[i].id);
    for (const b of this.players.values()) if (b.bot) b.level = this.settings.botLevel;
  }

  system(text) { this.broadcast({ t: 'chat', sys: true, text }); }

  // ------------------------------------------------------------ host controls
  setSettings(patch) {
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULT_SETTINGS) this.settings[k] = v;
    this.settings.laps = Math.max(1, Math.min(20, this.settings.laps | 0));
    this.settings.bots = Math.max(0, Math.min(NET.MAX_CARS - 1, this.settings.bots | 0));
    this.settings.botLevel = Math.max(0, Math.min(BOT_LEVELS.length - 1, this.settings.botLevel | 0));
    this.syncBots();
    this.markDirty();
  }

  setTrack(data) {
    // the host plans the pit lane once and it travels with the track, so every player drives the same one
    if (data.pit === undefined) data.pit = new Track(data).pit;
    this.track = data;
    this.trackStr = JSON.stringify(data);
    this.trackMeta = {
      id: data.id, name: data.name, len: data.len, author: data.author || '', width: data.width, preset: data.preset || null,
      origin: data.origin || null, hash: `${data.id}:${this.trackStr.length}`, pit: !!data.pit,
      pts: thin(data.pts, 120),
    };
    for (const id of this.players.keys()) if (!this.players.get(id).bot) this.sendTrack(id);
    this.markDirty();
  }

  sendTrack(pid) {
    if (!this.trackStr) return;
    const h = this.trackMeta.hash;
    if (pid === HOST) { this.sendTo(pid, { t: 'trk', h, i: 0, n: 1, d: this.trackStr }); return; }
    const n = Math.ceil(this.trackStr.length / NET.CHUNK);
    for (let i = 0; i < n; i++) this.sendTo(pid, { t: 'trk', h, i, n, d: this.trackStr.slice(i * NET.CHUNK, (i + 1) * NET.CHUNK) });
  }

  // kind: 'practice' | 'quali' | 'race'
  startSession(kind) {
    if (!this.track) return;
    if (this.phase === 'session' && this.session?.state !== 'done') return;   // finish or end the current one first
    this.syncBots();
    const ps = [...this.players.values()];
    for (const p of ps) p.spectator = this.hostSpectates && p.id === HOST;
    let grid = ps.filter(p => !p.spectator).map(p => p.id);
    if (kind === 'race' && this.weekend?.quali?.length) {
      const q = this.weekend.quali;
      grid.sort((a, b) => (q.includes(a) ? q.indexOf(a) : 99) - (q.includes(b) ? q.indexOf(b) : 99));
    } else shuffle(grid);
    grid = grid.slice(0, NET.MAX_CARS);
    const s = this.settings;
    const cars = {};
    for (const p of ps) cars[p.id] = { name: p.name, car: p.car, color: p.color, build: p.build, bot: p.bot, level: p.level };
    this.session = {
      id: ++this.sessSeq, kind, grid, cars,
      startAt: now() + 5200,
      endAt: kind === 'race' ? null : now() + 5200 + (kind === 'quali' ? s.qualiMin : s.practiceMin) * 60000,
      laps: s.laps, items: s.items && kind !== 'quali', abilities: s.abilities && kind !== 'quali',
      ghost: kind === 'quali', collisions: s.collisions, catchup: s.catchup && kind === 'race', equalize: !s.upgrades,
      tod: s.tod, pits: !!s.pitstops, wear: s.tyreWear, state: 'run', flagAt: null, finishBy: null,
    };
    this.timing = {};
    for (const id of grid) this.timing[id] = { laps: 0, best: null, last: null, bestSecs: [null, null, null], cur: [null, null, null], fin: false, total: null, done: false, hits: 0 };
    this.sessBest = { secs: [null, null, null], lap: null, lapId: null };
    this.finOrder = [];
    this.results = null;
    this.states.clear();
    this.phase = 'session';
    if (!this.weekend && s.mode === 'weekend') this.weekend = { stage: kind, quali: null };
    if (this.weekend) this.weekend.stage = kind;
    const label = { practice: 'Practice', quali: 'Qualifying', race: 'Race' }[kind];
    this.system(`${label} is starting${kind === 'race' ? ` - ${s.laps} lap${s.laps > 1 ? 's' : ''}` : ''}!`);
    this.markDirty();
  }

  addToSession(p) {
    const sess = this.session;
    sess.grid.push(p.id);
    sess.cars[p.id] = { name: p.name, car: p.car, color: p.color, build: p.build, bot: p.bot, level: p.level, late: true };
    this.timing[p.id] = { laps: 0, best: null, last: null, bestSecs: [null, null, null], cur: [null, null, null], fin: false, total: null, done: false, hits: 0 };
  }

  // Ends the running session right now (host button) or naturally.
  endSession() {
    if (!this.session || this.session.state === 'done') return;
    this.session.state = 'done';
    this.results = this.computeResults();
    this.phase = 'results';
    if (this.session.kind === 'quali' && this.weekend) this.weekend.quali = this.results.rows.map(r => r.id);
    if (this.session.kind === 'race' && this.results.rows.length > 1) {
      for (const r of this.results.rows) if (r.pts) this.standings[r.id] = (this.standings[r.id] || 0) + r.pts;
    }
    const w = this.results.rows[0];
    if (w) this.system(this.session.kind === 'race' ? `${w.name} wins!` : `${w.name} tops the timesheet with ${fmt(w.best)}`);
    this.markDirty();
  }

  backToLobby() {
    if (this.session && this.session.state !== 'done') this.endSession();
    this.session = null;
    this.phase = 'lobby';
    if (this.results?.kind === 'race' || this.settings.mode !== 'weekend') this.weekend = null;
    this.syncBots();
    this.markDirty();
  }

  nextStage() {
    const k = this.results?.kind;
    if (this.settings.mode === 'weekend' && k === 'practice') return this.startSession('quali');
    if (this.settings.mode === 'weekend' && k === 'quali') return this.startSession('race');
    return this.backToLobby();
  }

  computeResults() {
    const sess = this.session;
    const rows = sess.grid.filter(id => sess.cars[id]).map(id => {
      const t = this.timing[id] || {}, c = sess.cars[id], st = this.states.get(id);
      return { id, name: c.name, car: c.car, color: c.color, bot: c.bot, best: t.best, laps: t.laps || 0, total: t.total, fin: !!t.fin, P: st ? st[10] : -1e9, hits: t.hits || 0, bestSecs: t.bestSecs, gone: !this.players.has(id) };
    });
    if (sess.kind === 'race') {
      rows.sort((a, b) => (b.fin - a.fin) || (a.fin ? a.total - b.total : 0) || (b.laps - a.laps) || (b.P - a.P));
      const n = rows.length;
      rows.forEach((r, i) => { r.pos = i + 1; r.pts = n > 1 && !r.gone ? (POINTS[i] || 0) : 0; r.dnf = !r.fin; });
      const lead = rows[0];
      for (const r of rows) r.gap = r.fin && lead.fin ? r.total - lead.total : null;
    } else {
      rows.sort((a, b) => (a.best == null) - (b.best == null) || (a.best - b.best));
      rows.forEach((r, i) => { r.pos = i + 1; r.gap = r.best != null && rows[0].best != null ? r.best - rows[0].best : null; });
    }
    let fast = null;
    for (const r of rows) if (r.best != null && (!fast || r.best < fast.ms)) fast = { id: r.id, ms: r.best };
    const hitter = rows.slice().sort((a, b) => b.hits - a.hits)[0];
    return { kind: sess.kind, rows, fastest: fast, bestSecs: this.sessBest.secs, topHitter: hitter && hitter.hits ? { id: hitter.id, n: hitter.hits } : null };
  }

  // ------------------------------------------------------------ messages
  owns(pid, carId) {
    if (pid === carId) return true;
    const p = this.players.get(carId);
    return pid === HOST && (!p || p.bot);
  }

  receive(pid, m) {
    if (!m || typeof m !== 'object') return;
    const p = this.players.get(pid);
    if (!p) return;
    switch (m.t) {
      case 'st':
        if (Array.isArray(m.s)) for (const s of m.s) if (Array.isArray(s) && this.owns(pid, s[0])) this.states.set(s[0], s);
        break;
      case 'ping':
        this.sendTo(pid, { t: 'pong', c: m.c, h: now() });
        break;
      case 'chat': {
        const text = String(m.text || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 160);
        if (text) this.broadcast({ t: 'chat', id: pid, name: p.name, color: p.color, text });
        break;
      }
      case 'prof': {
        if (CAR_IDS.includes(m.car)) p.car = m.car;
        if (PAINT.includes(m.color)) p.color = m.color;
        if (m.name) p.name = cleanName(m.name);
        p.build = sanitizeBuild(p.car, m.build);
        if (m.xpLevel) p.xpLevel = Math.max(1, Math.min(99, m.xpLevel | 0));
        this.markDirty();
        break;
      }
      case 'ready':
        p.ready = !!m.v;
        this.markDirty();
        break;
      case 'needtrack':
        if (performance.now() - (p.trackAsk || 0) > 2500) { p.trackAsk = performance.now(); this.sendTrack(pid); }
        break;
      case 'ev':
        if (m.e && typeof m.e === 'object') {
          this.broadcast(m, pid);
          if (m.e.k === 'hit' && m.e.by && m.e.v !== m.e.by && this.timing[m.e.by]) this.timing[m.e.by].hits++;
        }
        break;
      case 'sec':
        if (this.owns(pid, m.id)) this.onSector(m);
        break;
    }
  }

  // One timing split from a car's owner. k: sector index that just ENDED (0..2).
  onSector(m) {
    const sess = this.session;
    const t = this.timing[m.id];
    if (!sess || !t || sess.state === 'done') return;
    const ms = typeof m.ms === 'number' && m.ms > 0 ? Math.round(m.ms) : null;
    const k = m.k | 0;
    if (k < 0 || k > 2) return;
    if (ms != null) {
      t.cur[k] = ms;
      if (t.bestSecs[k] == null || ms < t.bestSecs[k]) t.bestSecs[k] = ms;
      if (this.sessBest.secs[k] == null || ms < this.sessBest.secs[k]) this.sessBest.secs[k] = ms;
    } else t.cur[k] = null;
    if (k === 2) {
      t.laps = Math.max(t.laps, m.lap | 0);
      const lapMs = typeof m.lapMs === 'number' && m.lapMs > 0 ? Math.round(m.lapMs) : null;
      if (lapMs != null) {
        t.last = lapMs;
        if (t.best == null || lapMs < t.best) t.best = lapMs;
        if (this.sessBest.lap == null || lapMs < this.sessBest.lap) { this.sessBest.lap = lapMs; this.sessBest.lapId = m.id; }
      }
      if (sess.kind === 'race' && t.laps >= sess.laps && !t.fin) {
        t.fin = true; t.total = Math.round(m.total);
        this.finOrder.push(m.id);
        if (this.finOrder.length === 1) sess.finishBy = now() + 45000;
      }
      if (sess.kind !== 'race' && sess.state === 'flag') t.done = true;
      this.checkSessionEnd();
    }
    this.markDirty();
  }

  checkSessionEnd() {
    const sess = this.session;
    if (!sess || sess.state === 'done' || this.phase !== 'session') return;
    const active = sess.grid.filter(id => this.players.has(id) && this.timing[id]);
    const humans = active.filter(id => !this.players.get(id).bot);
    if (sess.kind === 'race') {
      const doneH = humans.every(id => this.timing[id].fin);
      const doneAll = active.every(id => this.timing[id].fin);
      if (doneAll || (this.finOrder.length && doneH && humans.length)) this.endSession();
    } else if (sess.state === 'flag') {
      if (active.every(id => this.timing[id].done)) this.endSession();
    }
  }

  // Called every frame by main.js (rAF or the background worker).
  update() {
    const t = now();
    // keep idle lobbies alive: guests time out after 6 s of silence
    if (this.net && t - (this.hbT || 0) > 2000) { this.hbT = t; this.net.broadcast({ t: 'hb' }); }
    const sess = this.session;
    if (sess && this.phase === 'session') {
      if (sess.kind !== 'race' && sess.state === 'run' && t >= sess.endAt) {
        sess.state = 'flag'; sess.flagAt = t;
        this.system('Chequered flag - finish your lap!');
        this.markDirty();
      }
      if (sess.state === 'flag' && t > sess.flagAt + 75000) this.endSession();
      if (sess.kind === 'race' && sess.finishBy && t > sess.finishBy) this.endSession();
      if (sess.kind === 'race' && t > sess.startAt + sess.laps * 240000 + 60000) this.endSession();
      if (t - this.snapT >= 1000 / NET.SNAP_HZ) {
        this.snapT = t;
        if (this.states.size) this.broadcast({ t: 'snap', s: [...this.states.values()] }, null, false);
      }
    }
  }

  destroy() {
    this.net?.destroy();
    this.net = null;
  }
}

function fmt(ms) {
  if (ms == null) return '-';
  const m = Math.floor(ms / 60000), s = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
  return `${m}:${s}`;
}

// Downsample a flat centerline for previews (minimap in lobby / browser).
function thin(flat, target) {
  const n = flat.length / 2, step = Math.max(1, Math.floor(n / target)), out = [];
  for (let i = 0; i < n; i += step) out.push(Math.round(flat[i * 2]), Math.round(flat[i * 2 + 1]));
  return out;
}
