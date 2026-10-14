// Built-in tracks in a procedurally generated city. They work offline and
// keep the main menu alive; real-world tracks come from the Track Studio.
import { buildCenterline, finalizeTrack, Track } from './track.js';
import { mulberry32, hashString, clamp } from './util.js';

const superShape = (n, fn) => Array.from({ length: n }, (_, i) => fn((i / n) * Math.PI * 2));

export const PRESETS = [
  {
    key: 'downtown', name: 'Downtown Dash', style: 'downtown', width: 14,
    blurb: 'Right-angle corners between the towers. Drift or die.',
    pts: [[0, 0], [420, 0], [420, -180], [260, -180], [260, -340], [-60, -340], [-60, -100], [0, -100]],
  },
  {
    key: 'eight', name: 'Figure Eight Heights', style: 'mixed', width: 14,
    blurb: 'A figure-8 with a crossroads in the middle. Look both ways.',
    pts: [[0, 0], [320, 0], [320, 210], [160, 210], [160, -210], [0, -210]],
  },
  {
    key: 'harbor', name: 'Harbor Run', style: 'harbor', width: 15,
    blurb: 'A flat-out waterfront blast, then a twisty climb through the docks.',
    pts: [[-320, 0], [320, 0], [385, -45], [400, -125], [360, -200], [210, -215], [205, -320], [40, -320], [0, -255], [-60, -200], [-220, -210], [-340, -150], [-385, -70]],
  },
  {
    key: 'suburb', name: 'Maple Lane Loop', style: 'suburb', width: 14,
    blurb: 'Fast, flowing curves past lawns and cul-de-sacs.',
    pts: superShape(56, a => {
      const r = 360 + 55 * Math.sin(3 * a) + 28 * Math.sin(5 * a + 1);
      return [Math.cos(a) * r * 1.15, Math.sin(a) * r * 0.78];
    }),
  },
];

const cache = new Map();
export function buildPreset(key) {
  if (cache.has(key)) return cache.get(key);
  const p = PRESETS.find(q => q.key === key) || PRESETS[0];
  const center = buildCenterline(p.pts, p.width);
  const base = finalizeTrack({ name: p.name, width: p.width, center, author: 'HOME TURF', extra: { preset: p.key, style: p.style } });
  base.scen = genScenery(new Track(base), p.style, hashString(p.key));
  base.id = 'preset-' + p.key;
  cache.set(key, base);
  return base;
}

