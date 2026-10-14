// Pit lane and tyres. Pure (no DOM): physics, bots, the renderer and the
// validation script share it.
//
// The pit lane runs parallel to the track on one side of a calm straight
// (ideally the start straight), in the track's own (s, lateral) coordinates:
//
//   s0 ---- entry funnel ---- s1 ======= pit straight (limiter, boxes) ======= s2 ---- exit funnel ---- s3
//
// In the funnels the pit side of the track is open, so you simply steer off
// the racing line into the lane. Along the pit straight a pit wall separates
// the lane from the track. Positions are "side-relative": v = lateral * side,
// so the lane is always at positive v.
//
// The host plans the lane once and ships it inside the track data (data.pit),
// so every player drives the identical lane.
import { PHYS, SPEEDO } from './config.js';

export const PIT = {
  minTrack: 1500,             // m: shorter loops get no pit lane
  laneHW: 3.4,                // pit lane half width
  inner: 2.0,                 // lane inner edge, beyond the track edge (pit wall in between)
  funnel: 40,                 // entry / exit funnel length (m)
  straight: 104,              // pit straight length (m)
  boxLen: 30,                 // service area (three painted boxes) in the middle of the pit straight
  garage: [1.2, 9.5],         // garages behind the lane: from / to, beyond the lane's outer edge
  limitKmh: 120,              // speedometer km/h (80 km/h in world units, like F1)
  get limit() { return this.limitKmh / 3.6 / SPEEDO; },   // m/s
};

// ------------------------------------------------------------ tyres
export const TYRE = {
  // wear per second at full speed, per second of sliding / drifting / hard braking
  base: 0.0042, slide: 0.0056, drift: 0.0032, brake: 0.0037,
  cliff: 0.6,                 // past this the grip falls away quickly
  rates: { off: 0, normal: 1, high: 2 },
};
// Grip left on tyres with wear w (0 = new, 1 = finished).
export function tyreGrip(w) {
  return w <= TYRE.cliff ? 1 - 0.12 * w : 1 - 0.12 * TYRE.cliff - 0.7 * (w - TYRE.cliff);
}

// ------------------------------------------------------------ geometry
const smooth = t => t * t * (3 - 2 * t);
const rel = (track, s, from) => track.wrapS(s - from);       // distance driven from `from` to s

// Lane centre (side-relative) at a point of the pit zone; null outside it.
// region 1 = entry funnel, 2 = pit straight, 3 = exit funnel.
export function pitZone(track, pit, s, out = {}) {
  const d = rel(track, s, pit.s0), F = pit.funnel, total = 2 * F + pit.straight;
  if (d >= total) return null;
  const hw = track.halfW, D = hw + PIT.inner + PIT.laneHW, u0 = hw + 0.5 - PIT.laneHW;
  out.d = d;
  if (d < F) { out.region = 1; out.u = u0 + (D - u0) * smooth(d / F); }
  else if (d <= F + pit.straight) { out.region = 2; out.u = D; }
  else { out.region = 3; out.u = u0 + (D - u0) * smooth(1 - (d - F - pit.straight) / F); }
  out.box = out.region === 2 && Math.abs(d - F - pit.straight / 2) <= PIT.boxLen / 2;
  return out;
}

// Plan a pit lane for this track, or null when there's no room for one.
export function planPit(track) {
  if (track.L < PIT.minTrack) return null;
  const hw = track.halfW, F = PIT.funnel, S = PIT.straight, total = 2 * F + S;
  const D = hw + PIT.inner + PIT.laneHW, outer = D + PIT.laneHW, back = outer + PIT.garage[1];
  const step = 5;
  // candidates: every window, scored by how far the pit straight sits from the
  // start line and by how much the road bends there
  const cands = [];
  for (let c = 0; c < track.L; c += step) {
    const s0 = track.wrapS(c - total / 2);
    let maxK = 0, sumK = 0;
    for (let d = 0; d <= total; d += 4) { const k = track.curvAt(s0 + d); maxK = Math.max(maxK, Math.abs(k)); sumK += k; }
    if (maxK > 1 / 70) continue;
    const away = Math.min(c, track.L - c);
    for (const side of [1, -1]) {
      // the lane may sit on the inside of a gentle bend only if it can't fold over
      const inside = sumK * side > 0;
      if (inside && maxK * back > 0.3) continue;
      cands.push({ s0, side, score: away * 0.02 + maxK * 400 + (inside ? 2 : 0) });
    }
  }
  cands.sort((a, b) => a.score - b.score);
  for (const cand of cands.slice(0, 80)) {
    const pit = { side: cand.side, s0: Math.round(cand.s0 * 10) / 10, funnel: F, straight: S };
    if (checkPit(track, pit).ok) return pit;
  }
  return null;
}

