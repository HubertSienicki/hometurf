// The client-side game: simulates the cars this browser owns (the local
// player, plus bots when hosting), draws everyone else from snapshots, runs
// items / abilities / timing, and talks to the room server through `send`.
import { NET, PHYS, CARS, ITEMS, ITEM_TUNE, ABILITY, BOT_LEVELS } from './sim/config.js';
import { Track } from './sim/track.js';
import { makeCarState, stepCar, collideCars, placeCar, respawn, teleportAlong, applyBoost, stun } from './sim/physics.js';
import { BotBrain } from './sim/ai.js';
import { ItemWorld, rollItem } from './sim/items.js';
import { clamp, wrapAngle, lerp, lerpAngle, mulberry32, hashString } from './sim/util.js';

const DT = PHYS.dt;
const SEND_MS = 1000 / NET.STATE_HZ;
const NO_INPUT = { throttle: 0, brake: 0, steer: 0, drift: false, driftPressed: false, useItem: false, useAbility: false, back: false };
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;

// Flag bits shared in car snapshots.
export const F = {
  DRIFT: 1, DRIFT_R: 2, TIER: 12, BOOST: 16, SHIELD: 32, STAR: 64, RAM: 128, MIRROR: 256, GHOST: 512,
  SPIN: 1024, TUMBLE: 2048, BRAKE: 4096, FIN: 8192, TRICK: 16384, SLOW: 32768, WALL: 65536, INK: 131072,
};

export class Clock {
  constructor(isHost) { this.offset = 0; this.isHost = isHost; this.samples = []; }
  now() { return performance.now() + this.offset; }
  sample(c, h) {
    const t = performance.now(), rtt = t - c;
    this.samples.push({ rtt, off: h + rtt / 2 - t });
    if (this.samples.length > 12) this.samples.shift();
    const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.off;
    this.rtt = rtt;
  }
}

class CarEnt {
  constructor(id, info, owned, equalize) {
    this.id = id;
    this.name = info.name; this.type = CARS[info.car] ? info.car : 'comet'; this.color = info.color; this.build = info.build;
    this.bot = !!info.bot; this.owned = owned; this.level = info.level ?? 1;
    this.c = makeCarState(this.type, this.build, equalize);
    this.buf = [];
    this.brain = null;
    this.px = 0; this.py = 0; this.pz = 0; this.ph = 0;
    this.flags = 0; this.stunPhase = 0; this.steerVis = 0;
    // race
    this.bIdx = 0; this.secStart = null; this.lapStart = null; this.lapN = 0;
    this.finished = false; this.done = false; this.finTotal = null; this.rank = 0;
    this.pb = [null, null, null]; this.best = null; this.secs = [null, null, null]; this.lastLap = null;
    // items & ability
    this.item = null; this.itemCount = 0; this.roulette = 0; this.pending = null;
    this.ability = 0; this.respawnCD = 0; this.thrStart = null; this.rsDone = false;
    this.hitsLanded = 0;
  }
}

export class Game {
  constructor(o) {
    this.view = o.view; this.hud = o.hud; this.audio = o.audio; this.input = o.input; this.profile = o.profile; this.ui = o.ui;
    this.sendFn = o.send; this.myId = o.myId; this.isHost = !!o.isHost; this.offline = !!o.offline;
    this.clock = new Clock(this.isHost);
    this.room = null; this.trackData = null; this.track = null; this.trackHash = null; this.chunks = null;
    this.session = null; this.sessionId = 0; this.pendingSession = null;
    this.cars = new Map(); this.ranked = [];
    this.items = null; this.boxes = [];
    this.acc = 0; this.sendT = 0; this.pingT = 0; this.pingN = 0;
    this.rng = mulberry32((Math.random() * 1e9) | 0);
    this.seq = 0; this.goT = -99; this.now = 0;
    this.spectate = null; this.me = null;
    this.ci = { ...NO_INPUT };
    this.edges = { driftP: false, itemP: false, abilityP: false };
    this._hits = [];
    this.beeped = 99;
    this.itemCtx = {
      car: id => { const e = this.cars.get(id); if (!e) return null; e.c.done = e.finished || e.done; return e.c; },
      leader: () => { for (const e of this.ranked) if (!e.finished) return e.id; return null; },
    };
  }

  send(m, reliable = true) { this.sendFn(m, reliable); }

  // ------------------------------------------------------------ network in
  onMessage(m) {
    switch (m.t) {
      case 'room': this.setRoom(m); break;
      case 'trk': this.onChunk(m); break;
      case 'snap': this.onSnap(m); break;
      case 'ev': this.applyEvent(m.e, false); break;
      case 'chat': this.ui.onChat(m); this.hud.chat(m); break;
      case 'pong': this.clock.sample(m.c, m.h); break;
      case 'kicked': this.ui.onKicked(); break;
    }
  }

  onChunk(m) {
    this.trackWait = 0;
    if (this.trackHash === m.h) return;
    if (!this.chunks || this.chunks.h !== m.h) this.chunks = { h: m.h, n: m.n, parts: new Array(m.n), got: 0 };
    const ch = this.chunks;
    if (!ch.parts[m.i]) { ch.parts[m.i] = m.d; ch.got++; }
    this.ui.onTrackProgress?.(ch.got / ch.n);
    if (ch.got === ch.n) {
      this.chunks = null;
      try { this.setTrack(JSON.parse(ch.parts.join('')), m.h); }
      catch (err) { console.error('Bad track data', err); }
    }
  }

  setTrack(data, hash) {
    this.trackData = data;
    this.trackHash = hash;
    this.track = new Track(data);
    this.view.loadTrack(this.track, this.room?.settings?.tod || 'day');
    this.ui.onTrack?.(data);
    if (this.pendingSession) { const s = this.pendingSession; this.pendingSession = null; this.beginSession(s); }
  }

