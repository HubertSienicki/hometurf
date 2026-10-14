// OpenStreetMap access: Overpass (streets + scenery), Nominatim (search),
// a street graph with A* routing for the Track Studio, and conversion of
// buildings / parks / water / trees into track scenery.
// Public, keyless Overpass mirrors. They are often busy, so requests are
// hedged: start with the first, add the next mirror whenever one fails or
// stays silent for a few seconds, and keep whichever answers first.
const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const HEDGE_MS = 4000;

export function overpass(query, { timeout = 60000, onStatus } = {}) {
  return new Promise((resolve, reject) => {
    let next = 0, active = 0, done = false, lastErr = null, hedge = null;
    const ctrls = new Set();
    const launch = () => {
      clearTimeout(hedge);
      if (done || next >= OVERPASS.length) return;
      const url = OVERPASS[next++];
      if (next > 1) onStatus?.(`The map server is busy - asking mirror ${next} of ${OVERPASS.length} too...`);
      active++;
      const ctrl = new AbortController();
      ctrls.add(ctrl);
      const kill = setTimeout(() => ctrl.abort(), timeout);
      fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctrl.signal })
        .then(async res => {
          if (!res.ok) throw new Error(res.status === 429 ? 'too many requests' : `map server answered ${res.status}`);
          const json = await res.json();
          if (done) return;
          done = true;
          clearTimeout(hedge);
          for (const c of ctrls) if (c !== ctrl) c.abort();
          resolve(json);
        })
        .catch(err => {
          if (done) return;
          if (err.name !== 'AbortError') lastErr = err;
          active--;
          if (next < OVERPASS.length) launch();
          else if (active === 0) reject(new Error(`Could not load map data (${lastErr?.message || 'all map servers are busy'}). Try again in a minute.`));
        })
        .finally(() => { clearTimeout(kill); ctrls.delete(ctrl); });
      if (next < OVERPASS.length) hedge = setTimeout(launch, HEDGE_MS);
    };
    launch();
  });
}

