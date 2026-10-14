// OpenFreeMap vector tiles (OpenMapTiles schema, no API key, CDN-served) as
// the fast primary source of streets and scenery. Includes a tiny Mapbox
// Vector Tile decoder, a street-graph builder that welds roads across tile
// borders and heals T-junctions, and building / park / water extraction.
import { Proj } from './osm.js';

const Z = 14;               // OpenMapTiles' most detailed zoom
const TILEJSON = 'https://tiles.openfreemap.org/planet';
let tileUrlP = null;
const tileCache = new Map();   // "z/x/y" -> Promise<layers>

// ------------------------------------------------------------ MVT decoding
class Reader {
  constructor(buf) { this.b = new Uint8Array(buf); this.dv = new DataView(buf); this.p = 0; }
  varint() {
    let v = 0, s = 1, b;
    do { b = this.b[this.p++]; v += (b & 0x7f) * s; s *= 128; } while (b & 0x80);
    return v;
  }
  skip(t) {
    if (t === 0) this.varint();
    else if (t === 1) this.p += 8;
    else if (t === 2) this.p += this.varint();
    else if (t === 5) this.p += 4;
  }
  str(len) { const s = TD.decode(this.b.subarray(this.p, this.p + len)); this.p += len; return s; }
}
const TD = new TextDecoder();
const zz = n => (n % 2 ? -(n + 1) / 2 : n / 2);
const WANT = new Set(['transportation', 'transportation_name', 'building', 'landcover', 'landuse', 'park', 'water']);

function decodeTile(buf) {
  const r = new Reader(buf), layers = {};
  while (r.p < r.b.length) {
    const tag = r.varint();
    if (tag >> 3 === 3 && (tag & 7) === 2) {
      const len = r.varint(), end = r.p + len;
      const L = decodeLayer(r, end);
      if (L) layers[L.name] = L;
      r.p = end;
    } else r.skip(tag & 7);
  }
  return layers;
}

function decodeLayer(r, end) {
  let name = '', extent = 4096;
  const keys = [], vals = [], feats = [];
  while (r.p < end) {
    const tag = r.varint(), f = tag >> 3, t = tag & 7;
    if (f === 1 && t === 2) { name = r.str(r.varint()); if (!WANT.has(name)) return null; }
    else if (f === 2 && t === 2) { const len = r.varint(); feats.push([r.p, r.p + len]); r.p += len; }
    else if (f === 3 && t === 2) keys.push(r.str(r.varint()));
    else if (f === 4 && t === 2) {
      const len = r.varint(), e = r.p + len;
      let v = null;
      while (r.p < e) {
        const tg = r.varint(), ff = tg >> 3;
        if (ff === 1) v = r.str(r.varint());
        else if (ff === 2) { v = r.dv.getFloat32(r.p, true); r.p += 4; }
        else if (ff === 3) { v = r.dv.getFloat64(r.p, true); r.p += 8; }
        else if (ff === 4 || ff === 5) v = r.varint();
        else if (ff === 6) v = zz(r.varint());
        else if (ff === 7) v = !!r.varint();
        else r.skip(tg & 7);
      }
      vals.push(v);
    } else if (f === 5 && t === 0) extent = r.varint();
    else r.skip(t);
  }
  const features = feats.map(([s, e]) => decodeFeature(r, s, e, keys, vals));
  return { name, extent, features };
}

function decodeFeature(r, s, e, keys, vals) {
  r.p = s;
  const props = {};
  let type = 0, geom = null;
  while (r.p < e) {
    const tag = r.varint(), f = tag >> 3, t = tag & 7;
    if (f === 2 && t === 2) { const end = r.p + r.varint(); while (r.p < end) { const k = r.varint(), v = r.varint(); props[keys[k]] = vals[v]; } }
    else if (f === 3) type = r.varint();
    else if (f === 4 && t === 2) {
      const end = r.p + r.varint();
      geom = [];
      let x = 0, y = 0, cur = null;
      while (r.p < end) {
        const ci = r.varint(), cmd = ci & 7, cnt = ci >> 3;
        if (cmd === 7) { if (cur && cur.length) cur.push(cur[0]); continue; }
        for (let i = 0; i < cnt; i++) {
          x += zz(r.varint()); y += zz(r.varint());
          if (cmd === 1) { cur = [[x, y]]; geom.push(cur); } else cur.push([x, y]);
        }
      }
    } else r.skip(t);
  }
  return { type, props, geom };
}

// ------------------------------------------------------------ tiles
async function tileUrl() {
  if (!tileUrlP) tileUrlP = fetch(TILEJSON).then(r => { if (!r.ok) throw new Error(`tile index ${r.status}`); return r.json(); }).then(j => j.tiles[0]);
  try { return await tileUrlP; } catch (err) { tileUrlP = null; throw err; }
}
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };

export function tilesFor(b, z = Z) {
  const out = [];
  for (let x = lon2x(b.w, z); x <= lon2x(b.e, z); x++) for (let y = lat2y(b.n, z); y <= lat2y(b.s, z); y++) out.push([z, x, y]);
  return out;
}

export function getTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    const p = tileUrl()
      .then(u => fetch(u.replace('{z}', z).replace('{x}', x).replace('{y}', y)))
      .then(r => { if (!r.ok) throw new Error(`map tiles answered ${r.status}`); return r.arrayBuffer(); })
      .then(buf => ({ z, x, y, layers: decodeTile(buf) }));
    p.catch(() => tileCache.delete(key));
    tileCache.set(key, p);
  }
  return tileCache.get(key);
}

// tile-local coords -> [lat, lon]
function toLL(t, ext, px, py) {
  const n = 2 ** t.z;
  const lon = (t.x + px / ext) / n * 360 - 180;
  const yy = Math.PI * (1 - 2 * (t.y + py / ext) / n);
  return [Math.atan(Math.sinh(yy)) * 180 / Math.PI, lon];
}

// ------------------------------------------------------------ street graph
const ROAD = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'busway', 'raceway', 'track', 'path']);
const PATHY = new Set(['path', 'track']);
const SKIP_SERVICE = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access']);

export async function loadStreetsVT(b, includePaths, proj = null) {
  const tiles = await Promise.all(tilesFor(b).map(([z, x, y]) => getTile(z, x, y)));
  proj = proj || new Proj((b.s + b.n) / 2, (b.w + b.e) / 2);
  const nodes = new Map(), ways = [], names = [];
  // weld vertices within 0.9 m (roads are cut at tile edges with a buffer)
  const grid = new Map(), CELL = 2;
  const gkey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
  let seq = 0;
  const vertex = (lat, lon) => {
    const [x, z] = proj.xz(lat, lon);
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    for (let i = gx - 1; i <= gx + 1; i++) for (let j = gz - 1; j <= gz + 1; j++) {
      const arr = grid.get(`${i},${j}`);
      if (arr) for (const n of arr) if (Math.hypot(n.x - x, n.z - z) < 0.9) return n;
    }
    const n = { id: `v${seq++}`, lat, lon, x, z, adj: [] };
    nodes.set(n.id, n);
    const k = gkey(x, z);
    (grid.get(k) || grid.set(k, []).get(k)).push(n);
    return n;
  };
  const edges = new Set();
  let wid = 0;
  const link = (a, c, way, path, deck = 0) => {
    if (a === c) return;
    const k = a.id < c.id ? `${a.id}|${c.id}` : `${c.id}|${a.id}`;
    if (edges.has(k)) return;
    edges.add(k);
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    a.adj.push({ to: c.id, len, way, path, deck });
    c.adj.push({ to: a.id, len, way, path, deck });
  };
  for (const t of tiles) {
    const L = t.layers.transportation;
    if (L) for (const f of L.features) {
      const p = f.props;
      if (f.type !== 2 || !ROAD.has(p.class)) continue;
      if (p.subclass === 'steps' || SKIP_SERVICE.has(p.service) || (p.access === 'no' && !['primary', 'secondary', 'tertiary'].includes(p.class))) continue;
      const path = PATHY.has(p.class) || p.subclass === 'pedestrian';
      if (path && !includePaths && p.subclass !== 'pedestrian') continue;
      for (const line of f.geom) {
        const ll = line.map(([px, py]) => toLL(t, L.extent, px, py));
        const id = wid++;
        const vs = ll.map(q => vertex(q[0], q[1]));
        // bridges / tunnels / other layers never join the streets they pass over
        const deck = p.brunnel === 'bridge' || p.brunnel === 'tunnel' ? 1 + (p.layer | 0) * 2 + (p.brunnel === 'tunnel' ? 1 : 0) : (p.layer | 0) * 2;
        for (let k = 0; k + 1 < vs.length; k++) link(vs[k], vs[k + 1], id, path, deck);
        ways.push({ id, kind: p.class, name: '', ll, path });
      }
    }
    const N = t.layers.transportation_name;
    if (N) for (const f of N.features) {
      if (f.type !== 2 || !f.props.name) continue;
      for (const line of f.geom) names.push({ name: f.props.name, pts: line.map(([px, py]) => proj.xz(...toLL(t, N.extent, px, py))) });
    }
  }
  healJunctions(nodes, link, vertex);
  // name each way after the closest named line
  for (const w of ways) {
    const mid = w.ll[Math.floor(w.ll.length / 2)];
    const [x, z] = proj.xz(mid[0], mid[1]);
    let best = null, bd = 18;
    for (const nm of names) for (let i = 0; i + 1 < nm.pts.length; i++) {
      const d = segDist(x, z, nm.pts[i], nm.pts[i + 1]);
      if (d < bd) { bd = d; best = nm.name; }
    }
    w.name = best || '';
  }
  markMain(nodes);
  return { nodes, ways, proj, bbox: b, wayById: new Map(ways.map(w => [w.id, w])), source: 'tiles' };
}