  setRoom(room) {
    const prev = this.room;
    this.room = room;
    if (prev && prev.settings.tod !== room.settings.tod && this.track && !this.session) this.view.setTheme(room.settings.tod);
    const sess = room.session;
    if (sess && sess.id !== this.sessionId) {
      if (this.track && room.track && room.track.hash === this.trackHash) this.beginSession(sess);
      else { this.pendingSession = sess; this.ui.onTrackProgress?.(this.chunks ? this.chunks.got / this.chunks.n : 0); }
    } else if (sess && this.session) {
      this.session = sess;
      // practice late-joiners
      sess.grid.forEach((id, k) => { if (!this.cars.has(id) && sess.cars[id]) this.addSessionCar(id, k); });
    } else if (!sess && this.session) this.endSession();
    // remove cars of players who left
    if (this.session) {
      const ids = new Set(room.players.map(p => p.id));
      for (const id of [...this.cars.keys()]) if (!ids.has(id)) { this.view.removeCar(id); this.cars.delete(id); }
      for (const [id, t] of Object.entries(room.timing || {})) {
        const e = this.cars.get(id);
        if (e && !e.owned) { if (t.fin && e.finTotal == null) e.finTotal = t.total; e.best = t.best; }
      }
    }
    this.ui.onRoom(room, this);
  }

  onSnap(m) {
    if (!this.session) return;
    for (const s of m.s) {
      const e = this.cars.get(s[0]);
      if (!e || e.owned) continue;
      const last = e.buf[e.buf.length - 1];
      if (last && last.t >= s[1]) continue;
      e.buf.push({ t: s[1], x: s[2], y: s[3], z: s[4], h: s[5], vx: s[6], vz: s[7], steer: s[8], f: s[9], P: s[10], lat: s[11], sp: s[12], si: s[13] });
      if (e.buf.length > 30) e.buf.shift();
    }
  }

  // ------------------------------------------------------------ sessions
  beginSession(sess) {
    this.session = sess;
    this.sessionId = sess.id;
    this.items = new ItemWorld(this.track);
    this.boxes = (this.track.feats.boxes || []).map(([s, lat], i) => {
      const p = this.track.pointAt(s);
      return { i, x: p.x + p.nx * lat, z: p.z + p.nz * lat, h: p.h, hideUntil: 0 };
    });
    for (const id of [...this.cars.keys()]) this.view.removeCar(id);
    this.cars.clear();
    sess.grid.forEach((id, k) => this.addSessionCar(id, k));
    this.me = this.cars.get(this.myId) || null;
    this.spectate = this.me ? null : sess.grid[0];
    this.acc = 0; this.beeped = 99; this.goT = (this.clock.now() - sess.startAt) / 1000;
    this.view.setTheme(sess.tod || 'day');
    this.view.sessionStart(this.boxes, sess.items, sess.ghost);
    this.hud.sessionStart(this);
    this.audio.sessionStart?.();
    this.ui.onSessionStart?.(sess, this);
  }

  addSessionCar(id, k) {
    const info = this.session.cars[id];
    if (!info) return;
    const owned = id === this.myId || (this.isHost && info.bot);
    const e = new CarEnt(id, info, owned, this.session.equalize);
    e.order = k;
    let slot = this.track.gridSlot(k);
    if (info.late) slot = this.track.gridSlot(Math.min(k, 11));
    placeCar(e.c, this.track, slot);
    e.px = e.c.x; e.pz = e.c.z; e.ph = e.c.h;
    e.bIdx = this.track.boundaryIndex(e.c.P);
    e.prevP = e.c.P;
    if (owned && info.bot) e.brain = new BotBrain(info.level ?? 1, hashString(id + this.sessionId));
    if (info.late && this.goT > 0) e.c.ghostT = 3;
    this.cars.set(id, e);
    this.view.addCar(id, info, id === this.myId);
  }

  endSession() {
    this.session = null;
    this.sessionId = 0;
    for (const id of [...this.cars.keys()]) this.view.removeCar(id);
    this.cars.clear();
    this.items = null;
    this.me = null;
    this.view.sessionEnd();
    this.hud.sessionEnd();
    this.audio.sessionEnd?.();
  }

  get kind() { return this.session?.kind; }

  // ------------------------------------------------------------ frame
  update(dt) {
    const now = this.clock.now();
    this.now = now;
    if (!this.isHost && !this.offline) {
      this.pingT -= dt;
      if (this.pingT <= 0) { this.pingT = this.pingN++ < 8 ? 0.4 : 3; this.send({ t: 'ping', c: performance.now() }); }
    }
    const inp = this.input.sample(dt);
    this.inp = inp;
    if (inp.driftP) this.edges.driftP = true;
    if (inp.itemP) this.edges.itemP = true;
    if (inp.abilityP) this.edges.abilityP = true;
    this.handleKeys(inp);
    // Missing the room's track (lost in transit, or joined mid-transfer)? Ask again.
    if (!this.isHost && this.room?.track && this.room.track.hash !== this.trackHash) {
      this.trackWait = (this.trackWait || 0) + dt;
      if (this.trackWait > 4) { this.trackWait = 0; this.chunks = null; this.send({ t: 'needtrack' }); }
    }
    if (!this.session || !this.track) return;
    const sess = this.session;
    this.goT = (now - sess.startAt) / 1000;
    this.countdown();
    this.updateRemote(now);
    this.computeRanks();
    this.acc = Math.min(this.acc + dt, 0.2);
    const n = Math.floor(this.acc / DT);
    for (let i = 0; i < n; i++) {
      this.stepNow = now - (this.acc - (i + 1) * DT) * 1000;
      this.step(DT);
    }
    this.acc -= n * DT;
    this.sendT -= dt * 1000;
    if (this.sendT <= 0) { this.sendT += SEND_MS; if (this.sendT < 0) this.sendT = SEND_MS; this.sendStates(now); }
    for (const b of this.boxes) if (b.hideUntil && now > b.hideUntil) { b.hideUntil = 0; this.view.boxShow(b.i, true); }
  }

  render(dt) {
    const alpha = clamp(this.acc / DT, 0, 1);
    if (this.session) {
      for (const e of this.cars.values()) {
        const c = e.c;
        if (e.owned) {
          this.view.poseCar(e.id, lerp(e.px, c.x, alpha), lerp(e.py, c.y, alpha), lerp(e.pz, c.z, alpha), lerpAngle(e.ph, c.h, alpha), e, dt);
        } else this.view.poseCar(e.id, c.x, c.y, c.z, c.h, e, dt);
      }
      if (this.items) this.view.syncItems(this.items, dt);
      const tgt = this.me && !this.me.finished ? this.me : this.cars.get(this.spectate) || this.me;
      this.view.follow(tgt, { look: this.inp?.look, goT: this.goT, me: tgt === this.me, finished: this.me?.finished, cinematic: this.attract || (!this.me && this.ui.cinematicSpectate) });
      this.view.startLights(this.goT);
    }
    this.view.render(dt);
    this.hud.frame(this, dt);
    this.audio.frame(this, dt);
  }

