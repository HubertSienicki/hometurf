// Track geometry: turns a closed route (e.g. a loop of real streets) into a
// smooth, raceable centerline, validates it, places features (item boxes,
// boost pads, jump ramps) and answers "where am I on the track?" queries.
//
// Coordinates are metres in the x/z plane (y is up). Lateral offsets are
// measured along the LEFT normal n = (tz, -tx) of the driving direction.
import { TRACK_LIMITS } from './config.js';
import { clamp, mulberry32, hashString, wrapAngle } from './util.js';
import { planPit, PIT } from './pit.js';

export const SPACING = 2;      // runtime sample spacing (m)
const STORE_SPACING = 3;       // spacing of the stored / transmitted centerline
const CELL = 16;               // spatial grid cell (m)

// ------------------------------------------------------------ polyline utils
const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

function distToSeg(p, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
}

export function dedupe(pts, minD = 0.5) {
  const out = [];
  for (const p of pts) if (!out.length || dist(out[out.length - 1], p) >= minD) out.push([p[0], p[1]]);
  while (out.length > 2 && dist(out[0], out[out.length - 1]) < minD) out.pop();
  return out;
}

export function polyLength(pts, closed = true) {
  let L = 0;
  for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) L += dist(pts[i], pts[(i + 1) % pts.length]);
  return L;
}

function dpOpen(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = distToSeg(pts[i], pts[a], pts[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

export function simplifyClosed(pts, tol) {
  if (pts.length < 4) return pts.slice();
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = dist(pts[0], pts[i]); if (d > fd) { fd = d; far = i; } }
  const a = dpOpen(pts.slice(0, far + 1), tol);
  const b = dpOpen(pts.slice(far).concat([pts[0]]), tol);
  return a.concat(b.slice(1, -1));
}

export function resampleClosed(pts, step) {
  const n0 = pts.length;
  const seg = new Float64Array(n0);
  let L = 0;
  for (let i = 0; i < n0; i++) { seg[i] = dist(pts[i], pts[(i + 1) % n0]); L += seg[i]; }
  const n = Math.max(8, Math.round(L / step));
  const st = L / n;
  const out = [];
  let i = 0, acc = 0;
  for (let k = 0; k < n; k++) {
    const target = k * st;
    while (i < n0 - 1 && acc + seg[i] < target) { acc += seg[i]; i++; }
    const a = pts[i], b = pts[(i + 1) % n0];
    const t = seg[i] > 1e-9 ? clamp((target - acc) / seg[i], 0, 1) : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

// Uniform Catmull-Rom through a closed polyline, then even resampling.
function splineResampleClosed(pts, step, sub = 5) {
  const n = pts.length, dense = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    for (let k = 0; k < sub; k++) {
      const t = k / sub, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      dense.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return resampleClosed(dense, step);
}

// Round every corner with a circular arc (radius limited by the neighbouring
// segment lengths), which keeps straight streets straight.
export function filletClosed(pts, R) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const l1 = dist(p0, p1), l2 = dist(p1, p2);
    if (l1 < 1e-6 || l2 < 1e-6) { out.push(p1); continue; }
    const d1 = [(p1[0] - p0[0]) / l1, (p1[1] - p0[1]) / l1], d2 = [(p2[0] - p1[0]) / l2, (p2[1] - p1[1]) / l2];
    const th = Math.acos(clamp(d1[0] * d2[0] + d1[1] * d2[1], -1, 1));
    if (th < 0.03) { out.push(p1); continue; }
    const tanH = Math.tan(Math.min(th, Math.PI - 0.02) / 2);
    let t = R * tanH;
    const tmax = 0.49 * Math.min(l1, l2);
    let r = R;
    if (t > tmax) { t = tmax; r = t / tanH; }
    const sgn = d1[0] * d2[1] - d1[1] * d2[0] > 0 ? 1 : -1;
    const a = [p1[0] - d1[0] * t, p1[1] - d1[1] * t];
    const perp = sgn > 0 ? [-d1[1], d1[0]] : [d1[1], -d1[0]];
    const c = [a[0] + perp[0] * r, a[1] + perp[1] * r];
    const steps = Math.max(2, Math.ceil(th * r / 2));
    const vx = a[0] - c[0], vz = a[1] - c[1];
    for (let k = 0; k <= steps; k++) {
      const ang = sgn * th * k / steps, cs = Math.cos(ang), sn = Math.sin(ang);
      out.push([c[0] + vx * cs - vz * sn, c[1] + vx * sn + vz * cs]);
    }
  }
  return dedupe(out, 0.3);
}

function radiusAt(pts, i, k) {
  const n = pts.length;
  const a = pts[(i - k + n) % n], b = pts[i], c = pts[(i + k) % n];
  const cr = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(cr) < 1e-9) return Infinity;
  return (dist(a, b) * dist(b, c) * dist(c, a)) / (2 * Math.abs(cr));
}

function smoothClosed(pts, passes, w = 0.5) {
  const n = pts.length;
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    const nx = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n], b = cur[i], c = cur[(i + 1) % n];
      nx[i] = [b[0] * (1 - w) + (a[0] + c[0]) * w / 2, b[1] * (1 - w) + (a[1] + c[1]) * w / 2];
    }
    cur = nx;
  }
  return cur;
}

