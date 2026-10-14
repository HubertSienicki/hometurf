// Arcade kart physics. Pure functions over plain car-state objects so the
// same code drives players, bots, remote prediction and the headless sim.
//
// Heading h: forward = (sin h, cos h). Steering input +1 = right, which
// DEcreases h. Right vector = (-cos h, sin h).
import { PHYS } from './config.js';
import { computeStats } from './parts.js';
import { clamp, wrapAngle, lerpAngle } from './util.js';
import { makeDrivetrain, driveStep, dragAt, initDrive } from './drivetrain.js';
import { pitBounds, PIT, TYRE, tyreGrip } from './pit.js';


// Continuous stats (base car + parts, see parts.js) -> physics constants.
export function specFromStats(st) {
  const top = 32.4 + st.spd * 0.5;                 // 32.9 .. 34.9 m/s for stats 1..5
  // 0 -> 90% of top speed: 8.0 .. 4.0 s for stats 1..5, met through real gears (drivetrain.js)
  const t90 = Math.max(3.3, 9.0 - st.acc * 1.0);
  const dr = st.drift || 1;
  return {
    top, t90,
    drive: makeDrivetrain(st.engine || 'i4', top, t90, st.acc),   // engine, gears (drivetrain.js)
    maxYaw: 0.65 + st.hnd * 0.17,                  // grip turning rate (rad/s)
    driftYaw: (0.75 + st.hnd * 0.085) * (0.85 + 0.15 * dr), // drift turning rate (x0.5..1.3 by steering)
    driftRate: dr,                                 // mini-turbo charge speed
    grip: 9 + st.hnd * 1.5,                        // lateral velocity damping (1/s)
    driftGrip: 3.6 + st.hnd * 0.3,
    mass: (0.8 + st.wgt * 0.3) * (st.ram || 1),
    stunMul: (1.22 - st.wgt * 0.08) * (st.stun || 1), // heavier cars shake off hits faster
    oilMul: st.oil || 1,
    jump: st.jump || 1,
  };
}
export const makeSpec = (type, build, equalize) => specFromStats(computeStats(type, build, equalize));

const TIMERS = ['boostT', 'slowT', 'inkT', 'shieldT', 'invT', 'ramT', 'mirrorT', 'ghostT', 'trickT', 'wallT'];

export function makeCarState(type, build) {
  return {
    type, spec: makeSpec(type, build),
    x: 0, z: 0, y: 0, vy: 0, h: 0, vx: 0, vz: 0, vf: 0, vl: 0, yaw: 0,
    drift: 0, driftCharge: 0, driftTier: 0, hopT: 0,
    boostT: 0, boostPow: 1, slowT: 0, inkT: 0, shieldT: 0, invT: 0, ramT: 0, mirrorT: 0, ghostT: 0,
    stunT: 0, stunDur: 0, stunKind: '',
    airT: 0, trick: false, trickT: 0, rampS: -1, rampAir: false, padS: -1, wallT: 0,
    si: -1, lat: 0, P: 0, lastS: 0, wrongT: 0, draftT: 0,
    gear: 1, rpm: 0.12, shiftT: 0, shiftDur: 1, shiftCD: 0, perfT: 0, limT: 0, lastShift: '', manual: false,
    tyre: 0, gripMul: 1,                                   // tyre wear 0..1 and the grip it leaves
    inPit: false, pitLim: false, pitT: 0, pitDone: false,  // pit lane, limiter, service hold
    ev: [],
  };
}

export function applyBoost(c, dur, pow) {
  if (c.boostT <= 0) c.boostPow = pow; else c.boostPow = Math.max(c.boostPow, pow);
  c.boostT = Math.max(c.boostT, dur);
}

export function stun(c, kind, dur) {
  c.stunKind = kind;
  c.stunDur = c.stunT = dur * c.spec.stunMul;
  c.drift = 0; c.driftCharge = 0; c.driftTier = 0;
  c.boostT = 0;
  if (kind === 'tumble' || kind === 'slam') c.vy = kind === 'slam' ? 6 : 7.5;
}

