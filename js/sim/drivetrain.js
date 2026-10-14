// Engines and gearboxes. Pure (no DOM): physics, the test bench, the rev
// counter and the engine sound all read these numbers, so what you hear and
// see is what the car is doing.
//
// Per unit mass, with r = engine speed as a fraction of the redline:
//   drive accel = P * torque(r) / vGear     (capped by tyre grip at launch)
//   r           = v / vGear                 (clutch in; it slips at launch)
//   drag        = D * v^2                   (balances the drive at top speed)
// vGear[g] is the road speed at the redline in gear g. Top gear is tall:
// flat out on a straight the engine settles around 3/4 of the redline, and
// only a boost takes it up to the limiter.
//
// P and D are solved per car (calibrate) so each car keeps the top speed and
// the 0-90% time its stats ask for, with the gear changes included.
import { clamp } from './util.js';

// idle/red: rpm. peak: r of peak power. width: how fast power falls away
// from the peak. lag: turbo lag (weak below ~half revs). shiftAt: best
// upshift point (r); perfect shifts land just under it. trim: power and drag
// scale for balance (engines that shift less, or never, lose less per corner).
export const ENGINES = {
  twin:   { idle: 1400, red: 11000, gears: 6, peak: 0.86, width: 2.0, shiftAt: 0.96 },
  i4:     { idle: 850,  red: 7000,  gears: 6, peak: 0.82, width: 1.8, shiftAt: 0.95 },
  turbo:  { idle: 900,  red: 7000,  gears: 6, peak: 0.76, width: 1.6, lag: 0.3, shiftAt: 0.9, trim: 1.12 },
  rotary: { idle: 1000, red: 9000,  gears: 6, peak: 0.9,  width: 1.8, shiftAt: 0.97 },
  diesel: { idle: 750,  red: 4600,  gears: 6, peak: 0.68, width: 2.6, shiftAt: 0.82, trim: 0.93 },
  v8:     { idle: 700,  red: 7200,  gears: 6, peak: 0.8,  width: 2.0, shiftAt: 0.93, trim: 1.06 },
  v12:    { idle: 900,  red: 8800,  gears: 7, peak: 0.86, width: 1.9, shiftAt: 0.96 },
  ev:     { idle: 0,    red: 16000, gears: 1, electric: true, trim: 0.94 },
};

export const GEARBOX = {
  topGear: 1.37,       // redline speed in top gear, x top speed (flat out cruises at r = 0.73)
  firstGear: 0.36,     // redline speed in 1st, x top speed
  spread: 0.85,        // < 1: ratios close up in the higher gears (1 = even steps)
  launchR: 0.42,       // clutch slips to hold the revs here when pulling away
  autoShift: 0.14,     // s, automatic upshift (torque fades out and back in)
  manualShift: 0.12,   // s, manual upshift
  perfectShift: 0.05,  // s, a perfect upshift is nearly seamless...
  perfectT: 0.8,       // ...and gives this long of
  perfectPow: 0.08,    // +8% power
  perfectWin: [-0.07, 0.03],   // perfect window around shiftAt (r)
  downShift: 0.12,     // s, downshift blip
  hold: 0.35,          // s, automatic waits this long between shifts
  gridRev: 0.75,       // launch control: how far you can rev on the grid
  grip: [6.5, 1.0],    // launch grip: a + b * acc stat (m/s^2)
  dragExp: 3,          // drag ~ v^3: air plus losses that build up toward top speed
};

const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Wheel power (normalised, 1 = peak) at engine speed r.
export function power(E, r) {
  if (E.electric) return Math.min(1, r / 0.3) * (1 - 0.35 * Math.max(0, r - 0.55));   // flat torque, then power fades at high speed
  let p = 1 - E.width * (r - E.peak) ** 2;
  if (E.lag) p *= 1 - E.lag * (1 - smooth(0.3, 0.62, r));
  return Math.max(0.05, p);
}
export const torque = (E, r) => { const rr = Math.max(r, 0.15); return power(E, rr) / rr; };

export function gearSpeeds(top, n) {
  const hi = top * GEARBOX.topGear, lo = top * GEARBOX.firstGear;
  if (n <= 1) return [hi];
  return Array.from({ length: n }, (_, i) => lo * Math.pow(hi / lo, Math.pow(i / (n - 1), GEARBOX.spread)));
}