// Locally relax corners tighter than rMin (keeps barriers from folding).
function relaxTight(pts, rMin, maxIter = 160) {
  const n = pts.length;
  for (let it = 0; it < maxIter; it++) {
    const bad = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (radiusAt(pts, i, 2) < rMin || radiusAt(pts, i, 4) < rMin) {
        any = true;
        for (let k = -4; k <= 4; k++) bad[(i + k + n) % n] = 1;
      }
    }
    if (!any) return pts;
    const nx = pts.map(p => p.slice());
    for (let i = 0; i < n; i++) {
      if (!bad[i]) continue;
      const a = pts[(i - 1 + n) % n], c = pts[(i + 1) % n];
      nx[i][0] = pts[i][0] * 0.5 + (a[0] + c[0]) * 0.25;
      nx[i][1] = pts[i][1] * 0.5 + (a[1] + c[1]) * 0.25;
    }
    pts = nx;
  }
  return pts;
}

// Raw route (closed, [[x,z],...]) -> smooth stored centerline ([[x,z],...] at 3 m).
export function buildCenterline(raw, width) {
  const hw = width / 2;
  let p = dedupe(raw, 0.8);
  if (p.length < 3 || polyLength(p) < 50) return null;
  p = simplifyClosed(p, 1.6);
  if (p.length < 3) return null;
  p = filletClosed(p, 26 + hw * 0.3);
  p = resampleClosed(p, STORE_SPACING);
  p = relaxTight(p, hw + 4.5);
  p = smoothClosed(p, 2, 0.4);
  return resampleClosed(p, STORE_SPACING);
}

export const flatten = pts => pts.flatMap(p => [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100]);
export const unflatten = f => { const o = []; for (let i = 0; i + 1 < f.length; i += 2) o.push([f[i], f[i + 1]]); return o; };