// ------------------------------------------------------------ procedural city
// Building type ids: 0 house, 1 apartments, 2 office/commercial, 3 industrial, 4 civic, 5 shed
export function genScenery(track, style, seed) {
  const rng = mulberry32(seed);
  const hw = track.halfW;
  const b = track.bounds, M = 200;
  const minX = b.minX - M, maxX = b.maxX + M, minZ = b.minZ - M, maxZ = b.maxZ + M;
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const scen = { b: [], r: [], g: [], w: [], t: [] };
  const tmp = {};
  const trackDist = (x, z) => track.projectGlobal(x, z, tmp).d;

  // water for the harbor: everything "south" of the waterfront straight
  let waterZ = Infinity;
  if (style === 'harbor') {
    waterZ = b.maxZ + 28;
    scen.w.push([minX - 600, waterZ, maxX + 600, waterZ, maxX + 600, waterZ + 900, minX - 600, waterZ + 900]);
  }

  // side streets branching off the course every so often
  const roads = [];
  for (let s = 40; s < track.L - 40; s += 90 + rng() * 80) {
    const p = track.pointAt(s);
    if (Math.abs(track.curvAt(s)) > 1 / 200) continue;
    const side = rng() < 0.5 ? 1 : -1;
    const x0 = p.x + p.nx * side * (hw + 1), z0 = p.z + p.nz * side * (hw + 1);
    const len = 120 + rng() * 120;
    const x1 = x0 + p.nx * side * len, z1 = z0 + p.nz * side * len;
    if (z1 > waterZ - 10 || z0 > waterZ - 10) continue;
    // stop the road where it would hit the course again
    let ok = true;
    for (let t = 20; t <= len; t += 10) {
      if (trackDist(x0 + p.nx * side * t, z0 + p.nz * side * t) < hw + 10) { ok = false; break; }
    }
    if (!ok) continue;
    roads.push([x0, z0, x1, z1]);
    scen.r.push([9, round(x0), round(z0), round(x1), round(z1)]);
  }
  const roadDist = (x, z) => {
    let m = Infinity;
    for (const [x0, z0, x1, z1] of roads) {
      const dx = x1 - x0, dz = z1 - z0, l2 = dx * dx + dz * dz;
      const t = clamp(((x - x0) * dx + (z - z0) * dz) / l2, 0, 1);
      m = Math.min(m, Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t)));
    }
    return m;
  };

  // parks: a couple of round-ish green blobs
  const parks = [];
  const nParks = style === 'suburb' ? 5 : style === 'downtown' ? 2 : 3;
  for (let i = 0; i < nParks * 6 && parks.length < nParks; i++) {
    const x = minX + rng() * (maxX - minX), z = minZ + rng() * (maxZ - minZ);
    const r = 35 + rng() * 45;
    if (z + r > waterZ - 5) continue;
    if (trackDist(x, z) < r + hw + 8) continue;
    if (parks.some(p => Math.hypot(p[0] - x, p[1] - z) < p[2] + r + 20)) continue;
    parks.push([x, z, r]);
    const poly = [];
    for (let k = 0; k < 14; k++) {
      const a = (k / 14) * Math.PI * 2, rr = r * (0.85 + rng() * 0.25);
      poly.push(round(x + Math.cos(a) * rr), round(z + Math.sin(a) * rr));
    }
    scen.g.push(poly);
    for (let k = 0; k < r / 3; k++) {
      const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * r * 0.8;
      scen.t.push(round(x + Math.cos(a) * rr), round(z + Math.sin(a) * rr));
    }
  }
  const inPark = (x, z, pad = 0) => parks.some(p => Math.hypot(p[0] - x, p[1] - z) < p[2] + pad);

  // street trees along the course
  for (let s = 0; s < track.L; s += 14) {
    if (rng() < (style === 'downtown' ? 0.35 : 0.6)) {
      const p = track.pointAt(s), side = rng() < 0.5 ? 1 : -1, off = hw + 5.5 + rng() * 1.5;
      const x = p.x + p.nx * side * off, z = p.z + p.nz * side * off;
      if (trackDist(x, z) > hw + 4.5 && z < waterZ - 4) scen.t.push(round(x), round(z));
    }
  }

  // building lots
  const lot = style === 'suburb' ? 26 : style === 'downtown' ? 24 : 28;
  for (let x = minX; x < maxX; x += lot) {
    for (let z = minZ; z < maxZ; z += lot) {
      const px = x + (rng() - 0.5) * lot * 0.3, pz = z + (rng() - 0.5) * lot * 0.3;
      if (pz > waterZ - 20) continue;
      const pr = track.projectGlobal(px, pz, tmp);
      const d = pr.d;
      if (d < hw + 12 || roadDist(px, pz) < 13 || inPark(px, pz, 6)) continue;
      if (rng() < (style === 'suburb' ? 0.25 : 0.1)) continue;
      // orientation: face the course when close to it
      let ang = 0;
      if (d < 90) ang = Math.atan2(track.sx[pr.i], track.sz[pr.i]);
      else ang = Math.round(rng() * 2) * Math.PI / 2 + (rng() - 0.5) * 0.1;
      let type, w, dp, h;
      const centerF = 1 - clamp(Math.hypot(px - cx, pz - cz) / 500, 0, 1);
      if (style === 'downtown') {
        type = rng() < 0.75 ? 2 : 1;
        w = 14 + rng() * 8; dp = 14 + rng() * 8;
        h = 14 + rng() * 30 + centerF * centerF * 70 * rng();
      } else if (style === 'suburb') {
        type = rng() < 0.85 ? 0 : 5;
        w = 9 + rng() * 5; dp = 8 + rng() * 4;
        h = type === 0 ? 6 + rng() * 3 : 3.5;
      } else if (style === 'harbor') {
        const nearWater = pz > waterZ - 160;
        type = nearWater ? (rng() < 0.7 ? 3 : 2) : (rng() < 0.5 ? 1 : 2);
        w = nearWater ? 18 + rng() * 8 : 12 + rng() * 8; dp = nearWater ? 16 + rng() * 8 : 12 + rng() * 8;
        h = nearWater ? 8 + rng() * 6 : 12 + rng() * 22;
      } else {
        const r = rng();
        type = r < 0.35 ? 0 : r < 0.7 ? 1 : r < 0.92 ? 2 : 4;
        w = 11 + rng() * 9; dp = 10 + rng() * 9;
        h = type === 0 ? 7 + rng() * 3 : type === 1 ? 12 + rng() * 14 : type === 2 ? 14 + rng() * 26 : 12 + rng() * 8;
      }
      w = Math.min(w, lot - 3); dp = Math.min(dp, lot - 3);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const corners = [[-w / 2, -dp / 2], [w / 2, -dp / 2], [w / 2, dp / 2], [-w / 2, dp / 2]].map(([u, v]) => [px + u * ca + v * sa, pz - u * sa + v * ca]);
      if (corners.some(([qx, qz]) => trackDist(qx, qz) < hw + 9 || roadDist(qx, qz) < 7 || qz > waterZ - 6)) continue;
      const rec = [Math.round(h * 10) / 10, type];
      for (const [qx, qz] of corners) rec.push(round(qx), round(qz));
      scen.b.push(rec);
    }
  }
  return scen;
}
const round = v => Math.round(v * 10) / 10;