  countdown() {
    const t = this.goT;
    const n = Math.ceil(-t);
    if (t < 0 && n <= 3 && n < this.beeped) { this.beeped = n; this.audio.sfx('beep'); this.hud.countdown(n); }
    if (t >= 0 && this.beeped > 0 && this.beeped < 99) {
      this.beeped = 0;
      this.audio.sfx('go');
      this.hud.countdown(0);
    }
  }

  handleKeys(inp) {
    if (inp.respawnP && this.me && this.session && this.goT > 0 && !this.me.finished) this.tryRespawn(this.me);
    if (inp.quick) this.ui.quickChat?.(inp.quick);
    if ((inp.specNext || inp.specPrev) && this.session && (!this.me || this.me.finished)) {
      const ids = this.ranked.map(e => e.id).filter(id => id !== this.myId);
      if (ids.length) {
        let i = ids.indexOf(this.spectate);
        i = (i + (inp.specNext ? 1 : -1) + ids.length) % ids.length;
        this.spectate = ids[i];
      }
    }
  }

  tryRespawn(e) {
    if (e.respawnCD > 0 || e.c.stunT > 0) return;
    this.doRespawn(e);
  }
  doRespawn(e) {
    respawn(e.c, this.track);
    e.px = e.c.x; e.pz = e.c.z; e.py = 0; e.ph = e.c.h;
    e.respawnCD = 2;
    if (e === this.me) { this.audio.sfx('respawn'); this.view.fx.poof(e.c.x, 1, e.c.z); }
  }

  // ------------------------------------------------------------ simulation
  step(dt) {
    const sess = this.session, tr = this.track;
    const started = this.goT >= 0;
    const live = started && sess.state !== 'done';
    for (const e of this.cars.values()) {
      if (!e.owned) continue;
      const c = e.c;
      e.px = c.x; e.pz = c.z; e.py = c.y; e.ph = c.h;
      if (e.respawnCD > 0) e.respawnCD -= dt;
      let ci;
      if (e === this.me && !e.finished && !e.done) ci = this.playerInput(e, started);
      else if (e.brain) ci = e.brain.think(c, tr, dt, this.botCtx(e, started));
      else ci = NO_INPUT;
      if (!started) this.rocketWatch(e, ci);
      else if (!e.rsDone) this.rocketFire(e, ci);
      if (c.inkT > 0 && e.bot && !e.finished) ci.steer = clamp(ci.steer + Math.sin(this.now / 180 + e.order) * 0.6, -1, 1);
      e.prevP = c.P;
      stepCar(c, ci, tr, dt, { allowDrive: started, topMul: this.topMul(e) });
      e.steerVis += (ci.steer - e.steerVis) * Math.min(1, dt * 12);
      e.brakeVis = ci.brake > 0.1 && c.vf > 1;
      this.carEvents(e);
      if (e.brain?.wantRespawn) { e.brain.wantRespawn = false; this.doRespawn(e); }
      if (live) {
        this.timingTick(e);
        if (sess.items) this.boxCheck(e);
        this.hitCheck(e);
        this.itemTick(e, ci, dt);
        this.abilityTick(e, ci, dt);
        this.draftTick(e, dt);
      }
    }
    if (started && !sess.ghost && sess.collisions !== false) this.collisions();
    if (this.items) this.items.update(dt, this.itemCtx);
    this.edges.driftP = this.edges.itemP = this.edges.abilityP = false;
  }

  playerInput(e, started) {
    const inp = this.inp, ci = this.ci, c = e.c;
    ci.throttle = inp.throttle; ci.brake = inp.brake; ci.steer = inp.steer; ci.drift = inp.drift;
    ci.driftPressed = this.edges.driftP; ci.useItem = this.edges.itemP; ci.useAbility = this.edges.abilityP;
    ci.back = inp.brake > 0.5 || inp.look;
    // driving assist: nudge toward the road direction and away from walls.
    // Never while drift is held - the drift direction must come from the player.
    if (started && this.profile.settings.assist && Math.abs(ci.steer) < 0.15 && !c.drift && !inp.drift && c.vf > 6) {
      const tr = this.track, i = c.si < 0 ? 0 : c.si;
      const err = wrapAngle(tr.ang[i] - c.h);
      let a = clamp(-err * 0.9, -0.35, 0.35);
      const edge = tr.halfW - 1.5;
      if (Math.abs(c.lat) > edge) {
        const towards = Math.sign(c.lat) * Math.sign(-err || 1);
        a += -Math.sign(c.lat) * -0.35 * (towards > 0 ? 1 : 0.4);
      }
      ci.steer = clamp(ci.steer + a, -1, 1);
    }
    return ci;
  }

  rocketWatch(e, ci) {
    if (ci.throttle > 0.5) { if (e.thrStart == null) e.thrStart = this.goT; }
    else e.thrStart = null;
  }
  rocketFire(e, ci) {
    e.rsDone = true;
    let res = null;
    if (e.bot) res = this.rng() < [0.2, 0.5, 0.8][e.level] ? 'boost' : null;
    else if (e.thrStart != null && ci.throttle > 0.5) {
      if (e.thrStart > -0.75 && e.thrStart < -0.05) res = 'boost';
      else if (e.thrStart < -1.6) res = 'bog';
    }
    if (res === 'boost') { applyBoost(e.c, 1.1, 1.0); if (e === this.me) { this.hud.popup('ROCKET START!', 'good'); this.audio.sfx('boost'); } }
    if (res === 'bog') { e.c.slowT = 1.0; if (e === this.me) { this.hud.popup('BOGGED DOWN', 'bad'); this.audio.sfx('bog'); } }
  }

  topMul(e) {
    let m = 1;
    if (e.bot && !e.finished) {
      m *= BOT_LEVELS[e.level]?.top ?? 1;
      // gentle rubber band toward the best human
      let bestHuman = null;
      for (const o of this.cars.values()) if (!o.bot && (!bestHuman || o.c.P > bestHuman.c.P)) bestHuman = o;
      if (bestHuman) m *= 1 + clamp((bestHuman.c.P - e.c.P) / 600, -0.06, 0.05);
    }
    if (this.session.catchup && e.rank > 0 && this.ranked.length > 1) {
      const lead = this.ranked[0];
      m *= 1 + 0.06 * clamp((lead.c.P - e.c.P) / 400, 0, 1);
    }
    return m;
  }