// Validates a planned lane: nothing else of the track comes near the lane or
// the garages, and the lane's edges never fold. Returns { ok, issues }.
export function checkPit(track, pit) {
  const issues = [];
  const hw = track.halfW, z = {}, p = {};
  const total = 2 * pit.funnel + pit.straight;
  const own = 40 / track.step;      // the stretch of track the lane runs beside
  let prevO = null, prevI = null;
  for (let d = 0; d <= total; d += 2) {
    const s = pit.s0 + d;
    pitZone(track, pit, s, z);
    track.pointAt(s, p);
    const iCur = p.i, side = pit.side;
    const at = v => [p.x + p.nx * v * side, p.z + p.nz * v * side];
    const reach = z.region === 2 ? z.u + PIT.laneHW + PIT.garage[1] : z.u + PIT.laneHW + 1;
    // the rest of the track must stay clear of the lane, the wall and the garages
    for (const v of [z.u, z.u + PIT.laneHW, reach]) {
      const [x, zz] = at(v);
      let hit = false;
      track.near(x, zz, hw + 4, j => {
        let di = Math.abs(j - iCur); di = Math.min(di, track.n - di);
        if (di < own) return;
        if (Math.hypot(track.px[j] - x, track.pz[j] - zz) < hw + 3) hit = true;
      });
      if (hit) { issues.push({ code: 'clash', d, v }); break; }
    }
    // edges must advance along the road (no folding on the inside of a bend)
    const inner = at(z.u - PIT.laneHW), outerP = at(z.u + PIT.laneHW + (z.region === 2 ? PIT.garage[1] : 0));
    if (prevO) {
      const fwd = (a, b) => (b[0] - a[0]) * p.tx + (b[1] - a[1]) * p.tz;
      if (fwd(prevO, outerP) <= 0 || fwd(prevI, inner) <= 0) issues.push({ code: 'fold', d });
    }
    prevO = outerP; prevI = inner;
    if (issues.length > 3) break;
  }
  return { ok: issues.length === 0, issues };
}

// Allowed lateral range for a car at progress s (track lateral coordinates),
// and whether it's in the pit lane. Used by physics for walls and the limiter.
export function pitBounds(track, pit, s, lat, z = {}) {
  const limit = track.halfW + PHYS.curbW - PHYS.carHalfW;
  if (!pit || !pitZone(track, pit, s, z)) return null;
  const cw = PHYS.carHalfW, v = lat * pit.side, wallMid = track.halfW + PHYS.curbW + 0.25;
  let lo, hi, inPit;
  if (z.region === 2) {
    inPit = v > wallMid;
    if (inPit) { lo = z.u - PIT.laneHW + cw; hi = z.u + PIT.laneHW - cw; } else { lo = -limit; hi = limit; }
  } else {
    inPit = v > limit + 0.3;
    lo = -limit; hi = Math.max(limit, z.u + PIT.laneHW - cw);
  }
  z.inPit = inPit;
  z.lo = pit.side > 0 ? lo : -hi; z.hi = pit.side > 0 ? hi : -lo;
  return z;
}

// Where along the lane the pit boxes are (s of the box centre).
export const boxCentre = (track, pit) => track.wrapS(pit.s0 + pit.funnel + pit.straight / 2);
export const laneCentreLat = (track, pit, s) => { const z = pitZone(track, pit, s); return z ? z.u * pit.side : null; };
