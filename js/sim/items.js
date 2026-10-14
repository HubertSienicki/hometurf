// Items: rolling from the odds table, and the shared world of projectiles and
// hazards. Every peer simulates every object from its spawn event; only the
// owner of the car that gets hit decides the hit ("victim decides"), then
// broadcasts it so everyone removes the object at the same moment.
import { ITEM_ODDS, ITEM_TUNE } from './config.js';
import { clamp, wrapAngle, pickWeighted } from './util.js';

// rank 0 = leader. Odds blend between the five position buckets.
export function rollItem(rng, rank, count) {
  const f = count <= 1 ? 0.5 : clamp(rank / (count - 1), 0, 1);
  const b = f * 4, i0 = Math.floor(b), i1 = Math.min(4, i0 + 1), t = b - i0;
  const entries = [];
  for (const [k, w] of Object.entries(ITEM_ODDS)) {
    const v = w[i0] * (1 - t) + w[i1] * t;
    if (v > 0) entries.push([k, v]);
  }
  return pickWeighted(rng, entries);
}

const tmp = {};
const relP = (L, a, b) => { let d = (a - b) % L; if (d > L / 2) d -= L; else if (d < -L / 2) d += L; return d; };

export class ItemWorld {
  constructor(track) {
    this.track = track;
    this.objs = new Map();
  }
  clear() { this.objs.clear(); }
  remove(id) { const o = this.objs.get(id); this.objs.delete(id); return o; }

  // spec: { id, kind, owner, x, z, h, P, lat, target, vx, vz }  lag: seconds to fast-forward
  spawn(spec, lag = 0, ctx = null) {
    const T = ITEM_TUNE;
    const o = { ...spec, age: 0, y: 0.5, si: -1, bounces: 0, mode: 'track' };
    switch (o.kind) {
      case 'oil': o.life = T.oil.life; o.y = 0.02; break;
      case 'mine': o.life = T.mine.life; o.y = 1.2; break;
      case 'bouncer': o.life = T.bouncer.life; o.y = 0.7; break;
      case 'missile': o.life = T.missile.life; o.y = 0.9; break;
      case 'seeker': o.life = T.seeker.life; o.y = T.seeker.alt; break;
      default: o.life = 10;
    }
    const pr = this.track.project(o.x, o.z, -1, tmp);
    o.si = pr.i;
    if (o.P == null) o.P = pr.s;
    if (o.lat == null) o.lat = pr.lat;
    this.objs.set(o.id, o);
    if (lag > 0 && ctx) {
      const steps = Math.min(30, Math.ceil(lag / (1 / 60)));
      for (let i = 0; i < steps; i++) this.step(o, lag / steps, ctx);
    }
    return o;
  }

  update(dt, ctx) {
    for (const o of this.objs.values()) {
      if (!this.step(o, dt, ctx)) { this.objs.delete(o.id); ctx.onExpire?.(o); }
    }
  }

  step(o, dt, ctx) {
    o.age += dt;
    if (o.age > o.life) return false;
    if (o.kind === 'bouncer') return this.moveBouncer(o, dt);
    if (o.kind === 'missile') return this.moveMissile(o, dt, ctx);
    if (o.kind === 'seeker') return this.moveSeeker(o, dt, ctx);
    return true;
  }

  moveBouncer(o, dt) {
    const tr = this.track, lim = tr.halfW + 0.5;
    for (let k = 0; k < 2; k++) {
      o.x += o.vx * dt / 2; o.z += o.vz * dt / 2;
      const pr = tr.project(o.x, o.z, o.si, tmp);
      o.si = pr.i;
      if (Math.abs(pr.lat) > lim) {
        const sgn = Math.sign(pr.lat), nx = tr.sz[pr.i], nz = -tr.sx[pr.i];
        o.x -= nx * (Math.abs(pr.lat) - lim) * sgn; o.z -= nz * (Math.abs(pr.lat) - lim) * sgn;
        const vn = o.vx * nx + o.vz * nz;
        if (vn * sgn > 0) { o.vx -= 2 * vn * nx; o.vz -= 2 * vn * nz; o.bounces++; o.bounced = 0.12; }
        if (o.bounces > ITEM_TUNE.bouncer.bounces) return false;
      }
    }
    o.h = Math.atan2(o.vx, o.vz);
    if (o.bounced > 0) o.bounced -= dt;
    return true;
  }