function segDist(x, z, a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2)) : 0;
  return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);
}

// Vector tiles simplify straight roads, which can delete the node where two
// streets meet. Dead ends that stop on another road get spliced into it, and
// streets that cross without a shared node get a junction at the crossing.
function healJunctions(nodes, link, vertex) {
  const CELL = 8, grid = new Map();
  const segs = [];
  for (const n of nodes.values()) for (const e of n.adj) if (n.id < e.to) segs.push([n, nodes.get(e.to), e]);
  segs.forEach((s, i) => {
    const [a, b] = s;
    for (let gx = Math.floor(Math.min(a.x, b.x) / CELL); gx <= Math.floor(Math.max(a.x, b.x) / CELL); gx++)
      for (let gz = Math.floor(Math.min(a.z, b.z) / CELL); gz <= Math.floor(Math.max(a.z, b.z) / CELL); gz++) {
        const k = `${gx},${gz}`;
        (grid.get(k) || grid.set(k, []).get(k)).push(i);
      }
  });
  for (const n of nodes.values()) {
    if (n.adj.length !== 1) continue;
    let best = null, bd = 1.6;
    const gx = Math.floor(n.x / CELL), gz = Math.floor(n.z / CELL);
    for (let i = gx - 1; i <= gx + 1; i++) for (let j = gz - 1; j <= gz + 1; j++) for (const si of grid.get(`${i},${j}`) || []) {
      const [a, b] = segs[si];
      if (a === n || b === n || n.adj[0].to === a.id || n.adj[0].to === b.id) continue;
      const d = segDist(n.x, n.z, [a.x, a.z], [b.x, b.z]);
      if (d < bd) { bd = d; best = segs[si]; }
    }
    if (best) { link(n, best[0], best[2].way, best[2].path, best[2].deck); link(n, best[1], best[2].way, best[2].path, best[2].deck); }
  }
  const tested = new Set();
  for (const arr of grid.values()) for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
    const p = arr[i], q = arr[j], key = p < q ? `${p}|${q}` : `${q}|${p}`;
    if (tested.has(key)) continue;
    tested.add(key);
    const [a, b, ea] = segs[p], [c, d, eb] = segs[q];
    if (a === c || a === d || b === c || b === d || ea.deck !== eb.deck) continue;
    const r1 = b.x - a.x, r2 = b.z - a.z, s1 = d.x - c.x, s2 = d.z - c.z, den = r1 * s2 - r2 * s1;
    if (Math.abs(den) < 1e-9) continue;
    const t = ((c.x - a.x) * s2 - (c.z - a.z) * s1) / den, u = ((c.x - a.x) * r2 - (c.z - a.z) * r1) / den;
    if (t <= 0.005 || t >= 0.995 || u <= 0.005 || u >= 0.995) continue;
    const x = vertex(a.lat + (b.lat - a.lat) * t, a.lon + (b.lon - a.lon) * t);
    for (const [m, e] of [[a, ea], [b, ea], [c, eb], [d, eb]]) link(x, m, e.way, e.path, e.deck);
  }
}

function markMain(nodes) {
  let comp = 0, bestComp = -1, bestSize = 0;
  for (const n of nodes.values()) {
    if (n.comp != null || !n.adj.length) continue;
    const stack = [n];
    n.comp = comp;
    let size = 0;
    while (stack.length) {
      const c = stack.pop();
      size++;
      for (const e of c.adj) { const m = nodes.get(e.to); if (m.comp == null) { m.comp = comp; stack.push(m); } }
    }
    if (size > bestSize) { bestSize = size; bestComp = comp; }
    comp++;
  }
  for (const n of nodes.values()) n.main = n.comp === bestComp;
}

// ------------------------------------------------------------ scenery
const ROAD_W = { motorway: 14, trunk: 12, primary: 11, secondary: 10, tertiary: 9, minor: 7.5, service: 5, busway: 7, raceway: 12, track: 3.5, path: 2.3 };
const GREEN_LC = new Set(['grass', 'wood']);
const GREEN_LU = new Set(['cemetery', 'pitch', 'playground', 'stadium', 'park', 'garden', 'recreation_ground', 'zoo']);

