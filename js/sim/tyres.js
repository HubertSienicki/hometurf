// Tyres for pit-stop races: four compounds, and per-tyre temperature and wear.
// Pure (no DOM): physics, bots, the strategy simulation and the HUD share it.
//
// Each tyre (0 FL, 1 FR, 2 RL, 3 RR) heats up from rolling, cornering load,
// sliding, braking (fronts) and traction (rears), and cools toward the air,
// faster at speed. A right turn loads the left-hand (outer) tyres, so they heat
// and wear more, and they decide the grip in that turn. Drifting cooks the rears.
// Wear grows with the work a tyre does, and much faster once it runs hotter than
// its compound's window. Grip falls with wear (sharply past the cliff) and
// outside the temperature window (cold or overheated).
//
// Outside pit-stop races none of this runs and every grip is exactly 1.
import { clamp } from './util.js';

// grip: peak grip (x); wear: wear rate (x); opt: temperature window (deg C); warm: heating rate (x)
export const COMPOUNDS = {
  US: { name: 'Ultrasoft', color: '#b04bff', grip: 1.24,  wear: 1.75, opt: [72, 106],  warm: 1.6 },
  S:  { name: 'Soft',      color: '#ff3b3b', grip: 1.15,  wear: 1.35, opt: [80, 110],  warm: 1.3 },
  M:  { name: 'Medium',    color: '#ffd23f', grip: 1.075, wear: 1.0,  opt: [86, 114],  warm: 1.0 },
  H:  { name: 'Hard',      color: '#f1f1f1', grip: 1.0,   wear: 0.6,  opt: [94, 120],  warm: 0.75 },
};
export const COMPOUND_IDS = ['US', 'S', 'M', 'H'];

export const TYRE = {
  ambient: 28,            // air / track temperature
  blanket: 72,            // fresh tyres come off the warmers at this temperature
  cliff: 0.6,             // past this wear the grip falls away quickly
  rates: { normal: 1, high: 2 },
  // heating, deg C per second (straights settle near 78, a lap averages ~95 front / ~105 rear)
  roll: 5.5,              // at 30 m/s
  corner: 1.3,            // per 10 m/s^2 of cornering, on a fully loaded tyre
  slide: 0.8,             // per m/s of sideways slide
  drift: 3,               // drifting: rears, at 30 m/s
  brake: 6,               // full braking at 30 m/s: fronts
  drive: 3,               // traction at full throttle: rears
  cool: 0.11,             // per deg above ambient, at speed
  // wear per second for a Medium at normal rate, per unit of "work"
  wearBase: 0.0026,
};

const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];
export { WHEEL_NAMES };

export function fitTyres(c, cmp, temp = TYRE.blanket) {
  c.cmp = COMPOUNDS[cmp] ? cmp : 'M';
  c.tw = [0, 0, 0, 0];
  c.tt = [temp, temp, temp, temp];
  c.tyre = 0;
  c.gripF = c.gripR = c.gripMul = 1;
  c.tractMul = 1;
}

// Grip of one tyre: compound x wear x temperature.
export function tyreGrip(cmp, w, T) {
  const C = COMPOUNDS[cmp] || COMPOUNDS.M, [lo, hi] = C.opt;
  const wear = w <= TYRE.cliff ? 1 - 0.1 * w : 1 - 0.1 * TYRE.cliff - 0.8 * (w - TYRE.cliff);
  const temp = T < lo ? 1 - 0.16 * Math.min(1, (lo - T) / 45) : T > hi ? Math.max(0.78, 1 - 0.011 * (T - hi)) : 1;
  return C.grip * wear * temp;
}

// How fast a tyre wears at temperature T, relative to inside its window.
export function heatWear(cmp, T) {
  const [lo, hi] = (COMPOUNDS[cmp] || COMPOUNDS.M).opt;
  if (T <= hi) return 0.75 + 0.25 * clamp((T - lo) / (hi - lo), 0, 1);
  const x = (T - hi) / 20;
  return 1 + 1.2 * x * x;
}

// One step. yaw: turn rate (+ = right), vf / vl: forward / sideways speed,
// engine: drive acceleration, rate: wear multiplier for the race.
export function tyreStep(c, dt, { vf, vl, yaw, brk, thr, engine, onGround, rate }) {
  if (!c.tw) fitTyres(c, c.cmp || 'M');
  const C = COMPOUNDS[c.cmp] || COMPOUNDS.M, T = TYRE;
  const v = Math.abs(vf), sv = Math.min(1.3, v / 30), slide = Math.abs(vl);
  const lat = v * Math.abs(yaw);                        // cornering, m/s^2
  const outer = 0.5 + 0.38 * clamp(lat / 12, 0, 1);    // load on the outside tyres
  const rightTurn = yaw > 0;                            // outer = left side (0, 2)
  const drifting = c.drift !== 0;
  const driftOuterLeft = c.drift > 0;
  for (let i = 0; i < 4; i++) {
    const front = i < 2, left = i % 2 === 0;
    const share = (rightTurn === left ? outer : 1 - outer) * 2;           // 0..~1.76
    let heat = 0, work = 0;
    if (onGround) {
      heat += T.roll * sv;
      heat += T.corner * (lat / 10) * share * (front ? 1.05 : 0.95);
      heat += T.slide * slide * (front ? 0.8 : 1.25);
      if (drifting && !front) heat += T.drift * sv * (left === driftOuterLeft ? 1.3 : 0.7);
      if (front) heat += T.brake * brk * sv;
      else heat += T.drive * thr * clamp(engine / 8, 0, 1);
      work = 0.35 * sv + 0.12 * (lat / 10) * share + 0.18 * slide * (front ? 0.8 : 1.3)
        + (drifting && !front ? 0.5 * sv : 0) + (front ? 0.45 * brk * sv : 0.25 * thr * clamp(engine / 8, 0, 1));
    }
    const Ti = c.tt[i];
    c.tt[i] = Ti + dt * C.warm * (heat - T.cool * (Ti - T.ambient) * (0.3 + 0.7 * sv));   // softer: quicker to warm (and cool)
    if (rate > 0) c.tw[i] = Math.min(1, c.tw[i] + dt * rate * T.wearBase * C.wear * work * heatWear(c.cmp, c.tt[i]));
  }
  updateGrip(c, yaw);
}

// Axle grips as the physics uses them: in a turn the loaded (outer) tyres count most.
export function updateGrip(c, yaw = 0) {
  const g = [0, 1, 2, 3].map(i => tyreGrip(c.cmp, c.tw[i], c.tt[i]));
  const lat = Math.abs(yaw) > 0.05;
  const wOut = lat ? 0.68 : 0.5, rightTurn = yaw > 0;
  const axle = (a, b) => (rightTurn ? g[a] * wOut + g[b] * (1 - wOut) : g[b] * wOut + g[a] * (1 - wOut));   // a = left tyre
  c.gripF = axle(0, 1);
  c.gripR = axle(2, 3);
  c.gripMul = Math.min(c.gripF, c.gripR);
  c.tractMul = (g[2] + g[3]) / 2;
  c.tyre = (c.tw[0] + c.tw[1] + c.tw[2] + c.tw[3]) / 4;
}

export const tyreColor = (cmp, T) => {
  const [lo, hi] = (COMPOUNDS[cmp] || COMPOUNDS.M).opt;
  if (T < lo - 18) return '#3f8cff';
  if (T < lo) return '#45c8ff';
  if (T <= hi) return '#3ddc84';
  if (T <= hi + 12) return '#ffb02e';
  return '#ff4a3a';
};