  botCtx(e, started) {
    const ctx = this._bctx || (this._bctx = {});
    const c = e.c;
    ctx.started = started;
    ctx.item = e.item; ctx.itemReady = !!e.item && e.roulette <= 0;
    ctx.ability = CARS[e.type].ability;
    ctx.abilityReady = started && this.session.abilities && e.ability >= 1;
    const i = e.rank;
    const a = i > 0 ? this.ranked[i - 1] : null, b = this.ranked[i + 1] || null;
    ctx.ahead = a ? { car: a.c, gap: a.c.P - c.P } : null;
    ctx.behind = b ? { car: b.c, gap: c.P - b.c.P } : null;
    let near = 0, near40 = 0;
    for (const o of this.cars.values()) {
      if (o === e) continue;
      const d = Math.hypot(o.c.x - c.x, o.c.z - c.z);
      if (d < 18) near++;
      if (d < 40) near40++;
    }
    ctx.nearCars = near; ctx.nearCars40 = near40;
    let threat = false, dodge = 0;
    if (this.items) for (const o of this.items.objs.values()) {
      const d = Math.hypot(o.x - c.x, o.z - c.z);
      if ((o.kind === 'missile' || o.kind === 'bouncer') && o.owner !== e.id && d < 30) threat = true;
      if ((o.kind === 'oil' || o.kind === 'mine') && d < 32) {
        const dP = this.track.wrapS(this.track.project(o.x, o.z, c.si, this._tp || (this._tp = {})).s - c.lastS);
        if (dP > 2 && dP < 30 && Math.abs(o.lat - c.lat) < 3.5) dodge = o.lat > c.lat ? -1 : 1;
      }
    }
    ctx.threat = threat; ctx.dodge = dodge;
    return ctx;
  }

  carEvents(e) {
    const c = e.c, me = e === this.me;
    for (const ev of c.ev) {
      if (typeof ev === 'string') {
        if (ev[0] === 'm' && ev[1] === 't') {
          const tier = +ev[2];
          e.ability = Math.min(1, e.ability + ABILITY.perTier * tier);
          if (me) { this.audio.sfx('mt', { tier }); }
        } else if (me) {
          if (ev === 'pad') { this.audio.sfx('boost'); this.view.shake(0.15); }
          else if (ev === 'ramp') this.audio.sfx('ramp');
          else if (ev === 'land') { this.audio.sfx('land'); this.view.shake(0.25); }
          else if (ev === 'trick') this.audio.sfx('trick');
          else if (ev === 'trickboost') { this.hud.popup('TRICK!', 'good'); this.audio.sfx('boost'); }
          else if (ev === 'hop') this.audio.sfx('hop');
          else if (ev.startsWith('tier')) this.audio.sfx('tier', { tier: +ev[4] });
        }
      } else if (ev.k === 'wall') {
        const side = -ev.side;
        const rx = -Math.cos(c.h), rz = Math.sin(c.h);
        this.view.fx.sparks(c.x - rx * side * 1.0, 0.4, c.z - rz * side * 1.0, 10 + ev.p, 0xffc070);
        if (me) { this.audio.sfx('wall', { p: ev.p }); this.view.shake(Math.min(0.6, ev.p / 25)); }
      }
    }
    c.ev.length = 0;
  }

  // ---- timing: start line + 2 splits per lap, interpolated to the millisecond
  timingTick(e) {
    const c = e.c, tr = this.track;
    const b = tr.boundaryIndex(c.P);
    if (b <= e.bIdx) return;
    const prevP = e.prevP ?? c.P;
    for (let k = e.bIdx + 1; k <= b; k++) {
      const lap = Math.floor(k / 3), type = ((k % 3) + 3) % 3;
      const Pk = lap * tr.L + (type === 0 ? 0 : tr.sectors[type - 1]);
      const frac = c.P > prevP ? clamp((c.P - Pk) / (c.P - prevP), 0, 1) : 0;
      this.onBoundary(e, k, this.stepNow - frac * DT * 1000);
    }
    e.bIdx = b;
  }

  onBoundary(e, k, at) {
    const sess = this.session;
    const type = ((k % 3) + 3) % 3;
    const ended = (type + 2) % 3;                 // sector index that just finished
    const lap = type === 0 ? k / 3 : Math.floor(k / 3) + 1;  // lap the finished sector belongs to
    const ms = e.secStart != null ? at - e.secStart : null;
    e.secStart = at;
    let lapMs = null;
    if (type === 0) {
      if (lap >= 1) lapMs = sess.kind === 'race' && lap === 1 ? at - sess.startAt : (e.lapStart != null ? at - e.lapStart : null);
      e.lapStart = at;
      e.lapN = lap;
    }
    const send = { t: 'sec', id: e.id, lap, k: ended, ms: lap >= 1 || type !== 0 ? ms : null, lapMs, total: at - sess.startAt };
    if (type === 0 && lap === 0) send.ms = null;
    this.send(send);
    // local bookkeeping for HUD colours
    const best = this.room?.best?.secs || [];
    if (send.ms != null) {
      const prevPB = e.pb[ended];
      const color = best[ended] == null || send.ms <= best[ended] ? 'purple' : prevPB == null || send.ms < prevPB ? 'green' : 'yellow';
      if (prevPB == null || send.ms < prevPB) e.pb[ended] = send.ms;
      e.secs[ended] = { ms: send.ms, color };
      if (e === this.me) this.hud.sector(ended, send.ms, color, prevPB != null ? send.ms - prevPB : null);
    }
    if (type === 0) {
      if (lapMs != null) {
        const pb = e.best;
        e.lastLap = lapMs;
        if (pb == null || lapMs < pb) e.best = lapMs;
        if (e === this.me) this.hud.lap(lapMs, pb, this.room?.best?.lap);
      }
      if (e === this.me && lap >= 1) e.secs = [null, null, null];
      if (sess.kind === 'race') {
        if (lap >= sess.laps && !e.finished) this.finish(e, at);
        else if (e === this.me && lap === sess.laps - 1) { this.hud.banner('FINAL LAP', 'final'); this.audio.sfx('finallap'); }
      } else if (sess.state === 'flag' && !e.done && at > (sess.flagAt || 0) - 2000) {
        e.done = true;
        if (e === this.me) { this.hud.banner('SESSION COMPLETE', 'fin'); e.brain = new BotBrain(1, 3); }
      }
    }
  }