function ringArea(r) { let a = 0; for (let i = 0; i + 1 < r.length; i++) a += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1]; return a / 2; }
function inPoly(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

export async function loadSceneryVT(track, proj, onStatus) {
  const bb = track.bounds, M = 260;
  const [n, w] = proj.ll(bb.minX - M, bb.minZ - M), [s, e] = proj.ll(bb.maxX + M, bb.maxZ + M);
  onStatus?.('Downloading buildings, parks and water...');
  const tiles = await Promise.all(tilesFor({ s, w, n, e }).map(([z, x, y]) => getTile(z, x, y)));
  onStatus?.('Placing the city around your track...');
  const hw = track.halfW, tmp = {};
  const near = (x, z) => track.projectGlobal(x, z, tmp).d;
  const R = v => Math.round(v * 10) / 10;
  const scen = { b: [], r: [], g: [], w: [], t: [] };
  const seen = new Set(), buildings = [];
  const rings = (t, L, f) => f.geom.map(r => r.map(([px, py]) => proj.xz(...toLL(t, L.extent, px, py))));
  for (const t of tiles) {
    const B = t.layers.building;
    if (B) for (const f of B.features) {
      if (f.type !== 3 || f.props.hide_3d) continue;
      for (const r0 of f.geom) {
        if (ringArea(r0) <= 0 || r0.length < 4) continue;     // skip courtyards / holes
        const ring = r0.slice(0, -1).map(([px, py]) => proj.xz(...toLL(t, B.extent, px, py)));
        let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; } cx /= ring.length; cz /= ring.length;
        const key = `${Math.round(cx)},${Math.round(cz)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const dc = near(cx, cz);
        if (dc > 280 || ring.some(p => near(p[0], p[1]) < hw + 3.5)) continue;
        const h = f.props.render_height || 8 + ((ring.length * 7919) % 5);
        const type = h < 10 ? 0 : h < 22 ? 1 : 2;
        const rec = [R(Math.min(h, 300)), type];
        for (const p of ring) rec.push(R(p[0]), R(p[1]));
        buildings.push([dc, rec]);
      }
    }
    const T = t.layers.transportation;
    if (T) for (const f of T.features) {
      const wd = ROAD_W[f.props.class];
      if (f.type !== 2 || !wd || f.props.brunnel === 'tunnel') continue;
      for (const line of rings(t, T, f)) {
        if (!line.some(p => near(p[0], p[1]) < 320)) continue;
        scen.r.push([wd, ...line.flatMap(p => [R(p[0]), R(p[1])])]);
      }
    }
    const greens = [];
    for (const [lname, test] of [['landcover', p => GREEN_LC.has(p.class)], ['landuse', p => GREEN_LU.has(p.class)], ['park', () => true]]) {
      const Lr = t.layers[lname];
      if (Lr) for (const f of Lr.features) if (f.type === 3 && test(f.props)) for (const r of rings(t, Lr, f)) if (ringArea(r) > 0) greens.push([r, f.props.class === 'wood' || f.props.subclass === 'park' || lname === 'park']);
    }
    for (const [r, woody] of greens) {
      if (!r.some(p => near(p[0], p[1]) < 400)) continue;
      scen.g.push(r.slice(0, -1).flatMap(p => [R(p[0]), R(p[1])]));
      if (!woody) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of r) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); z0 = Math.min(z0, p[1]); z1 = Math.max(z1, p[1]); }
      const cnt = Math.min(90, (x1 - x0) * (z1 - z0) / 350);
      for (let i = 0; i < cnt; i++) {
        const x = x0 + Math.random() * (x1 - x0), z = z0 + Math.random() * (z1 - z0);
        if (inPoly(r, x, z)) { const d = near(x, z); if (d < 300 && d > hw + 4) scen.t.push(R(x), R(z)); }
      }
    }
    const W = t.layers.water;
    if (W) for (const f of W.features) if (f.type === 3) for (const r of rings(t, W, f)) {
      if (ringArea(r) <= 0 || !r.some(p => near(p[0], p[1]) < 800)) continue;
      scen.w.push(r.slice(0, -1).flatMap(p => [R(p[0]), R(p[1])]));
    }
  }
  // a few street trees along the course
  for (let s2 = 0; s2 < track.L; s2 += 16) {
    if (Math.random() < 0.45) {
      const p = track.pointAt(s2), side = Math.random() < 0.5 ? 1 : -1, off = hw + 5.5 + Math.random() * 1.5;
      const x = p.x + p.nx * side * off, z = p.z + p.nz * side * off;
      if (near(x, z) > hw + 4.5 && !buildings.some(b2 => b2[0] < 60 && inPoly(pairs(b2[1]), x, z))) scen.t.push(R(x), R(z));
    }
  }
  buildings.sort((a, b2) => a[0] - b2[0]);
  scen.b = buildings.slice(0, 3500).map(b2 => b2[1]);
  if (scen.t.length > 3000) scen.t.length = 3000;
  return scen;
}
function pairs(rec) { const o = []; for (let i = 2; i + 1 < rec.length; i += 2) o.push([rec[i], rec[i + 1]]); return o; }