  moveMissile(o, dt, ctx) {
    const tr = this.track, T = ITEM_TUNE.missile, hw = tr.halfW;
    const tgt = o.target ? ctx.car(o.target) : null;
    if (o.mode === 'track') {
      o.P += T.speed * dt;
      if (tgt && !tgt.done) {
        o.lat += (clamp(tgt.lat, -hw + 1, hw - 1) - o.lat) * Math.min(1, dt * 2.5);
        const dP = tgt.P - o.P;
        if (dP < 16 && dP > -6) o.mode = 'home';
      }
      const p = tr.pointAt(o.P, tmp);
      o.x = p.x + p.nx * o.lat; o.z = p.z + p.nz * o.lat; o.h = p.h; o.si = p.i;
    } else {
      if (!tgt || tgt.done) { o.mode = 'track'; return true; }
      const want = Math.atan2(tgt.x - o.x, tgt.z - o.z);
      o.h += clamp(wrapAngle(want - o.h), -T.turn * dt, T.turn * dt);
      o.x += Math.sin(o.h) * T.speed * dt; o.z += Math.cos(o.h) * T.speed * dt;
      const pr = tr.project(o.x, o.z, o.si, tmp);
      o.si = pr.i;
      if (Math.abs(pr.lat) > hw + 0.5) {
        const sgn = Math.sign(pr.lat), nx = tr.sz[pr.i], nz = -tr.sx[pr.i];
        o.x -= nx * (Math.abs(pr.lat) - hw - 0.5) * sgn; o.z -= nz * (Math.abs(pr.lat) - hw - 0.5) * sgn;
      }
      o.lat = clamp(pr.lat, -hw, hw);
      o.P += relP(tr.L, pr.s, tr.wrapS(o.P));
      if (Math.hypot(tgt.x - o.x, tgt.z - o.z) > 35) o.mode = 'track';
    }
    return true;
  }

  moveSeeker(o, dt, ctx) {
    const tr = this.track, T = ITEM_TUNE.seeker;
    const lead = ctx.leader?.();
    if (lead && o.mode === 'track') o.target = lead;
    const tgt = o.target ? ctx.car(o.target) : null;
    if (o.mode === 'track') {
      o.P += T.speed * dt;
      o.y += (T.alt - o.y) * Math.min(1, dt * 3);
      if (tgt && !tgt.done) {
        o.lat += (clamp(tgt.lat, -tr.halfW, tr.halfW) - o.lat) * Math.min(1, dt * 2);
        if (tgt.P - o.P < 10 && tgt.P - o.P > -15) o.mode = 'dive';
      }
      const p = tr.pointAt(o.P, tmp);
      o.x = p.x + p.nx * o.lat; o.z = p.z + p.nz * o.lat; o.h = p.h; o.si = p.i;
    } else {
      if (!tgt || tgt.done) return false;
      const dx = tgt.x - o.x, dz = tgt.z - o.z, d = Math.hypot(dx, dz) || 1;
      const sp = Math.max(T.speed * 0.8, d * 6);
      const m = Math.min(d, sp * dt);
      o.x += dx / d * m; o.z += dz / d * m; o.h = Math.atan2(dx, dz);
      o.y += (tgt.y + 0.8 - o.y) * Math.min(1, dt * 5);
      o.P = tgt.P;
    }
    return true;
  }

  // Objects touching car state `c` (owned by the caller). Returns array.
  hitsOn(c, id, out = []) {
    out.length = 0;
    const T = ITEM_TUNE;
    for (const o of this.objs.values()) {
      const dx = o.x - c.x, dz = o.z - c.z, d2 = dx * dx + dz * dz;
      if (d2 > 36) continue;
      const mine = o.owner === id;
      switch (o.kind) {
        case 'oil': if (c.y < 0.6 && o.age > (mine ? 0.8 : 0.1) && d2 < (T.oil.radius + 0.9) ** 2) out.push(o); break;
        case 'mine': if (c.y < 1.6 && o.age > (mine ? 1.0 : 0.15) && d2 < (T.mine.radius + 0.6) ** 2) out.push(o); break;
        case 'bouncer': if (Math.abs(c.y + 0.6 - o.y) < 1.6 && o.age > (mine ? 0.45 : 0) && d2 < (T.bouncer.radius + 1.1) ** 2) out.push(o); break;
        case 'missile': if (Math.abs(c.y + 0.6 - o.y) < 1.8 && o.age > (mine ? 0.8 : 0) && d2 < (T.missile.radius + 1.0) ** 2) out.push(o); break;
        case 'seeker': if (o.target === id && o.mode === 'dive' && d2 < 3.4 * 3.4 && Math.abs(o.y - c.y) < 3) out.push(o); break;
      }
    }
    return out;
  }
}