// ------------------------------------------------------------ runtime track
export class Track {
  constructor(data) {
    this.data = data;
    this.name = data.name || 'Track';
    this.width = data.width || 14;
    this.halfW = this.width / 2;
    const P = splineResampleClosed(unflatten(data.pts), SPACING);
    const n = this.n = P.length;
    this.px = new Float64Array(n); this.pz = new Float64Array(n);
    for (let i = 0; i < n; i++) { this.px[i] = P[i][0]; this.pz[i] = P[i][1]; }
    this.s = new Float64Array(n + 1);
    this.seg = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.seg[i] = Math.hypot(this.px[j] - this.px[i], this.pz[j] - this.pz[i]) || 1e-6;
      this.s[i + 1] = this.s[i] + this.seg[i];
    }
    this.L = this.s[n];
    this.step = this.L / n;
    // segment directions + smoothed per-sample tangents
    this.sx = new Float64Array(n); this.sz = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.sx[i] = (this.px[j] - this.px[i]) / this.seg[i];
      this.sz[i] = (this.pz[j] - this.pz[i]) / this.seg[i];
    }
    this.tx = new Float64Array(n); this.tz = new Float64Array(n);
    this.nx = new Float64Array(n); this.nz = new Float64Array(n);
    this.ang = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      let dx = this.px[b] - this.px[a], dz = this.pz[b] - this.pz[a];
      const l = Math.hypot(dx, dz) || 1;
      dx /= l; dz /= l;
      this.tx[i] = dx; this.tz[i] = dz;
      this.nx[i] = dz; this.nz[i] = -dx;
      this.ang[i] = Math.atan2(dx, dz);
    }
    // signed curvature (+ = left turn), lightly smoothed
    const k0 = new Float64Array(n);
    const K = 3;
    for (let i = 0; i < n; i++) {
      const a = (i - K + n) % n, b = (i + K) % n;
      k0[i] = wrapAngle(this.ang[b] - this.ang[a]) / (2 * K * this.step);
    }
    this.k = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let d = -3; d <= 3; d++) sum += k0[(i + d + n) % n];
      this.k[i] = sum / 7;
    }
    // spatial grid over segments
    this.grid = new Map();
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = Math.floor(Math.min(this.px[i], this.px[j]) / CELL), x1 = Math.floor(Math.max(this.px[i], this.px[j]) / CELL);
      const z0 = Math.floor(Math.min(this.pz[i], this.pz[j]) / CELL), z1 = Math.floor(Math.max(this.pz[i], this.pz[j]) / CELL);
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const key = gx * 73856093 ^ gz * 19349663;
        let arr = this.grid.get(key);
        if (!arr) this.grid.set(key, arr = []);
        arr.push(i);
      }
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.px[i]); maxX = Math.max(maxX, this.px[i]);
      minZ = Math.min(minZ, this.pz[i]); maxZ = Math.max(maxZ, this.pz[i]);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
    this.feats = data.feats || { boxes: [], pads: [], ramps: [] };
    if (!this.feats.sectors) this.feats.sectors = [this.L / 3, (2 * this.L) / 3];
    this.sectors = this.feats.sectors;
    this._tmp = {};
  }

  // Pit lane (sim/pit.js): the host's plan travels with the track; otherwise it's
  // planned here on first use (the Track Studio builds many throwaway tracks).
  get pit() {
    if (this._pit === undefined) this._pit = this.data.pit !== undefined ? this.data.pit : planPit(this);
    return this._pit;
  }

  wrapI(i) { const n = this.n; return ((i % n) + n) % n; }
  wrapS(s) { const L = this.L; return ((s % L) + L) % L; }

  _segProject(i, x, z, out) {
    const ax = this.px[i], az = this.pz[i];
    const dx = this.sx[i], dz = this.sz[i], len = this.seg[i];
    let t = (x - ax) * dx + (z - az) * dz;
    t = clamp(t, 0, len);
    const qx = ax + dx * t, qz = az + dz * t;
    const ex = x - qx, ez = z - qz;
    const d2 = ex * ex + ez * ez;
    if (d2 < out.d2) {
      out.d2 = d2; out.i = i; out.t = t;
      out.lat = ex * dz - ez * dx;   // projection on the left normal (dz, -dx)
    }
  }

  // Nearest point on the centerline, searching around a hint index so that
  // crossings (figure-8s) never make a car jump to the other branch.
  project(x, z, hint = -1, out = {}) {
    out.d2 = Infinity; out.i = 0; out.t = 0; out.lat = 0;
    if (hint >= 0) {
      const W = 26;
      for (let k = -W; k <= W; k++) this._segProject(this.wrapI(hint + k), x, z, out);
      if (out.d2 > (this.halfW * 3) ** 2) return this.projectGlobal(x, z, out);
    } else return this.projectGlobal(x, z, out);
    out.s = this.s[out.i] + out.t;
    out.d = Math.sqrt(out.d2);
    return out;
  }

  projectGlobal(x, z, out = {}) {
    out.d2 = Infinity; out.i = 0; out.t = 0; out.lat = 0;
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    for (let r = 1; r <= 6 && out.d2 === Infinity; r += 2) {
      for (let ix = gx - r; ix <= gx + r; ix++) for (let iz = gz - r; iz <= gz + r; iz++) {
        const arr = this.grid.get(ix * 73856093 ^ iz * 19349663);
        if (arr) for (const i of arr) this._segProject(i, x, z, out);
      }
    }
    if (out.d2 === Infinity) for (let i = 0; i < this.n; i++) this._segProject(i, x, z, out);
    out.s = this.s[out.i] + out.t;
    out.d = Math.sqrt(out.d2);
    return out;
  }

  // Samples whose segments touch a box around (x, z); used for overlap tests.
  near(x, z, r, cb) {
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) {
      const arr = this.grid.get(ix * 73856093 ^ iz * 19349663);
      if (arr) for (const i of arr) cb(i);
    }
  }

  indexAt(s) {
    s = this.wrapS(s);
    let i = Math.min(this.n - 1, Math.floor(s / this.step));
    while (i < this.n - 1 && this.s[i + 1] <= s) i++;
    while (i > 0 && this.s[i] > s) i--;
    return i;
  }

  pointAt(s, out = {}) {
    s = this.wrapS(s);
    const i = this.indexAt(s), j = (i + 1) % this.n;
    const t = (s - this.s[i]) / this.seg[i];
    out.i = i;
    out.x = this.px[i] + (this.px[j] - this.px[i]) * t;
    out.z = this.pz[i] + (this.pz[j] - this.pz[i]) * t;
    let tx = this.tx[i] + (this.tx[j] - this.tx[i]) * t, tz = this.tz[i] + (this.tz[j] - this.tz[i]) * t;
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l; out.tz = tz / l;
    out.nx = out.tz; out.nz = -out.tx;
    out.h = Math.atan2(out.tx, out.tz);
    return out;
  }

  curvAt(s) {
    s = this.wrapS(s);
    const i = this.indexAt(s), j = (i + 1) % this.n;
    const t = (s - this.s[i]) / this.seg[i];
    return this.k[i] + (this.k[j] - this.k[i]) * t;
  }

  // Timing boundaries passed by progress P (start line + 2 sector splits per lap).
  // Increments by one at every boundary, so a change means a split was crossed.
  boundaryIndex(P) {
    const lap = Math.floor(P / this.L), pos = P - lap * this.L;
    return lap * 3 + (pos >= this.sectors[0] ? 1 : 0) + (pos >= this.sectors[1] ? 1 : 0);
  }

  // Grid slot k (0 = pole). Cars line up behind the start line, staggered.
  gridSlot(k) {
    const row = Math.floor(k / 2), side = k % 2 === 0 ? 1 : -1;
    const back = 8 + row * 8.5 + (k % 2) * 4;
    const p = this.pointAt(this.L - back);
    const lat = side * Math.min(this.halfW * 0.42, 3.4);
    return { x: p.x + p.nx * lat, z: p.z + p.nz * lat, h: p.h, P: -back, i: p.i };
  }
}