export async function geocode(q) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`, { headers: { 'Accept-Language': navigator.language || 'en' } });
  if (!res.ok) throw new Error('Search failed');
  return (await res.json()).map(r => ({ lat: +r.lat, lon: +r.lon, name: r.display_name, bbox: r.boundingbox?.map(Number) }));
}

// Local equirectangular projection in metres. z points south (north = -z).
export class Proj {
  constructor(lat0, lon0) { this.lat0 = lat0; this.lon0 = lon0; this.kx = Math.cos(lat0 * Math.PI / 180) * 111320; this.kz = 110574; }
  xz(lat, lon) { return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * this.kz]; }
  ll(x, z) { return [this.lat0 - z / this.kz, this.lon0 + x / this.kx]; }
}

const CAR = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'pedestrian', 'track', 'busway'];
const PATHS = ['footway', 'path', 'cycleway', 'bridleway'];
const SKIP_SERVICE = new Set(['parking_aisle', 'driveway', 'drive-through', 'emergency_access']);

export const ekey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);

// ------------------------------------------------------------ street graph
export async function loadStreets(b, includePaths, onStatus) {
  const types = CAR.concat(includePaths ? PATHS : []).join('|');
  const q = `[out:json][timeout:40];way["highway"~"^(${types})$"](${b.s},${b.w},${b.n},${b.e});out geom;`;
  const data = await overpass(q, { onStatus });
  const proj = new Proj((b.s + b.n) / 2, (b.w + b.e) / 2);
  const nodes = new Map(), ways = [];
  const node = (id, lat, lon) => {
    let n = nodes.get(id);
    if (!n) { const [x, z] = proj.xz(lat, lon); n = { id, lat, lon, x, z, adj: [] }; nodes.set(id, n); }
    return n;
  };
  for (const el of data.elements || []) {
    if (el.type !== 'way' || !el.geometry || !el.nodes) continue;
    const t = el.tags || {};
    if (t.area === 'yes' || SKIP_SERVICE.has(t.service)) continue;
    if ((t.access === 'private' || t.access === 'no') && !['primary', 'secondary', 'tertiary'].includes(t.highway)) continue;
    const path = PATHS.includes(t.highway) || t.highway === 'track' || t.highway === 'pedestrian';
    const ns = el.nodes.map((id, k) => node(id, el.geometry[k].lat, el.geometry[k].lon));
    for (let k = 0; k + 1 < ns.length; k++) {
      const a = ns[k], c = ns[k + 1], len = Math.hypot(c.x - a.x, c.z - a.z);
      if (len < 0.01) continue;
      a.adj.push({ to: c.id, len, way: el.id, path });
      c.adj.push({ to: a.id, len, way: el.id, path });
    }
    ways.push({ id: el.id, kind: t.highway, name: t.name || t.ref || '', ll: el.geometry.map(g => [g.lat, g.lon]), path });
  }
  // Streets cut off at the edge of the loaded box form little islands; mark
  // the largest connected network so waypoints snap onto it.
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
  return { nodes, ways, proj, bbox: b, wayById: new Map(ways.map(w => [w.id, w])) };
}

// Nearest street node, preferring the main connected network.
export function nearestNode(g, lat, lon, maxD = 70) {
  const [x, z] = g.proj.xz(lat, lon);
  let best = null, bd = maxD, any = null, ad = maxD;
  for (const n of g.nodes.values()) {
    if (!n.adj.length) continue;
    const d = Math.hypot(n.x - x, n.z - z);
    if (n.main && d < bd) { bd = d; best = n; }
    if (d < ad) { ad = d; any = n; }
  }
  return best || any;
}

class Heap {
  constructor() { this.a = []; }
  push(v, p) { const a = this.a; a.push([p, v]); let i = a.length - 1; while (i) { const j = (i - 1) >> 1; if (a[j][0] <= a[i][0]) break; [a[i], a[j]] = [a[j], a[i]]; i = j; } }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } }
    return top[1];
  }
  get size() { return this.a.length; }
}

// A* from node a to node b. `used` = Set of edge keys already on the course:
// they cost 8x so the router prefers fresh streets (no out-and-back).
export function route(g, a, b, used, pathPenalty = 1.25) {
  if (a === b) return [a];
  const goal = g.nodes.get(b), start = g.nodes.get(a);
  if (!goal || !start) return null;
  const gS = new Map([[a, 0]]), prev = new Map(), open = new Heap(), closed = new Set();
  const h = n => Math.hypot(n.x - goal.x, n.z - goal.z);
  open.push(a, h(start));
  let guard = 0;
  while (open.size && guard++ < 200000) {
    const cur = open.pop();
    if (cur === b) break;
    if (closed.has(cur)) continue;
    closed.add(cur);
    const n = g.nodes.get(cur), base = gS.get(cur);
    for (const e of n.adj) {
      if (closed.has(e.to)) continue;
      let cost = e.len * (used.has(ekey(cur, e.to)) ? 8 : 1) * (e.path ? pathPenalty : 1);
      const ng = base + cost;
      if (ng < (gS.get(e.to) ?? Infinity)) { gS.set(e.to, ng); prev.set(e.to, cur); open.push(e.to, ng + h(g.nodes.get(e.to))); }
    }
  }
  if (!prev.has(b)) return null;
  const out = [b];
  let c = b;
  while (c !== a) { c = prev.get(c); out.push(c); }
  return out.reverse();
}

// ------------------------------------------------------------ scenery
const ROAD_W = { motorway: 14, trunk: 12, primary: 11, secondary: 10, tertiary: 9, residential: 7.5, unclassified: 7.5, living_street: 6, service: 5, road: 7, pedestrian: 6, track: 3.5, footway: 2.5, path: 2.2, cycleway: 2.5, busway: 7 };
const HOUSES = new Set(['house', 'detached', 'semidetached_house', 'bungalow', 'terrace', 'farm', 'cabin', 'static_caravan']);
const FLATS = new Set(['apartments', 'residential', 'dormitory', 'flats']);
const SHOPS = new Set(['commercial', 'retail', 'office', 'hotel', 'supermarket', 'kiosk', 'mall']);
const WORKS = new Set(['industrial', 'warehouse', 'factory', 'manufacture', 'hangar', 'storage_tank']);
const CIVIC = new Set(['church', 'cathedral', 'chapel', 'mosque', 'synagogue', 'temple', 'school', 'university', 'college', 'hospital', 'public', 'government', 'civic', 'train_station', 'transportation', 'stadium', 'sports_hall', 'museum']);
const SHEDS = new Set(['garage', 'garages', 'shed', 'carport', 'roof', 'hut', 'service', 'greenhouse']);

function heightOf(t, id) {
  const r = ((id * 2654435761) % 1000) / 1000;
  const h = parseFloat(String(t.height || '').replace(',', '.'));
  if (h > 1 && h < 400) return [h, null];
  const lv = parseFloat(t['building:levels']);
  const b = t.building;
  let type = 1;
  if (HOUSES.has(b)) type = 0; else if (FLATS.has(b)) type = 1; else if (SHOPS.has(b)) type = 2;
  else if (WORKS.has(b)) type = 3; else if (CIVIC.has(b)) type = 4; else if (SHEDS.has(b)) type = 5; else if (t.shop || t.amenity) type = 2;
  if (lv > 0 && lv < 120) return [lv * 3.1 + 1.5 + (t['roof:levels'] ? 1.5 : 0), type];
  const base = [7 + r * 2.5, 12 + r * 9, 11 + r * 14, 8 + r * 4, 14 + r * 8, 3.2 + r][type];
  return [base, type];
}

// Fetches everything around a finished route and returns compact scenery.
export async function loadScenery(track, proj, onStatus) {
  const b = track.bounds, M = 260;
  const [n, w] = proj.ll(b.minX - M, b.minZ - M), [s, e] = proj.ll(b.maxX + M, b.maxZ + M);
  const bb = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:90];(
    way["building"](${bb});
    way["highway"](${bb});
    way["leisure"~"^(park|garden|pitch|playground|golf_course|recreation_ground|common|dog_park|nature_reserve)$"](${bb});
    way["landuse"~"^(grass|forest|meadow|recreation_ground|village_green|cemetery|orchard|allotments|flowerbed)$"](${bb});
    way["natural"~"^(water|wood|scrub|grassland|heath)$"](${bb});
    way["water"](${bb});
    way["waterway"="riverbank"](${bb});
    node["natural"="tree"](${bb});
  );out geom;`;
  onStatus?.('Downloading buildings, parks and trees...');
  const data = await overpass(q, { onStatus, timeout: 90000 });
  onStatus?.('Placing the city around your track...');
  const hw = track.halfW, tmp = {};
  const near = (x, z) => track.projectGlobal(x, z, tmp).d;
  const R = v => Math.round(v * 10) / 10;
  const scen = { b: [], r: [], g: [], w: [], t: [] };
  const buildings = [];
  for (const el of data.elements || []) {
    if (el.type === 'node' && el.tags?.natural === 'tree') {
      const [x, z] = proj.xz(el.lat, el.lon);
      if (near(x, z) < 300) scen.t.push(R(x), R(z));
      continue;
    }
    if (el.type !== 'way' || !el.geometry) continue;
    const t = el.tags || {};
    const pts = el.geometry.map(g => proj.xz(g.lat, g.lon));
    if (t.building && t.building !== 'no') {
      if (pts.length < 4) continue;
      if (t.layer && +t.layer < 0) continue;
      const ring = pts.slice(0, -1);
      let cx = 0, cz = 0; for (const p of ring) { cx += p[0]; cz += p[1]; } cx /= ring.length; cz /= ring.length;
      const dc = near(cx, cz);
      if (dc > 280) continue;
      if (ring.some(p => near(p[0], p[1]) < hw + 3.5)) continue;
      const [h, type] = heightOf(t, el.id);
      const rec = [R(h), type ?? 1];
      for (const p of ring) rec.push(R(p[0]), R(p[1]));
      buildings.push([dc, rec]);
    } else if (t.highway) {
      const wd = ROAD_W[t.highway];
      if (!wd || t.area === 'yes') continue;
      if (!pts.some(p => near(p[0], p[1]) < 320)) continue;
      const rec = [wd];
      for (const p of pts) rec.push(R(p[0]), R(p[1]));
      scen.r.push(rec);
    } else if (t.natural === 'water' || t.water || t.waterway === 'riverbank') {
      if (pts.length < 4) continue;
      scen.w.push(pts.slice(0, -1).flatMap(p => [R(p[0]), R(p[1])]));
    } else if (t.leisure || t.landuse || t.natural) {
      if (pts.length < 4) continue;
      const ring = pts.slice(0, -1);
      scen.g.push(ring.flatMap(p => [R(p[0]), R(p[1])]));
      // sprinkle trees in woods / parks
      const woody = t.natural === 'wood' || t.landuse === 'forest' || t.leisure === 'park' || t.landuse === 'orchard';
      if (woody) {
        let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
        for (const p of ring) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
        const area = (maxX - minX) * (maxZ - minZ), cnt = Math.min(80, area / (t.leisure === 'park' ? 500 : 160));
        for (let i = 0; i < cnt; i++) {
          const x = minX + Math.random() * (maxX - minX), z = minZ + Math.random() * (maxZ - minZ);
          if (inPoly(ring, x, z) && near(x, z) < 300 && near(x, z) > hw + 4) scen.t.push(R(x), R(z));
        }
      }
    }
  }
  buildings.sort((a, b2) => a[0] - b2[0]);
  scen.b = buildings.slice(0, 3500).map(b2 => b2[1]);
  if (scen.t.length > 3000) scen.t.length = 3000;
  return scen;
}

function inPoly(ring, x, z) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