export function placeCar(c, track, slot) {
  c.x = slot.x; c.z = slot.z; c.h = slot.h; c.y = 0; c.vy = 0;
  c.vx = c.vz = c.vf = c.vl = 0;
  initDrive(c);
  c.tyre = 0; c.gripMul = 1; c.inPit = c.pitLim = c.pitDone = false; c.pitT = 0;
  c.si = -1;
  const pr = track.project(c.x, c.z, -1);
  c.si = pr.i; c.lat = pr.lat; c.lastS = pr.s;
  c.P = slot.P;
}

// Put the car back on the road at its current progress (minus a bit).
export function respawn(c, track, back = 8) {
  const s = c.lastS - back;
  const p = track.pointAt(s);
  const lat = clamp(c.lat, -track.halfW * 0.5, track.halfW * 0.5);
  c.x = p.x + p.nx * lat; c.z = p.z + p.nz * lat; c.h = p.h;
  c.y = 0; c.vy = 0; c.vx = c.vz = 0; c.vf = c.vl = 0;
  c.si = p.i; c.lastS = track.wrapS(s); c.P -= back; c.lat = lat;
  c.stunT = 0; c.stunKind = ''; c.drift = 0; c.driftCharge = 0; c.driftTier = 0;
  c.ghostT = PHYS.respawnGhost; c.wrongT = 0;
  c.gear = 1; c.shiftT = 0; c.perfT = 0;
  c.inPit = c.pitLim = false; c.pitT = 0;
}

// Jump `dist` metres along the track keeping lateral offset and speed.
export function teleportAlong(c, track, dist) {
  const speed = Math.max(0, c.vx * Math.sin(c.h) + c.vz * Math.cos(c.h));
  const s = c.lastS + dist;
  const p = track.pointAt(s);
  const lat = clamp(c.lat, -track.halfW + 1.5, track.halfW - 1.5);
  c.x = p.x + p.nx * lat; c.z = p.z + p.nz * lat; c.h = p.h;
  c.vx = Math.sin(c.h) * speed; c.vz = Math.cos(c.h) * speed;
  c.si = p.i; c.lastS = track.wrapS(s); c.P += dist;
}

const relS = (track, s, s0) => { let d = s - s0; const L = track.L; if (d > L / 2) d -= L; else if (d < -L / 2) d += L; return d; };