  finish(e, at) {
    e.finished = true;
    e.finTotal = at - this.session.startAt;
    if (!e.brain) e.brain = new BotBrain(1, hashString(e.id));
    if (e === this.me) {
      const place = this.ranked.filter(o => o.finished && o !== e).length + 1;
      this.hud.finish(place, e.finTotal);
      this.audio.sfx(place === 1 ? 'win' : 'finish');
      this.view.fx.confetti(e.c.x, e.c.z);
    }
  }

  computeRanks() {
    const arr = this.ranked;
    arr.length = 0;
    for (const e of this.cars.values()) arr.push(e);
    const quali = this.session.kind !== 'race';
    arr.sort((a, b) => {
      if (quali) return (a.best == null) - (b.best == null) || (a.best - b.best) || b.c.P - a.c.P;
      const fa = a.finTotal != null, fb = b.finTotal != null;
      if (fa !== fb) return fa ? -1 : 1;
      if (fa) return a.finTotal - b.finTotal;
      return b.c.P - a.c.P;
    });
    // item/ability odds use on-road order even in practice
    this.roadOrder = quali ? arr.slice().sort((a, b) => b.c.P - a.c.P) : arr;
    arr.forEach((e, i) => { e.rank = i; });
    if (quali) this.roadOrder.forEach((e, i) => { e.roadRank = i; }); else arr.forEach((e, i) => { e.roadRank = i; });
  }

  // ---- remote cars: snapshot interpolation in host time
  updateRemote(now) {
    const rt = now - NET.INTERP_MS;
    for (const e of this.cars.values()) {
      if (e.owned || !e.buf.length) continue;
      const B = e.buf, c = e.c;
      let a = B[0], b = null;
      for (let i = B.length - 1; i >= 0; i--) { if (B[i].t <= rt) { a = B[i]; b = B[i + 1] || null; break; } }
      if (B[0].t > rt) { a = B[0]; b = null; }
      if (b) {
        const t = (rt - a.t) / Math.max(1, b.t - a.t);
        c.x = lerp(a.x, b.x, t); c.y = lerp(a.y, b.y, t); c.z = lerp(a.z, b.z, t); c.h = lerpAngle(a.h, b.h, t);
        c.vx = lerp(a.vx, b.vx, t); c.vz = lerp(a.vz, b.vz, t); c.P = lerp(a.P, b.P, t); c.lat = lerp(a.lat, b.lat, t);
        e.steerVis = lerp(a.steer, b.steer, t); e.stunPhase = lerp(a.sp, b.sp, t);
      } else {
        const ex = clamp((rt - a.t) / 1000, 0, 0.25);
        c.x = a.x + a.vx * ex; c.z = a.z + a.vz * ex; c.y = a.y; c.h = a.h; c.vx = a.vx; c.vz = a.vz; c.P = a.P; c.lat = a.lat;
        e.steerVis = a.steer; e.stunPhase = a.sp;
      }
      const f = (b && rt - a.t > (b.t - a.t) / 2 ? b.f : a.f);
      e.flags = f;
      c.si = a.si;
      c.vf = c.vx * Math.sin(c.h) + c.vz * Math.cos(c.h);
      c.ramT = f & F.RAM ? 1 : 0; c.invT = f & F.STAR ? 1 : 0; c.ghostT = f & F.GHOST ? 1 : 0; c.shieldT = f & F.SHIELD ? 1 : 0;
      c.mirrorT = f & F.MIRROR ? 1 : 0; c.boostT = f & F.BOOST ? 1 : 0; c.slowT = f & F.SLOW ? 1 : 0;
      c.drift = f & F.DRIFT ? (f & F.DRIFT_R ? 1 : -1) : 0; c.driftTier = (f & F.TIER) >> 2;
      c.stunT = f & (F.SPIN | F.TUMBLE) ? 1 : 0; c.stunKind = f & F.SPIN ? 'spin' : f & F.TUMBLE ? 'tumble' : '';
      c.trickT = f & F.TRICK ? 1 : 0;
      if (f & F.FIN) e.finished = true;
    }
  }

  ownedFlags(e) {
    const c = e.c;
    let f = 0;
    if (c.drift) { f |= F.DRIFT; if (c.drift > 0) f |= F.DRIFT_R; f |= (c.driftTier & 3) << 2; }
    if (c.boostT > 0) f |= F.BOOST;
    if (c.shieldT > 0) f |= F.SHIELD;
    if (c.invT > 0) f |= F.STAR;
    if (c.ramT > 0) f |= F.RAM;
    if (c.mirrorT > 0) f |= F.MIRROR;
    if (c.ghostT > 0) f |= F.GHOST;
    if (c.stunT > 0) f |= c.stunKind === 'spin' ? F.SPIN : F.TUMBLE;
    if (e.brakeVis) f |= F.BRAKE;
    if (e.finished) f |= F.FIN;
    if (c.trickT > 0) f |= F.TRICK;
    if (c.slowT > 0) f |= F.SLOW;
    if (c.wallT > 0) f |= F.WALL;
    if (c.inkT > 0) f |= F.INK;
    return f;
  }

  sendStates(now) {
    const s = [];
    for (const e of this.cars.values()) {
      if (!e.owned) continue;
      const c = e.c;
      e.flags = this.ownedFlags(e);
      e.stunPhase = c.stunT > 0 ? 1 - c.stunT / c.stunDur : 0;
      s.push([e.id, Math.round(now), r2(c.x), r2(c.y), r2(c.z), r3(c.h), r2(c.vx), r2(c.vz), r2(e.steerVis), e.flags, r1(c.P), r2(c.lat), r2(e.stunPhase), c.si]);
    }
    if (s.length) this.send({ t: 'st', s }, false);
  }

  // ---- item boxes
  boxCheck(e) {
    const c = e.c, R2 = PHYS.boxRadius * PHYS.boxRadius;
    if (c.y > 2.5) return;
    for (const b of this.boxes) {
      if (b.hideUntil) continue;
      const dx = b.x - c.x, dz = b.z - c.z;
      if (dx * dx + dz * dz > R2) continue;
      this.emit({ k: 'box', i: b.i });
      if (!e.item && e.roulette <= 0) {
        e.pending = rollItem(this.rng, e.roadRank ?? e.rank, this.cars.size);
        e.roulette = ITEM_TUNE.roulette;
        if (e === this.me) this.audio.sfx('box');
      }
      break;
    }
  }