// ------------------------------------------------------------ validation
// Returns { ok, length, issues: [{level:'error'|'warn'|'info', code, msg, x, z}], crossings }
export function analyzeTrack(track) {
  const issues = [];
  const L = track.L, hw = track.halfW, n = track.n;
  const add = (level, code, msg, x, z) => issues.push({ level, code, msg, x, z });
  if (L < TRACK_LIMITS.minLen) add('error', 'short', `Loop is only ${Math.round(L)} m - it needs at least ${TRACK_LIMITS.minLen} m.`);
  if (L > TRACK_LIMITS.maxLen) add('error', 'long', `Loop is ${(L / 1000).toFixed(1)} km - keep it under ${TRACK_LIMITS.maxLen / 1000} km.`);

  // corners that are still too tight after smoothing
  const tight = [];
  for (let i = 0; i < n; i++) if (Math.abs(track.k[i]) > 1 / (hw + 2.5)) tight.push(i);
  for (const p of cluster(tight.map(i => [track.px[i], track.pz[i]]), 25)) add('error', 'tight', 'Hairpin too tight to drive - move a waypoint so the route does not double back.', p[0], p[1]);

  // the track running on top of / alongside itself
  const sep = 2 * hw + 2;
  const minGap = Math.ceil((2 * sep + 30) / track.step);
  const overlaps = [], crossPts = [];
  for (let i = 0; i < n; i += 2) {
    const x = track.px[i], z = track.pz[i];
    let worst = 0, cross = false;
    track.near(x, z, sep, j => {
      let di = Math.abs(i - j); di = Math.min(di, n - di);
      if (di < minGap) return;
      const d = Math.hypot(track.px[j] - x, track.pz[j] - z);
      if (d > sep) return;
      const dot = Math.abs(track.tx[i] * track.tx[j] + track.tz[i] * track.tz[j]);
      if (dot > 0.75) worst = Math.max(worst, dot); else if (d < hw) cross = true;
    });
    if (worst) overlaps.push([x, z]);
    else if (cross) crossPts.push([x, z]);
  }
  for (const p of cluster(overlaps, 40)) add('error', 'overlap', 'Track runs on top of itself here (same street twice, or two lanes of a dual carriageway).', p[0], p[1]);
  const crossings = Math.round(cluster(crossPts, 30).length / 2);
  if (crossings) add('info', 'cross', `${crossings} crossing${crossings > 1 ? 's' : ''} - figure-8 action, watch for side impacts!`);
  if (L >= PIT.minTrack) add('info', 'pit', track.pit ? 'Pit lane on the main straight - pit-stop races available.' : 'No calm straight with room beside it for a pit lane - no pit-stop races here.');
  return { ok: !issues.some(i => i.level === 'error'), length: L, issues, crossings };
}

function cluster(pts, r) {
  const out = [];
  for (const p of pts) if (!out.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < r)) out.push(p);
  return out;
}