// inp: { throttle 0..1, brake 0..1, steer -1..1, drift (held), driftPressed (edge),
//        shiftUp / shiftDown (edges, manual gearbox: c.manual) }
// env: { allowDrive, topMul, pits (pit lane open), wear (tyre wear rate, 0 = off) }
export function stepCar(c, inp, track, dt, env) {
  const S = c.spec, ev = c.ev;
  for (let i = 0; i < TIMERS.length; i++) { const k = TIMERS[i]; if (c[k] > 0) c[k] = Math.max(0, c[k] - dt); }
  if (c.stunT > 0) { c.stunT -= dt; if (c.stunT <= 0) { c.stunT = 0; c.stunKind = ''; } }
  if (c.hopT > 0) c.hopT -= dt;
  const stunned = c.stunT > 0;
  // in the pit box: held still while the crew works, new tyres when they're done
  const held = c.pitT > 0;
  if (held) {
    c.pitT -= dt;
    c.vx = c.vz = 0;
    if (c.pitT <= 0) { c.pitT = 0; c.tyre = 0; c.gripMul = 1; c.pitDone = true; ev.push('pitdone'); }
  }
  const drive = env.allowDrive && !stunned && !held;
  const gm = c.gripMul ?? 1;
  const thr = drive ? inp.throttle : 0, brk = drive ? inp.brake : 0, st = drive ? inp.steer : 0;
  const onGround = c.y <= 0.0001 && c.vy <= 0;
  let fx = Math.sin(c.h), fz = Math.cos(c.h);
  let vf = c.vx * fx + c.vz * fz;

  // ---- hop, drift and mini-turbo
  if (drive && inp.driftPressed) {
    if (onGround && vf > 3) { c.vy = PHYS.hopV; c.hopT = 0.3; ev.push('hop'); }
    else if (!onGround && c.rampAir && !c.trick) { c.trick = true; c.trickT = 0.55; ev.push('trick'); }
  }
  if (c.drift === 0) {
    if (drive && inp.drift && Math.abs(st) > 0.25 && vf > PHYS.driftMinSpeed && (onGround || c.hopT > 0)) {
      c.drift = st > 0 ? 1 : -1; c.driftCharge = 0; c.driftTier = 0; ev.push('drift');
    }
  } else if (!drive || !inp.drift || vf < PHYS.driftMinSpeed * 0.6) {
    if (drive && c.driftTier > 0) {
      const [d, p] = PHYS.miniTurbo[c.driftTier - 1];
      applyBoost(c, d, p);
      ev.push('mt' + c.driftTier);
    }
    c.drift = 0; c.driftCharge = 0; c.driftTier = 0;
  } else if (onGround) {
    c.driftCharge += dt * 0.95 * S.driftRate;
    const T = PHYS.driftTiers;
    const tier = c.driftCharge >= T[2] ? 3 : c.driftCharge >= T[1] ? 2 : c.driftCharge >= T[0] ? 1 : 0;
    if (tier > c.driftTier) { c.driftTier = tier; ev.push('tier' + tier); }
  }

  // ---- steering
  const sp = Math.abs(vf);
  const lowF = clamp(sp / 6, 0, 1);
  let yaw;
  if (c.drift) {
    const k = clamp(st * c.drift, -1, 1);
    yaw = c.drift * S.driftYaw * gm * (0.5 + 0.8 * (k + 1) / 2) * lowF * (1 - 0.2 * clamp(sp / S.top, 0, 1.2));
  } else {
    yaw = st * S.maxYaw * gm * lowF * (1 - 0.35 * clamp(sp / S.top, 0, 1.2)) * (vf < -0.5 ? -1 : 1);
  }
  if (!onGround) yaw *= 0.55;
  if (stunned) yaw = 0;
  c.yaw = yaw;
  c.h = wrapAngle(c.h - yaw * dt);
  fx = Math.sin(c.h); fz = Math.cos(c.h);
  const rx = -fz, rz = fx;
  vf = c.vx * fx + c.vz * fz;
  let vl = c.vx * rx + c.vz * rz;

  // ---- longitudinal
  let top = S.top * (env.topMul || 1);
  if (c.boostT > 0) top *= 1 + PHYS.boostTopMul * c.boostPow;
  if (c.invT > 0) top *= 1.12;
  if (c.ramT > 0) top *= 1.1;
  if (c.slowT > 0) top *= 0.6;
  if (c.pitLim) top = Math.min(top, PIT.limit);
  const Dt = S.drive;
  // gears + revs (m/s^2 at the wheels). On the grid the clutch is out: rev away.
  const engine = env.allowDrive ? driveStep(c, Dt, vf, thr, brk, dt, inp, onGround)
    : driveStep(c, Dt, vf, stunned ? 0 : inp.throttle || 0, 0, dt, undefined, false);
  if (onGround) {
    if (c.boostT > 0 && vf < top) vf += PHYS.boostAccel * dt;
    if (thr > 0) {
      if (vf < 0) vf += PHYS.brake * thr * dt;
      else vf += engine * dt;
    }
    // aero drag; a raised top speed (boosts, catch-up) means proportionally less of it
    if (vf > 0) vf -= dragAt(Dt, vf) * Math.min(1, (S.top / top) ** 3) * dt;
    if (brk > 0) {
      if (vf > 0.5) vf -= PHYS.brake * brk * dt;
      else vf = Math.max(vf - PHYS.reverseAccel * brk * dt, -PHYS.reverseMax);
    }
    if (thr === 0 && brk === 0 && c.boostT <= 0) vf -= Math.sign(vf) * Math.min(Math.abs(vf), PHYS.coast * dt);
    if (vf > top) vf -= Math.min(vf - top, (vf - top) * 1.6 * dt + 3 * dt);
    if (c.pitLim && vf > PIT.limit) vf -= Math.min(vf - PIT.limit, 26 * dt);   // pit limiter: brakes down to the limit
    if (stunned) vf *= Math.exp(-(c.stunKind === 'spin' ? 1.9 : 1.5) * dt);
    const grip = (c.drift ? S.driftGrip : S.grip) * gm;
    const nvl = vl * Math.exp(-grip * dt);
    if (c.drift) vf += Math.abs(vl - nvl) * 0.22;
    vl = nvl;
  } else {
    vl *= Math.exp(-0.8 * dt);
    vf -= vf * 0.04 * dt;
  }
  if (held) { vf = 0; vl = 0; }
  c.vx = fx * vf + rx * vl; c.vz = fz * vf + rz * vl;
  c.vf = vf; c.vl = vl;
  // ---- tyre wear: distance, sliding, drifting and hard braking all take rubber off
  if (env.wear > 0 && onGround && !held) {
    const T = TYRE;
    c.tyre = Math.min(1, c.tyre + dt * env.wear * (T.base * Math.min(1.3, Math.abs(vf) / S.top) + T.slide * Math.min(1, Math.abs(vl) / 6)
      + (c.drift ? T.drift : 0) + (brk > 0.5 && Math.abs(vf) > 8 ? T.brake : 0)));
    c.gripMul = tyreGrip(c.tyre);
  }
  c.x += c.vx * dt; c.z += c.vz * dt;

  // ---- track walls (and the pit lane's, sim/pit.js)
  const pr = track.project(c.x, c.z, c.si, c._pr || (c._pr = {}));
  c.si = pr.i;
  const limit = track.halfW + PHYS.curbW - PHYS.carHalfW;
  const pz = env.pits && track.pit ? pitBounds(track, track.pit, pr.s, pr.lat, c._pz || (c._pz = {})) : null;
  const lo = pz ? pz.lo : -limit, hi = pz ? pz.hi : limit;
  c.inPit = !!pz?.inPit;
  c.pitLim = c.inPit && pz.region === 2;
  if (!pz) c.pitDone = false;
  // stopped in a pit box: the game starts the service (and its quick-time event)
  if (c.inPit && pz.box && !c.pitDone && !held && Math.abs(vf) < 0.8 && drive) ev.push('pitbox');
  if (pr.lat > hi || pr.lat < lo) {
    const sgn = pr.lat > hi ? 1 : -1, edge = sgn > 0 ? hi : lo, over = (pr.lat - edge) * sgn;
    const nx = track.sz[pr.i], nz = -track.sx[pr.i];    // segment left normal
    c.x -= nx * over * sgn; c.z -= nz * over * sgn;
    const inx = -sgn * nx, inz = -sgn * nz;
    const vn = c.vx * inx + c.vz * inz;
    if (vn < 0) {
      const speed = Math.hypot(c.vx, c.vz);
      c.vx -= (1 + PHYS.wallBounce) * vn * inx; c.vz -= (1 + PHYS.wallBounce) * vn * inz;
      const loss = 1 - 0.5 * clamp(-vn / (speed + 0.01), 0, 1);
      c.vx *= loss; c.vz *= loss;
      if (-vn > 5) ev.push({ k: 'wall', p: -vn, side: sgn });
      // swing the nose back along the road so cars never get pinned
      const th = Math.atan2(track.sx[pr.i], track.sz[pr.i]);
      const fwd = fx * track.sx[pr.i] + fz * track.sz[pr.i];
      if (!stunned) c.h = lerpAngle(c.h, fwd >= 0 ? th : th + Math.PI, clamp(-vn / 30, 0.04, 0.3));
      c.drift = c.drift && -vn < 9 ? c.drift : 0;
    }
    c.vx *= Math.exp(-0.6 * dt); c.vz *= Math.exp(-0.6 * dt);
    c.wallT = 0.12;
    pr.lat = edge;
  }
  c.lat = pr.lat;

  // ---- progress along the loop
  const s = pr.s;
  const ds = relS(track, s, c.lastS);
  c.P += ds; c.lastS = s;
  const tdot = fx * track.sx[pr.i] + fz * track.sz[pr.i];
  if (tdot < -0.35 && vf > 4) c.wrongT += dt; else c.wrongT = Math.max(0, c.wrongT - dt * 2);

  // ---- boost pads and jump ramps
  const feats = track.feats;
  let onPad = false;
  if (onGround || c.y < 0.3) {
    for (let i = 0; i < feats.pads.length; i++) {
      const [s0, lat0] = feats.pads[i];
      const d = relS(track, s, s0);
      if (d >= 0 && d <= PHYS.padLen && Math.abs(pr.lat - lat0) < PHYS.padHalfW) {
        onPad = true;
        if (c.padS !== s0) { c.padS = s0; applyBoost(c, 1.2, 1.05); ev.push('pad'); }
      }
    }
  }
  if (!onPad) c.padS = -1;
  let groundY = 0;
  for (let i = 0; i < feats.ramps.length && !c.inPit; i++) {
    const s0 = feats.ramps[i], d = relS(track, s, s0);
    if (d >= 0 && d <= PHYS.rampLen) {
      const gy = PHYS.rampH * d / PHYS.rampLen;
      if (c.y <= gy + 0.25) { groundY = gy; c.rampS = s0; }
    } else if (c.rampS === s0 && d > PHYS.rampLen && d < PHYS.rampLen + 4) {
      c.rampS = -1;
      if (vf > 6) { c.vy = (2.2 + vf * 0.2) * S.jump; c.rampAir = true; ev.push('ramp'); }
    }
  }
  if (c.rampS !== -1 && groundY === 0) c.rampS = -1;

  // ---- vertical
  if (c.y > groundY + 0.0001 || c.vy > 0) {
    c.vy -= PHYS.gravity * dt;
    c.y += c.vy * dt;
    c.airT += dt;
    if (c.y <= groundY) {
      if (c.airT > 0.35) {
        ev.push('land');
        if (c.trick) { applyBoost(c, 0.95, 1.05); ev.push('trickboost'); }
      }
      c.y = groundY; c.vy = 0; c.airT = 0; c.trick = false; c.rampAir = false;
    }
  } else { c.y = groundY; c.vy = 0; c.airT = 0; c.rampAir = false; c.trick = false; }
}

// Circle-vs-circle bump. `a` is always resolved; `b` only when twoWay.
// Returns the closing speed (0 if no contact).
export function collideCars(a, b, twoWay) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const R = PHYS.carRadius * 2;
  const d2 = dx * dx + dz * dz;
  if (d2 >= R * R || d2 < 1e-8 || Math.abs(a.y - b.y) > 1.6) return 0;
  const d = Math.sqrt(d2), nx = dx / d, nz = dz / d, overlap = R - d;
  const heavy = c => (c.ramT > 0 || c.invT > 0 ? 4 : 1);
  const ma = a.spec.mass * heavy(a), mb = b.spec.mass * heavy(b);
  const wa = mb / (ma + mb), wb = ma / (ma + mb);
  a.x -= nx * overlap * wa; a.z -= nz * overlap * wa;
  if (twoWay) { b.x += nx * overlap * wb; b.z += nz * overlap * wb; }
  const rv = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
  if (rv >= 0) return 0.01;
  const j = -(1 + 0.55) * rv / (1 / ma + 1 / mb);
  a.vx -= j / ma * nx; a.vz -= j / ma * nz;
  if (twoWay) { b.vx += j / mb * nx; b.vz += j / mb * nz; }
  return -rv;
}