  itemTick(e, ci, dt) {
    if (e.roulette > 0) {
      e.roulette -= dt;
      if (e.roulette <= 0) {
        e.item = e.pending; e.pending = null;
        e.itemCount = ITEMS[e.item]?.uses || 1;
        if (e === this.me) this.audio.sfx('itemget');
      }
    } else if (ci.useItem && e.item) this.useItem(e, ci.back);
  }

  useItem(e, back) {
    const c = e.c, it = e.item, T = ITEM_TUNE;
    const fx = Math.sin(c.h), fz = Math.cos(c.h);
    const id = () => `${e.id}.${++this.seq}`;
    let used = true;
    switch (it) {
      case 'boost': case 'boost3':
        applyBoost(c, T.boost.dur, T.boost.pow);
        if (e === this.me) { this.audio.sfx('boost'); this.view.shake(0.2); }
        break;
      case 'oil': this.spawn({ id: id(), kind: 'oil', owner: e.id, x: c.x - fx * 3.4, z: c.z - fz * 3.4 }); break;
      case 'mine': this.spawn({ id: id(), kind: 'mine', owner: e.id, x: c.x - fx * 4, z: c.z - fz * 4 }); break;
      case 'bouncer': {
        const d = back ? -1 : 1, sp = T.bouncer.speed + Math.max(0, c.vf) * 0.5 * d * d;
        this.spawn({ id: id(), kind: 'bouncer', owner: e.id, x: c.x + fx * 2.8 * d, z: c.z + fz * 2.8 * d, vx: fx * sp * d, vz: fz * sp * d });
        break;
      }
      case 'missile': {
        const tgt = this.roadOrder[(e.roadRank ?? e.rank) - 1];
        this.spawn({ id: id(), kind: 'missile', owner: e.id, x: c.x + fx * 2.6, z: c.z + fz * 2.6, P: c.P + 2.6, lat: c.lat, target: tgt ? tgt.id : null });
        break;
      }
      case 'seeker':
        this.spawn({ id: id(), kind: 'seeker', owner: e.id, x: c.x, z: c.z, P: c.P, lat: c.lat, target: this.itemCtx.leader() });
        break;
      case 'shield': c.shieldT = T.shield.dur; if (e === this.me) this.audio.sfx('shield'); break;
      case 'star': c.invT = T.star.dur; applyBoost(c, 1.5, 1.0); if (e === this.me) this.audio.sfx('star'); break;
      case 'ink': this.emit({ k: 'ink', by: e.id }); break;
      case 'zap': this.emit({ k: 'zap', by: e.id }); break;
      case 'swap': {
        const tgt = this.roadOrder[(e.roadRank ?? e.rank) - 1];
        if (!tgt) { used = false; break; }
        this.emit({ k: 'swap', a: e.id, b: tgt.id, A: pose(c), B: pose(tgt.c) });
        break;
      }
    }
    if (!used) return;
    this.emit({ k: 'use', id: e.id, item: it });
    if (--e.itemCount <= 0) { e.item = null; e.itemCount = 0; }
  }

  spawn(spec) {
    spec.at = Math.round(this.now);
    this.emit({ k: 'spawn', o: spec });
  }

  // ---- abilities
  abilityTick(e, ci, dt) {
    const sess = this.session;
    if (!sess.abilities) return;
    const n = this.cars.size;
    const f = n > 1 ? (e.roadRank ?? e.rank) / (n - 1) : 0.5;
    e.ability = Math.min(1, e.ability + dt / ABILITY.chargeTime * lerp(ABILITY.posBoost[0], ABILITY.posBoost[1], f));
    if (ci.useAbility && e.ability >= 1 && e.c.stunT <= 0) this.useAbility(e);
  }

  useAbility(e) {
    const c = e.c, a = CARS[e.type].ability, A = ABILITY;
    e.ability = 0;
    const rx = -Math.cos(c.h), rz = Math.sin(c.h), fx = Math.sin(c.h), fz = Math.cos(c.h);
    switch (a) {
      case 'nitro': applyBoost(c, A.nitro.dur, A.nitro.pow); break;
      case 'ram': c.ramT = A.ram.dur; break;
      case 'blink': {
        const from = { x: c.x, z: c.z };
        teleportAlong(c, this.track, A.blink.dist);
        e.px = c.x; e.pz = c.z; e.ph = c.h;
        c.ghostT = Math.max(c.ghostT, 0.4);
        this.emit({ k: 'fx', fx: 'blink', x: from.x, z: from.z, x2: c.x, z2: c.z });
        break;
      }
      case 'emp': this.emit({ k: 'emp', by: e.id, x: c.x, z: c.z, r: A.emp.radius }); break;
      case 'oil3':
        for (const off of [-3.6, 0, 3.6]) {
          this.spawn({ id: `${e.id}.${++this.seq}`, kind: 'oil', owner: e.id, x: c.x - fx * (4 + Math.abs(off) * 0.6) + rx * off, z: c.z - fz * (4 + Math.abs(off) * 0.6) + rz * off });
        }
        break;
      case 'grapple': {
        let tgt = null;
        for (let i = (e.roadRank ?? e.rank) - 1; i >= 0; i--) {
          const o = this.roadOrder[i];
          if (o.c.P - c.P > A.grapple.range) break;
          if (o.c.P - c.P > 4) { tgt = o; break; }
        }
        if (!tgt) { e.ability = 1; if (e === this.me) this.hud.popup('NOBODY IN RANGE', 'bad'); return; }
        applyBoost(c, A.grapple.boost, 1.35);
        this.emit({ k: 'grapple', by: e.id, t: tgt.id });
        break;
      }
      case 'slam':
        c.vy = 6;
        this.emit({ k: 'boom', x: c.x, z: c.z, r: A.slam.radius, by: e.id, kind: 'slam' });
        break;
      case 'mirror': c.mirrorT = A.mirror.dur; break;
    }
    this.emit({ k: 'abil', id: e.id, a });
  }