// ------------------------------------------------------------ features
function straights(track, maxK) {
  const n = track.n, flat = i => Math.abs(track.k[i]) < maxK;
  let start = 0;
  while (start < n && flat(start)) start++;
  if (start === n) return [{ s0: 0, len: track.L }];
  const runs = [];
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (flat(i)) {
      const r = runs[runs.length - 1];
      if (r && r.open) r.len += track.seg[i];
      else runs.push({ s0: track.s[i], len: track.seg[i], open: true });
    } else if (runs.length) runs[runs.length - 1].open = false;
  }
  return runs.map(r => ({ s0: r.s0, len: r.len }));
}

export function chooseStart(track) {
  const runs = straights(track, 1 / 140).sort((a, b) => b.len - a.len);
  if (!runs.length || runs[0].len < 40) {
    let best = 0;
    for (let i = 0; i < track.n; i++) if (Math.abs(track.k[i]) < Math.abs(track.k[best])) best = i;
    return track.s[best];
  }
  const r = runs[0];
  return track.wrapS(r.s0 + Math.min(r.len * 0.62, 110));
}

export function placeFeatures(track, seed) {
  const rng = mulberry32(seed);
  const L = track.L, hw = track.halfW;
  const taken = [];
  const free = (s, gap) => taken.every(t => { const d = Math.abs(track.wrapS(s - t + L / 2) - L / 2); return d > gap; });
  const flatness = s => { let m = 0; for (let d = -12; d <= 12; d += 4) m = Math.max(m, Math.abs(track.curvAt(s + d))); return m; };

  const boxes = [];
  const rows = clamp(Math.round(L / 320), 2, 10);
  const lanes = hw >= 8.5 ? [-0.66, -0.33, 0, 0.33, 0.66] : [-0.6, -0.2, 0.2, 0.6];
  for (let r = 0; r < rows; r++) {
    const s0 = ((r + 0.4) / rows) * L;
    let best = s0, bv = Infinity;
    for (let d = -40; d <= 40; d += 4) { const v = flatness(s0 + d); if (v < bv) { bv = v; best = s0 + d; } }
    best = track.wrapS(best);
    if (best > L - 25) continue;
    taken.push(best);
    for (const f of lanes) boxes.push([Math.round(best * 10) / 10, Math.round(f * hw * 100) / 100]);
  }

  const runs = straights(track, 1 / 150).filter(r => r.len >= 70).sort(() => rng() - 0.5);
  const pads = [];
  for (const r of runs) {
    if (pads.length >= 3) break;
    const s = track.wrapS(r.s0 + 14 + rng() * Math.min(20, r.len - 50));
    if (s < 70 || s > L - 30 || !free(s, 35)) continue;
    taken.push(s);
    pads.push([Math.round(s * 10) / 10, Math.round((rng() < 0.5 ? -1 : 1) * hw * (0.35 + rng() * 0.2) * 100) / 100]);
  }

  const ramps = [];
  for (const r of runs.filter(q => q.len >= 140).sort((a, b) => b.len - a.len)) {
    if (ramps.length >= 2) break;
    const s = track.wrapS(r.s0 + r.len * 0.5);
    if (s < 140 || s > L - 60 || !free(s, 50)) continue;
    taken.push(s);
    ramps.push(Math.round(s * 10) / 10);
  }
  // three timing sectors, split near the thirds on a calm bit of road
  const sectors = [1 / 3, 2 / 3].map(f => {
    let best = f * L, bv = Infinity;
    for (let d = -0.07 * L; d <= 0.07 * L; d += 6) { const v = flatness(f * L + d); if (v < bv - 1e-4) { bv = v; best = f * L + d; } }
    return Math.round(best * 10) / 10;
  });
  return { boxes, pads, ramps, sectors };
}

// Full pipeline: centerline -> start line at index 0 -> features -> data.
export function finalizeTrack({ name, width, center, scen = null, origin = null, author = '', extra = {} }) {
  let t = new Track({ width, pts: flatten(center) });
  const startS = chooseStart(t);
  const sp = t.pointAt(startS);
  let k0 = 0, bd = Infinity;
  center.forEach((p, i) => { const d = Math.hypot(p[0] - sp.x, p[1] - sp.z); if (d < bd) { bd = d; k0 = i; } });
  const rotated = center.slice(k0).concat(center.slice(0, k0));
  const pts = flatten(rotated);
  const id = (hashString(pts.join(',') + name) >>> 0).toString(36);
  t = new Track({ width, pts });
  const feats = placeFeatures(t, hashString(id));
  return { v: 1, id, name, width, pts, feats, scen, origin, author, len: Math.round(t.L), created: Date.now(), ...extra };
}
