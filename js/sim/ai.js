// Bot drivers: follow a racing line, brake for corners they can't take flat,
// drift through long bends, use items and abilities with some cunning.
// Also used as the autopilot after a player finishes.
import { BOT_LEVELS, PHYS, ABILITY } from './config.js';
import { clamp, wrapAngle, mulberry32 } from './util.js';

export class BotBrain {
  constructor(level = 1, seed = 1) {
    this.L = BOT_LEVELS[clamp(level, 0, BOT_LEVELS.length - 1)];
    this.rng = mulberry32(seed);
    this.offset = (this.rng() - 0.5) * 2;   // personal lane preference
    this.offT = 0;
    this.itemT = 0;
    this.abilT = 0;
    this.stuckT = 0;
    this.reverseT = 0;
    this.wantRespawn = false;
    this.driftHeld = false;
    this.lat = 0;
    this.out = { throttle: 0, brake: 0, steer: 0, drift: false, driftPressed: false, useItem: false, useAbility: false, back: false };
  }

  // ctx: { item, itemReady, abilityReady, ability, ahead: {car, gap} | null, behind: {car, gap} | null,
  //        threat (projectile near), rank, count, started, nearCars (within 18 m) }
  think(c, track, dt, ctx) {
    const o = this.out, L = this.L;
    o.driftPressed = false; o.useItem = false; o.useAbility = false; o.back = false;
    const v = Math.max(0, c.vf);
    const s = c.lastS;
    const hw = track.halfW;

    // lane wander so bots don't drive in a conga line
    this.offT -= dt;
    if (this.offT <= 0) { this.offT = 2 + this.rng() * 4; this.offset = clamp(this.offset + (this.rng() - 0.5) * 1.2, -1, 1); }

    // racing line: drift to the inside of the corner coming up
    const look = 7 + v * 0.42;
    const kLook = track.curvAt(s + look * 1.25);
    let target = clamp(kLook * 140, -1, 1) * L.line * hw + this.offset * hw * 0.25;
    if (ctx.dodge) target = clamp(target + ctx.dodge * hw * 0.6, -hw * 0.75, hw * 0.75);
    this.lat += (clamp(target, -hw * 0.8, hw * 0.8) - this.lat) * Math.min(1, dt * 2.2);
    const p = track.pointAt(s + look);
    const tx = p.x + p.nx * this.lat, tz = p.z + p.nz * this.lat;
    const want = Math.atan2(tx - c.x, tz - c.z);
    const err = wrapAngle(want - c.h);
    let steer = clamp(-err * L.gain * (c.drift ? 1.6 / c.spec.driftYaw : 1.16 / c.spec.maxYaw), -1, 1);

    // speed: the slowest speed the road ahead allows, given braking distance
    // yaw falls off with speed (see stepCar): v*k = yaw*(1 - c v/top)
    const S = c.spec, canDrift = L.drift && ctx.started;
    let allowed = Infinity, kMax = 0;
    const range = v * 1.1 + 16;
    for (let d = 3; d <= range; d += 3) {
      const k = Math.abs(track.curvAt(s + d));
      kMax = Math.max(kMax, k);
      const vGrip = S.maxYaw * 0.95 / (k + 0.35 * S.maxYaw * 0.95 / S.top);
      const yd = S.driftYaw * 1.2;
      const vDrift = canDrift && k > 1 / 45 ? yd / (k + 0.2 * yd / S.top) : 0;
      const vSafe = k > 1e-4 ? Math.max(vGrip, vDrift) : Infinity;
      allowed = Math.min(allowed, Math.sqrt(vSafe * vSafe + 2 * PHYS.brake * 0.55 * d));
    }
    let throttle = 1, brake = 0;
    if (v > allowed * 1.04) { throttle = 0; brake = clamp((v - allowed) / 5, 0.25, 1); }
    else if (v > allowed * 0.97) throttle = 0.4;

    // drifting: commit to long bends, release as they open up
    const kNear = track.curvAt(s + 6 + v * 0.25);
    if (L.drift && ctx.started) {
      if (!this.driftHeld && Math.abs(kNear) > 1 / 42 && v > 15) {
        this.driftHeld = true; o.driftPressed = true;
        steer = kNear > 0 ? -1 : 1;     // left turn (k>0) = steer left (-1)
      } else if (this.driftHeld && (Math.abs(kNear) < 1 / 80 || (c.drift && Math.sign(-kNear) !== c.drift && Math.abs(kNear) > 1 / 120))) {
        // hold on a moment if the next mini-turbo tier is about to land
        const next = PHYS.driftTiers[c.driftTier];
        const nearly = c.drift && next != null && c.driftCharge > next - 0.3 && Math.abs(kNear) < 1 / 50;
        if (!nearly) this.driftHeld = false;
      }
      if (this.driftHeld && !c.drift && c.y <= 0 && v > 13 && Math.abs(kNear) > 1 / 42) steer = kNear > 0 ? -1 : 1;
    } else this.driftHeld = false;

    // wrong way / stuck recovery
    const tdot = Math.sin(c.h) * track.tx[c.si < 0 ? 0 : c.si] + Math.cos(c.h) * track.tz[c.si < 0 ? 0 : c.si];
    if (ctx.started && c.stunT <= 0) {
      if (v < 1.5 && throttle > 0) this.stuckT += dt; else this.stuckT = Math.max(0, this.stuckT - dt);
      if (this.stuckT > 1.4 && this.reverseT <= 0) { this.reverseT = 0.9; }
      if (this.stuckT > 4.5 || c.wrongT > 2.5) { this.wantRespawn = true; this.stuckT = 0; }
    }
    if (this.reverseT > 0) {
      this.reverseT -= dt;
      throttle = 0; brake = 1; steer = -steer;
    } else if (tdot < -0.2) { steer = err > 0 ? -1 : 1; throttle = 0.7; }

    o.throttle = throttle; o.brake = brake; o.steer = steer; o.drift = this.driftHeld;

    // ---- items
    if (ctx.item && ctx.itemReady) {
      this.itemT += dt * L.items;
      const it = ctx.item, react = L.react, straight = kMax < 1 / 90;
      const a = ctx.ahead, b = ctx.behind;
      let use = false;
      switch (it) {
        case 'boost': case 'boost3': use = this.itemT > react * 0.5 && straight && v > 10; break;
        case 'bouncer':
          if (a && a.gap < 45 && Math.abs(wrapAngle(Math.atan2(a.car.x - c.x, a.car.z - c.z) - c.h)) < 0.12) use = true;
          else if (b && b.gap < 22 && this.itemT > react) { use = true; o.back = true; }
          else if (this.itemT > 9) use = true;
          break;
        case 'missile': use = this.itemT > react && a && a.gap < 160; break;
        case 'oil': case 'mine': use = (b && b.gap < 30 && this.itemT > react * 0.6) || this.itemT > 7; break;
        case 'shield': use = ctx.threat || this.itemT > 5; break;
        case 'swap': use = this.itemT > react && a && a.gap < 120; break;
        default: use = this.itemT > react + this.rng() * 1.5;
      }
      if (use) { o.useItem = true; this.itemT = 0; }
    } else this.itemT = 0;

    // ---- ability
    if (ctx.abilityReady) {
      this.abilT += dt * L.items;
      const a = ctx.ahead, b = ctx.behind;
      let use = false;
      switch (ctx.ability) {
        case 'nitro': case 'blink': use = kMax < 1 / 100 && v > 14; break;
        case 'ram': use = ctx.nearCars > 0 || this.abilT > 6; break;
        case 'emp': use = ctx.nearCars40 >= 1; break;
        case 'oil3': use = b && b.gap < 35; break;
        case 'grapple': use = a && a.gap < ABILITY.grapple.range * 0.9 && a.gap > 12; break;
        case 'slam': use = ctx.nearCars > 0; break;
        case 'mirror': use = ctx.threat || this.abilT > 10; break;
      }
      if (use || this.abilT > 20) { o.useAbility = true; this.abilT = 0; }
    } else this.abilT = 0;
    return o;
  }
}