  // ---- slipstream
  draftTick(e, dt) {
    const c = e.c;
    if (c.vf < 20 || this.session.ghost) { c.draftT = Math.max(0, c.draftT - dt); return; }
    const fx = Math.sin(c.h), fz = Math.cos(c.h);
    let found = false;
    for (const o of this.cars.values()) {
      if (o === e) continue;
      const dx = o.c.x - c.x, dz = o.c.z - c.z;
      const along = dx * fx + dz * fz, side = Math.abs(dx * fz - dz * fx);
      if (along > 4 && along < PHYS.draftRange && side < 2.6) { found = true; break; }
    }
    if (found) {
      c.draftT += dt;
      if (c.draftT >= PHYS.draftTime) {
        c.draftT = 0;
        applyBoost(c, 0.9, 0.75);
        if (e === this.me) { this.hud.popup('SLIPSTREAM', 'good'); this.audio.sfx('boost'); }
      }
    } else c.draftT = Math.max(0, c.draftT - dt * 2);
    e.drafting = found;
  }

  // ---- getting hit
  protectedFrom(c) { return c.invT > 0 || c.ramT > 0; }

  hitCheck(e) {
    const c = e.c;
    if (c.ghostT > 0) return;
    const hits = this.items.hitsOn(c, e.id, this._hits);
    for (const o of hits.slice()) this.resolveHit(e, o);
  }

  resolveHit(e, o) {
    const c = e.c, T = ITEM_TUNE;
    const prot = this.protectedFrom(c);
    switch (o.kind) {
      case 'oil':
        if (prot || c.shieldT > 0) { if (!prot) c.shieldT = 0; this.emit({ k: 'kill', id: o.id, x: o.x, z: o.z }); }
        else this.takeHit(e, 'spin', T.oil.spin * c.spec.oilMul, o.owner, 'oil', o.id);
        break;
      case 'mine':
        this.emit({ k: 'kill', id: o.id, x: o.x, z: o.z, silent: true });
        this.emit({ k: 'boom', x: o.x, z: o.z, r: T.mine.blast, by: o.owner, kind: 'mine' });
        break;
      case 'bouncer': case 'missile':
        if (c.mirrorT > 0 && o.owner !== e.id) {
          this.emit({ k: 'kill', id: o.id, x: o.x, z: o.z });
          this.spawn({ id: `${e.id}.${++this.seq}`, kind: 'missile', owner: e.id, x: c.x, z: c.z, P: c.P + 3, lat: c.lat, target: o.owner, reflected: true });
          if (e === this.me) this.hud.popup('REFLECTED!', 'good');
        } else if (prot || c.shieldT > 0) {
          if (!prot) c.shieldT = 0;
          this.emit({ k: 'kill', id: o.id, x: o.x, z: o.z });
        } else this.takeHit(e, o.kind === 'missile' ? 'tumble' : 'spin', o.kind === 'missile' ? T.stun.tumble : T.stun.spin, o.owner, o.kind, o.id);
        break;
      case 'seeker':
        this.emit({ k: 'kill', id: o.id, x: o.x, z: o.z, silent: true });
        this.emit({ k: 'boom', x: c.x, z: c.z, r: T.seeker.blast, by: o.owner, kind: 'seeker' });
        break;
    }
  }

  takeHit(e, kind, dur, by, what, objId = null) {
    stun(e.c, kind, dur);
    e.ability = Math.min(1, e.ability + ABILITY.onHit);
    this.emit({ k: 'hit', id: objId, v: e.id, by, kind: what, x: r1(e.c.x), z: r1(e.c.z) });
  }

  applyBoom(ev) {
    for (const e of this.cars.values()) {
      if (!e.owned) continue;
      const c = e.c;
      if (ev.kind === 'slam' && e.id === ev.by) continue;
      if (Math.hypot(c.x - ev.x, c.z - ev.z) > ev.r + 1) continue;
      if (c.ghostT > 0 || this.protectedFrom(c)) continue;
      if (c.shieldT > 0 && ev.kind !== 'seeker') { c.shieldT = 0; continue; }
      if (ev.kind === 'slam' && c.y > 1.2) continue;
      const kind = ev.kind === 'slam' ? 'slam' : 'tumble';
      this.takeHit(e, kind, ev.kind === 'slam' ? ITEM_TUNE.stun.slam : ITEM_TUNE.stun.tumble, ev.by, ev.kind);
    }
  }