const NO_SHIFT = { shiftUp: false, shiftDown: false };
export function initDrive(c) {
  c.gear = 1; c.rpm = 0.12; c.shiftT = 0; c.shiftDur = 1; c.shiftCD = 0; c.perfT = 0; c.limT = 0; c.lastShift = '';
}

function shift(c, D, to, dur, kind) {
  c.ev.push(kind);
  c.gear = to; c.shiftT = c.shiftDur = dur; c.shiftCD = GEARBOX.hold; c.lastShift = kind;
}

// One step of the engine and gearbox. Updates gear / rpm / shift state on the
// car and returns the drive acceleration (m/s^2, throttle already applied).
// v: forward speed. grounded: wheels on the road.
export function driveStep(c, D, v, thr, brk, dt, inp = NO_SHIFT, grounded = true) {
  const E = D.E, gv = D.gv, N = gv.length, G = GEARBOX;
  if (c.gear == null) initDrive(c);
  if (c.shiftT > 0) c.shiftT = Math.max(0, c.shiftT - dt);
  if (c.shiftCD > 0) c.shiftCD -= dt;
  if (c.perfT > 0) c.perfT -= dt;
  const sp = Math.abs(v);
  // nearly stopped (spun out, crashed): drop to 1st. Manual drivers get this too, like stalling-proof clutch work.
  if (c.gear > 1 && (c.manual ? sp < 1.5 : sp < 0.5 && thr === 0)) c.gear = 1;
  let g = Math.min(c.gear, N);
  let rW = sp / gv[g - 1];

  // ---- gear selection
  if (N > 1) {
    if (c.manual) {
      if (inp.shiftUp && g < N) {
        const lo = E.shiftAt + G.perfectWin[0], hi = E.shiftAt + G.perfectWin[1];
        if (c.rpm >= lo && c.rpm <= hi && thr > 0.5 && grounded) { shift(c, D, g + 1, G.perfectShift, 'perfect'); c.perfT = G.perfectT; }
        else shift(c, D, g + 1, G.manualShift, c.rpm < E.shiftAt - 0.25 ? 'early' : 'up');
      } else if (inp.shiftDown && g > 1) {
        if (sp / gv[g - 2] < 1.04) shift(c, D, g - 1, G.downShift, 'down');
        else c.ev.push('nodown');       // would blow the engine
      }
    } else if (c.shiftCD <= 0 && c.shiftT <= 0 && grounded) {
      // A sporty automatic: drops a gear for corners (braking or drifting) and
      // holds it through the bend, so the exit pulls from the meat of the power.
      const corner = brk > 0.2 || c.drift !== 0;
      const up = corner ? 0.99 : 0.58 + (E.shiftAt - 0.58) * thr;   // part throttle shifts early
      // near top speed there's little left to pull for: settle into the cruising gear
      const cruise = !corner && sp > D.top * 0.95 && g < N && sp / gv[g] > 0.62 && rW > 0.8;
      if (g < N && thr > 0.05 && (rW > up || cruise)) shift(c, D, g + 1, G.autoShift, 'up');
      else if (g > 1) {
        const low = corner ? 0.76 : thr > 0.7 ? 0.55 : 0.4;
        if (rW < low) {
          // straight to the right gear, however many that skips (hard braking)
          let to = g - 1;
          while (to > 1 && sp / gv[to - 1] < low && sp / gv[to - 2] < 0.93) to--;
          if (sp / gv[to - 1] < 0.93) { shift(c, D, to, G.downShift, 'down'); c.shiftCD = 0.15; }
        }
      }
    }
    g = c.gear; rW = sp / gv[g - 1];
  }

  // ---- engine speed. The clutch slips at launch; off the ground the engine revs freely.
  const idle = D.idleR;
  const slip = g === 1 && grounded && rW < G.launchR && thr > 0.05;
  let target;
  if (!grounded) target = Math.max(idle + ((c.gear === 1 && sp < 1 ? G.gridRev : 0.9) - idle) * thr, rW * 0.97);   // wheels keep spinning
  else if (slip) target = Math.max(rW, idle + (G.launchR - idle) * Math.min(1, thr * 1.5));
  else target = Math.max(rW, idle);
  if (c.drift && grounded) target = Math.min(1, target * 1.06 + 0.03);   // rear wheels spinning up
  let limit = false;
  if (target >= 1 && thr > 0.05) {          // bouncing off the rev limiter
    c.limT += dt; limit = true;
    target = Math.floor(c.limT * 16) % 2 ? 0.965 : 1.0;
  } else c.limT = 0;
  const rate = c.shiftT > 0 ? 26 : target > c.rpm ? (grounded && !slip ? 30 : 9) : grounded ? 12 : 4;
  c.rpm += (Math.min(1.0, target) - c.rpm) * Math.min(1, dt * rate);

  if (!grounded || thr <= 0) return 0;
  // ---- drive force
  const rE = slip ? Math.max(rW, c.rpm) : rW;
  let a = Math.min(D.grip * (c.tractMul ?? 1), D.P * torque(E, rE) / gv[g - 1]);   // rear tyres limit traction
  if (limit || rW >= 1) a = 0;
  if (c.shiftT > 0) a *= c.lastShift === 'down' ? 0.85 : 1 - c.shiftT / c.shiftDur;   // torque fades back in
  if (c.perfT > 0) a *= 1 + G.perfectPow;
  return a * thr;
}

export function dragAt(D, v) { return D.D * Math.pow(v, GEARBOX.dragExp); }

// Straight-line launch with the automatic box, flat out. Returns the speed at
// each step (or stops at `until`). Shared by calibration and the test bench.
export function launch(D, { dt = 1 / 120, tMax = 40, until = Infinity, onStep = null } = {}) {
  const c = { ev: [], manual: false };
  initDrive(c);
  let v = 0, t = 0;
  while (t < tMax && v < until) {
    const a = driveStep(c, D, v, 1, 0, dt);
    v = Math.max(0, v + (a - dragAt(D, v)) * dt);
    t += dt;
    if (onStep && onStep(t, v, c) === false) break;
    c.ev.length = 0;
  }
  return { t, v };
}

const cache = new Map();
// Solve P (power/mass) for the wanted 0 -> 90% top time; D follows from top speed.
export function makeDrivetrain(engine, top, t90, acc) {
  const key = `${engine}|${top.toFixed(3)}|${t90.toFixed(3)}|${acc.toFixed(3)}|${JSON.stringify(GEARBOX)}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const E = ENGINES[engine] || ENGINES.i4;
  const gv = gearSpeeds(top, E.gears);
  const D = { E, engine: engine in ENGINES ? engine : 'i4', gv, top, idleR: E.idle / E.red, grip: GEARBOX.grip[0] + GEARBOX.grip[1] * acc, P: 0, D: 0 };
  const rTop = top / gv[gv.length - 1];
  const setP = P => { D.P = P; D.D = P * torque(E, rTop) / gv[gv.length - 1] / Math.pow(top, GEARBOX.dragExp); };
  const timeFor = P => { setP(P); const r = launch(D, { until: top * 0.9, tMax: t90 * 3 }); return r.v >= top * 0.9 ? r.t : Infinity; };
  // Past a point more power only buys more drag against a grip-limited launch,
  // so walk up to the first power that is quick enough, then bisect.
  let lo = 10, hi = 0, best = Infinity, bestP = lo;
  for (let P = 20; P < 5000; P *= 1.3) {
    const t = timeFor(P);
    if (t <= t90) { hi = P; break; }
    if (t < best) { best = t; bestP = P; } else if (t > best * 1.05) break;
    lo = P;
  }
  if (hi) {
    for (let i = 0; i < 24; i++) { const mid = Math.sqrt(lo * hi); if (timeFor(mid) <= t90) hi = mid; else lo = mid; }
    setP(hi);
  } else setP(bestP);    // can't get there: as quick as grip allows
  if (E.trim) { D.P *= E.trim; D.D *= E.trim; }
  if (cache.size > 500) cache.clear();
  cache.set(key, D);
  return D;
}

export const gearLabel = (c, D) => (c.vf < -0.5 ? 'R' : D.gv.length === 1 ? 'D' : String(c.gear || 1));
export const rpmOf = (c, D) => Math.round(Math.max(D.E.idle, (c.rpm || 0) * D.E.red));