  collisions() {
    const list = [];
    for (const e of this.cars.values()) if (!(e.c.ghostT > 0) && !e.done) list.push(e);
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a.owned) continue;
      for (let j = 0; j < list.length; j++) {
        const b = list[j];
        if (a === b || (b.owned && j < i)) continue;
        const imp = collideCars(a.c, b.c, b.owned);
        if (imp <= 0) continue;
        this.bump(a, b, imp);
        if (b.owned) this.bump(b, a, imp);
      }
    }
  }

  bump(a, b, imp) {
    const ca = a.c, cb = b.c;
    if (this.protectedFrom(cb) && !this.protectedFrom(ca) && ca.stunT <= 0 && imp > 1) {
      if (ca.shieldT > 0) ca.shieldT = 0;
      else this.takeHit(a, 'spin', ITEM_TUNE.stun.spin * 0.9, b.id, cb.invT > 0 ? 'star' : 'ram');
    }
    if (a === this.me && imp > 3) {
      this.audio.sfx('bump', { p: imp });
      this.view.shake(Math.min(0.5, imp / 30));
      this.view.fx.sparks((ca.x + cb.x) / 2, 0.6, (ca.z + cb.z) / 2, 8 + imp, 0xffe0a0);
    }
  }

  // ---- events (applied locally first, then relayed to everyone else)
  emit(ev) {
    this.applyEvent(ev, true);
    this.send({ t: 'ev', e: ev });
  }

  applyEvent(ev, local) {
    if (!ev || !this.session) return;
    const fx = this.view.fx;
    switch (ev.k) {
      case 'spawn': {
        if (!this.items || this.items.objs.has(ev.o.id)) break;
        const lag = local ? 0 : clamp((this.now - ev.o.at) / 1000, 0, 0.35);
        const o = this.items.spawn(ev.o, lag, this.itemCtx);
        this.audio.sfx('fire_' + o.kind, { at: o, game: this });
        break;
      }
      case 'kill': {
        const o = this.items?.remove(ev.id);
        if (o && !ev.silent) fx.poof(ev.x ?? o.x, 0.8, ev.z ?? o.z);
        break;
      }
      case 'hit': {
        const o = ev.id ? this.items?.remove(ev.id) : null;
        const victim = this.cars.get(ev.v);
        const x = ev.x ?? o?.x, z = ev.z ?? o?.z;
        if (x != null) {
          if (ev.kind === 'oil') fx.splat(x, z);
          else fx.explosion(x, 1, z, ev.kind === 'missile' ? 3 : 1.6, ev.kind === 'missile' ? 0xff6a2a : 0x9dff6a);
          this.audio.sfx(ev.kind === 'oil' ? 'skid' : 'hit', { at: { x, z }, game: this });
        }
        if (ev.by && ev.by !== ev.v) {
          const att = this.cars.get(ev.by);
          if (att && att === this.me) { this.me.hitsLanded++; this.hud.popup(`HIT ${victim ? victim.name.toUpperCase() : ''}`, 'hit'); }
          this.hud.feed({ by: att, v: victim, kind: ev.kind });
        }
        if (victim === this.me) { this.view.shake(0.6); this.hud.flash('rgba(255,60,60,0.35)'); }
        break;
      }
      case 'boom':
        fx.explosion(ev.x, 1, ev.z, ev.r * (ev.kind === 'slam' ? 0.5 : 0.45), ev.kind === 'seeker' ? 0x4aa8ff : ev.kind === 'slam' ? 0xd8c8a0 : 0xff7a2a);
        if (ev.kind === 'slam') fx.ring(ev.x, ev.z, ev.r, 0xffe7a8);
        this.audio.sfx(ev.kind === 'slam' ? 'slam' : 'boom', { at: ev, game: this });
        this.applyBoom(ev);
        if (this.me && Math.hypot(this.me.c.x - ev.x, this.me.c.z - ev.z) < ev.r * 3) this.view.shake(0.5);
        break;
      case 'box': {
        const b = this.boxes[ev.i];
        if (b) { b.hideUntil = this.now + ITEM_TUNE.boxRespawn * 1000; this.view.boxShow(ev.i, false); fx.boxBurst(b.x, b.z); }
        break;
      }
      case 'ink':
        for (const e of this.cars.values()) {
          if (!e.owned || e.id === ev.by) continue;
          const by = this.cars.get(ev.by);
          if (by && (e.roadRank ?? e.rank) < (by.roadRank ?? by.rank) && e.c.invT <= 0) {
            e.c.inkT = ITEM_TUNE.ink.dur;
            if (e === this.me) { this.hud.ink(); this.audio.sfx('splat'); }
          }
        }
        break;
      case 'zap':
        fx.lightning(this.cars, ev.by);
        this.audio.sfx('zap');
        for (const e of this.cars.values()) {
          if (!e.owned || e.id === ev.by) continue;
          const c = e.c;
          if (c.invT > 0 || c.ghostT > 0) continue;
          if (c.shieldT > 0) { c.shieldT = 0; continue; }
          stun(c, 'spin', ITEM_TUNE.zap.spin);
          c.slowT = ITEM_TUNE.zap.slow;
          e.item = null; e.itemCount = 0; e.roulette = 0;
          if (e === this.me) this.hud.flash('rgba(255,240,120,0.5)');
        }
        break;
      case 'emp':
        fx.ring(ev.x, ev.z, ev.r, 0x5ad8ff);
        this.audio.sfx('emp', { at: ev, game: this });
        for (const e of this.cars.values()) {
          if (!e.owned || e.id === ev.by) continue;
          const c = e.c;
          if (Math.hypot(c.x - ev.x, c.z - ev.z) > ev.r || c.invT > 0) continue;
          if (c.shieldT > 0) { c.shieldT = 0; continue; }
          c.slowT = Math.max(c.slowT, ABILITY.emp.slow);
          e.item = null; e.itemCount = 0; e.roulette = 0;
          if (e === this.me) { this.hud.flash('rgba(90,216,255,0.4)'); this.hud.popup('EMP!', 'bad'); }
        }
        break;
      case 'grapple': {
        const t = this.cars.get(ev.t);
        fx.grapple(ev.by, ev.t);
        this.audio.sfx('grapple', { at: t?.c, game: this });
        if (t && t.owned && t.c.invT <= 0) t.c.slowT = Math.max(t.c.slowT, ABILITY.grapple.slow);
        break;
      }
      case 'swap': {
        const a = this.cars.get(ev.a), b = this.cars.get(ev.b);
        if (a?.owned) setPose(a, ev.B, this.track);
        if (b?.owned) setPose(b, ev.A, this.track);
        fx.blink(ev.A.x, ev.A.z); fx.blink(ev.B.x, ev.B.z);
        this.audio.sfx('swap');
        if (b === this.me || a === this.me) this.hud.popup('SWAPPED!', b === this.me ? 'bad' : 'good');
        break;
      }
      case 'use': {
        const e = this.cars.get(ev.id);
        if (e && ['zap', 'seeker', 'ink', 'swap', 'star'].includes(ev.item)) this.hud.feedUse(e, ev.item);
        break;
      }
      case 'abil': {
        const e = this.cars.get(ev.id);
        if (!e) break;
        fx.abilityBurst(e.c.x, e.c.z, ev.a);
        if (e === this.me || ['emp', 'slam', 'grapple'].includes(ev.a)) this.audio.sfx('abil_' + ev.a, { at: e.c, game: this });
        if (e !== this.me) this.hud.feedAbility(e, ev.a);
        break;
      }
      case 'fx':
        if (ev.fx === 'blink') { fx.blink(ev.x, ev.z); fx.blink(ev.x2, ev.z2); }
        break;
    }
  }

  // Distance-attenuated volume for positional one-shots.
  volumeAt(p) {
    const t = this.me?.c || this.cars.get(this.spectate)?.c;
    if (!t || !p) return 1;
    return clamp(1 - Math.hypot(p.x - t.x, p.z - t.z) / 180, 0, 1);
  }
}

function pose(c) { return { x: r2(c.x), z: r2(c.z), h: r3(c.h), P: r1(c.P), lat: r2(c.lat) }; }
function setPose(e, p, track) {
  const c = e.c;
  const speed = Math.max(0, c.vf);
  c.x = p.x; c.z = p.z; c.h = p.h;
  c.vx = Math.sin(c.h) * speed; c.vz = Math.cos(c.h) * speed;
  const pr = track.project(c.x, c.z, -1);
  c.si = pr.i; c.lastS = pr.s; c.lat = pr.lat;
  c.P = p.P;
  c.ghostT = Math.max(c.ghostT, 0.6);
  e.px = c.x; e.pz = c.z; e.ph = c.h;
  e.bIdx = Math.max(e.bIdx, track.boundaryIndex(c.P));
  e.prevP = c.P;
}
