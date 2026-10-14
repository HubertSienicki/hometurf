// Track Studio: pick streets on a real map. Waypoints snap to the street
// graph, legs are routed with A* (preferring streets not used yet), the loop
// is validated live, and "Build" fetches the buildings around it.
import { loadStreets, nearestNode, route, ekey, geocode, loadScenery, Proj } from '../osm.js';
import { loadStreetsVT, loadSceneryVT } from '../vtiles.js';
import { buildCenterline, finalizeTrack, Track, analyzeTrack } from '../sim/track.js';
import { genScenery } from '../sim/presets.js';
import { TRACK_LIMITS } from '../sim/config.js';
import { escapeHtml, wrapAngle } from '../sim/util.js';

const $ = id => document.getElementById(id);
let leafletP = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletP) return leafletP;
  leafletP = new Promise((res, rej) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    s.onload = () => res(window.L);
    s.onerror = () => rej(new Error('Could not load the map library - check your connection.'));
    document.head.appendChild(s);
  });
  return leafletP;
}
const VIEW_KEY = 'hometurf.studio.view';
function areaKm2(b) {
  const p = new Proj((b.s + b.n) / 2, (b.w + b.e) / 2);
  const [x0, z0] = p.xz(b.n, b.w), [x1, z1] = p.xz(b.s, b.e);
  return Math.abs((x1 - x0) * (z1 - z0)) / 1e6;
}

export class Studio {
  constructor({ toast, profile, store, onBuilt }) {
    this.toast = toast; this.profile = profile; this.store = store; this.onBuilt = onBuilt;
    this.map = null; this.graph = null;
    this.wps = [];          // { node, lat, lon, marker }
    this.legs = [];         // [{ ll: [[lat,lon]...], nodes, ok }]
    this.result = null;
    this.busy = false;
    this.bind();
  }

  bind() {
    $('st-search').addEventListener('submit', e => { e.preventDefault(); this.search($('st-q').value); });
    $('st-snap').addEventListener('change', () => this.recompute());
    $('st-paths').addEventListener('change', () => { if (this.graph) { this.graph = null; this.loadRoads(); } });
    $('st-width').addEventListener('change', () => this.validate());
    document.querySelector('#s-studio').addEventListener('click', e => {
      const a = e.target.closest('[data-act]')?.dataset.act;
      if (!a) return;
      if (a === 'loadroads') this.loadRoads();
      else if (a === 'undo') { const w = this.wps.pop(); if (w) this.map.removeLayer(w.marker); this.recompute(); }
      else if (a === 'clear') this.clear();
      else if (a === 'reverse') { if (this.wps.length > 2) { const [first, ...rest] = this.wps; this.wps = [first, ...rest.reverse()]; this.recompute(); } }
      else if (a === 'locate') this.locate();
      else if (a === 'surprise') this.surprise();
      else if (a === 'build') this.build();
    });
  }

  async open() {
    const L = await loadLeaflet();
    if (!this.map) {
      let v = null;
      try { v = JSON.parse(localStorage.getItem(VIEW_KEY)); } catch { v = null; }
      this.map = L.map('st-map', { zoomControl: true, preferCanvas: true }).setView(v ? [v.lat, v.lon] : [52.2297, 21.0122], v ? v.z : 16);
      this.addBaseLayers(L);
      this.renderer = L.canvas({ padding: 0.5 });
      this.roadLayer = L.layerGroup().addTo(this.map);
      this.routeLayer = L.layerGroup().addTo(this.map);
      this.issueLayer = L.layerGroup().addTo(this.map);
      this.map.on('click', e => this.addWaypoint(e.latlng.lat, e.latlng.lng));
      this.map.on('moveend', () => {
        const c = this.map.getCenter();
        try { localStorage.setItem(VIEW_KEY, JSON.stringify({ lat: c.lat, lon: c.lng, z: this.map.getZoom() })); } catch { /* ignore */ }
        this.updateLoadBtn();
        clearTimeout(this.autoT);
        this.autoT = setTimeout(() => this.loadRoads({ auto: true }), 350);
      });
    }
    setTimeout(() => { this.map.invalidateSize(); this.updateLoadBtn(); this.loadRoads({ auto: true }); }, 50);
    this.validate();
  }

  // Keyless tile servers only. If the chosen one keeps failing (offline,
  // blocked, rate-limited) we fall through to the next automatically.
  addBaseLayers(L) {
    const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    const esriAttr = 'Tiles &copy; <a href="https://www.esri.com">Esri</a>';
    const esri = s => `https://server.arcgisonline.com/ArcGIS/rest/services/${s}/MapServer/tile/{z}/{y}/{x}`;
    const bases = {
      Streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: osmAttr }),
      Satellite: L.layerGroup([
        L.tileLayer(esri('World_Imagery'), { maxZoom: 19, attribution: `${esriAttr}, Maxar, Earthstar Geographics` }),
        L.tileLayer(esri('Reference/World_Transportation'), { maxZoom: 19, opacity: 0.9 }),
      ]),
      'Street map (Esri)': L.tileLayer(esri('World_Street_Map'), { maxZoom: 19, attribution: esriAttr }),
      Humanitarian: L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', { maxZoom: 19, subdomains: 'abc', attribution: `${osmAttr}, tiles by HOT` }),
    };
    const names = Object.keys(bases);
    const saved = localStorage.getItem(VIEW_KEY + '.base');
    let cur = names.includes(saved) ? saved : 'Streets';
    bases[cur].addTo(this.map);
    L.control.layers(bases, null, { position: 'topright' }).addTo(this.map);
    this.map.on('baselayerchange', e => { cur = e.name; errs = 0; oks = 0; try { localStorage.setItem(VIEW_KEY + '.base', cur); } catch { /* ignore */ } });
    let errs = 0, oks = 0;
    const watch = layer => {
      const tiles = layer.eachLayer ? [] : [layer];
      if (layer.eachLayer) layer.eachLayer(l => tiles.push(l));
      for (const t of tiles) {
        t.on('tileload', () => { oks++; });
        t.on('tileerror', () => {
          errs++;
          if (errs >= 8 && oks < 2 && bases[cur] === layer) {
            const next = names[(names.indexOf(cur) + 1) % names.length];
            this.map.removeLayer(layer);
            bases[next].addTo(this.map);
            cur = next; errs = 0; oks = 0;
            this.toast(`Map tiles failed to load - switched to "${next}".`, '');
          }
        });
      }
    };
    for (const l of Object.values(bases)) watch(l);
  }

  updateLoadBtn() {
    const z = this.map.getZoom();
    $('st-load').disabled = z < 14 || this.busy;
    $('st-load').textContent = this.busy ? 'Loading...' : z < 14 ? 'Zoom in to load streets' : this.graph ? 'Reload streets' : 'Load streets here';
  }

  async search(q) {
    if (!q.trim()) return;
    try {
      const r = await geocode(q);
      if (!r.length) { this.toast('Nothing found for that search.', 'err'); return; }
      this.map.setView([r[0].lat, r[0].lon], 16);
      this.toast(r[0].name.split(',').slice(0, 3).join(','), '');
    } catch (err) { this.toast(err.message, 'err'); }
  }

  locate() {
    if (!navigator.geolocation) { this.toast('Location is not available in this browser.', 'err'); return; }
    navigator.geolocation.getCurrentPosition(p => this.map.setView([p.coords.latitude, p.coords.longitude], 16),
      () => this.toast('Could not get your location.', 'err'), { timeout: 10000 });
  }

  // Streets come from vector tiles (fast CDN); Overpass is the fallback.
  // auto: called after the map moves - only loads when the view leaves the
  // area we already have, and grows that area instead of replacing it.
  async loadRoads({ auto = false, around = null } = {}) {
    if (this.busy) { if (around) { while (this.busy) await new Promise(r => setTimeout(r, 100)); } else { this.reloadAfter = true; return; } }
    if (!around && this.map.getZoom() < 14) { if (!auto) this.toast('Zoom in a bit more to load streets.', 'err'); return; }
    const v = this.map.getBounds();
    let view = { s: v.getSouth(), w: v.getWest(), n: v.getNorth(), e: v.getEast() };
    const pad = v.pad(0.4);
    let bb = { s: pad.getSouth(), w: pad.getWest(), n: pad.getNorth(), e: pad.getEast() };
    if (around) { view = bb = around; auto = true; }
    const g0 = this.graph?.bbox;
    if (auto && g0) {
      if (view.s >= g0.s && view.n <= g0.n && view.w >= g0.w && view.e <= g0.e) return;
      const u = { s: Math.min(g0.s, bb.s), w: Math.min(g0.w, bb.w), n: Math.max(g0.n, bb.n), e: Math.max(g0.e, bb.e) };
      if (areaKm2(u) <= 30) bb = u;
    }
    if (areaKm2(bb) > 40) { this.toast('That area is too big - zoom in a bit more.', 'err'); return; }
    this.busy = true; this.updateLoadBtn();
    $('st-roadinfo').textContent = 'Loading streets...';
    try {
      let g;
      try { g = await loadStreetsVT(bb, $('st-paths').checked); }
      catch (err) {
        $('st-roadinfo').textContent = 'Fast map source unavailable - asking OpenStreetMap directly...';
        g = await loadStreets(bb, $('st-paths').checked, s => { $('st-roadinfo').textContent = s; });
      }
      // keep waypoints: re-snap them onto the new graph
      this.graph = g;
      this.drawRoads();
      for (const w of this.wps) { const n = nearestNode(g, w.lat, w.lon, 120); w.node = n ? n.id : null; }
      const segs = [...g.nodes.values()].reduce((a, n) => a + n.adj.length, 0) / 2;
      $('st-roadinfo').textContent = `${Math.round(segs)} street segments loaded. Click the map to place waypoints.`;
      this.recompute();
    } catch (err) {
      $('st-roadinfo').textContent = err.message;
      this.toast(err.message, 'err');
    } finally {
      this.busy = false; this.updateLoadBtn();
      if (this.reloadAfter) { this.reloadAfter = false; this.loadRoads({ auto: true }); }
    }
  }

  drawRoads() {
    const L = window.L;
    this.roadLayer.clearLayers();
    for (const w of this.graph.ways) {
      L.polyline(w.ll, { renderer: this.renderer, color: w.path ? '#5aa05a' : '#4a5d86', weight: w.path ? 1.5 : 2.5, opacity: 0.75, interactive: false, dashArray: w.path ? '3 4' : null }).addTo(this.roadLayer);
    }
  }

  icon(i) {
    return window.L.divIcon({ className: 'wp-icon' + (i === 0 ? ' start' : ''), html: i === 0 ? '&#9873;' : String(i + 1), iconSize: [26, 26] });
  }

  addWaypoint(lat, lon, at = null) {
    const snap = $('st-snap').checked;
    let node = null;
    if (snap) {
      if (!this.graph) {
        if (this.map.getZoom() < 14) { this.toast('Zoom in closer to the streets first.', 'err'); return; }
        this.loadRoads().then(() => { if (this.graph) this.addWaypoint(lat, lon, at); });
        return;
      }
      const n = nearestNode(this.graph, lat, lon, 70);
      if (!n) { this.toast('Click closer to a street.', 'err'); return; }
      node = n.id; lat = n.lat; lon = n.lon;
    }
    const w = { node, lat, lon };
    w.marker = window.L.marker([lat, lon], { draggable: true, icon: this.icon(0), autoPan: true }).addTo(this.map);
    w.marker.on('dragend', ev => {
      const p = ev.target.getLatLng();
      if ($('st-snap').checked && this.graph) {
        const n = nearestNode(this.graph, p.lat, p.lng, 120);
        if (n) { w.node = n.id; w.lat = n.lat; w.lon = n.lon; } else { w.lat = p.lat; w.lon = p.lng; }
      } else { w.lat = p.lat; w.lon = p.lng; w.node = null; }
      w.marker.setLatLng([w.lat, w.lon]);
      this.recompute();
    });
    w.marker.on('contextmenu', () => { this.map.removeLayer(w.marker); this.wps = this.wps.filter(q => q !== w); this.recompute(); });
    if (at == null) this.wps.push(w); else this.wps.splice(at, 0, w);
    this.recompute();
  }

  clear() {
    for (const w of this.wps) this.map.removeLayer(w.marker);
    this.wps = [];
    this.recompute();
  }

  // Route every leg (last waypoint back to the first closes the loop).
  recompute() {
    const snap = $('st-snap').checked && this.graph;
    this.wps.forEach((w, i) => w.marker.setIcon(this.icon(i)));
    this.legs = [];
    const used = new Set();
    const n = this.wps.length;
    if (n >= 2) {
      for (let i = 0; i < n; i++) {
        const a = this.wps[i], b = this.wps[(i + 1) % n];
        if (n === 2 && i === 1) { /* two points: the closing leg is the same pair, still route it to show the loop */ }
        if (snap && a.node != null && b.node != null) {
          const path = route(this.graph, a.node, b.node, used, $('st-paths').checked ? 1.0 : 1.4);
          if (path) {
            for (let k = 0; k + 1 < path.length; k++) used.add(ekey(path[k], path[k + 1]));
            this.legs.push({ ok: true, nodes: path, ll: path.map(id => { const q = this.graph.nodes.get(id); return [q.lat, q.lon]; }) });
            continue;
          }
          this.legs.push({ ok: false, ll: [[a.lat, a.lon], [b.lat, b.lon]] });
        } else this.legs.push({ ok: true, ll: [[a.lat, a.lon], [b.lat, b.lon]] });
      }
    }
    this.drawRoute();
    clearTimeout(this.vT);
    this.vT = setTimeout(() => this.validate(), 60);
  }

  drawRoute() {
    const L = window.L;
    this.routeLayer.clearLayers();
    this.legs.forEach((leg, i) => {
      const closing = i === this.legs.length - 1;
      const line = L.polyline(leg.ll, { color: leg.ok ? '#ff6b2c' : '#ff2a2a', weight: 7, opacity: 0.9, dashArray: !leg.ok ? '8 8' : closing ? '12 8' : null, lineCap: 'round', lineJoin: 'round' }).addTo(this.routeLayer);
      line.on('click', e => { L.DomEvent.stopPropagation(e); this.addWaypoint(e.latlng.lat, e.latlng.lng, i + 1); });
    });
  }

  // Full loop in metres -> processed centerline -> checks.
  validate() {
    const L = window.L;
    const box = $('st-checks');
    this.issueLayer?.clearLayers();
    this.result = null;
    const checks = [];
    const add = (level, text, ll) => checks.push({ level, text, ll });
    const n = this.wps.length;
    if (n < 3) {
      add(n ? 'error' : 'info', n ? `Add at least ${3 - n} more waypoint${3 - n > 1 ? 's' : ''} to make a loop.` : 'Drop waypoints around the streets you want to race.');
      this.renderChecks(checks); return;
    }
    const broken = this.legs.findIndex(l => !l.ok);
    if (broken >= 0) add('error', `Waypoints ${broken + 1} and ${(broken + 1) % n + 1} aren't connected by any street. Move one of them.`, this.legs[broken].ll[0]);
    else add('ok', `Closed loop through ${n} waypoints.`);
    // stitch the legs
    const ll = [];
    for (const leg of this.legs) for (const p of leg.ll) { const q = ll[ll.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) ll.push(p); }
    if (ll.length > 2 && ll[0][0] === ll[ll.length - 1][0] && ll[0][1] === ll[ll.length - 1][1]) ll.pop();
    const lat0 = ll.reduce((a, p) => a + p[0], 0) / ll.length, lon0 = ll.reduce((a, p) => a + p[1], 0) / ll.length;
    const proj = new Proj(lat0, lon0);
    const raw = ll.map(p => proj.xz(p[0], p[1]));
    // streets used twice
    if (this.legs.every(l => l.nodes)) {
      const seen = new Map(), dup = [];
      for (const leg of this.legs) for (let k = 0; k + 1 < leg.nodes.length; k++) {
        const key = ekey(leg.nodes[k], leg.nodes[k + 1]);
        if (seen.has(key)) dup.push(leg.nodes[k]); else seen.set(key, 1);
      }
      if (dup.length) {
        const q = this.graph.nodes.get(dup[0]);
        const w = this.graph.ways.find(wy => wy.ll.some(p => p[0] === q.lat && p[1] === q.lon));
        add('error', `The route drives ${w?.name ? `along ${escapeHtml(w.name)}` : 'a street'} twice. Add a waypoint on a different street to make a proper loop.`, [q.lat, q.lon]);
      } else add('ok', 'Every street is used only once.');
    }
    // hairpins at waypoints
    const hp = [];
    this.wps.forEach((w, i) => {
      const [x, z] = proj.xz(w.lat, w.lon);
      let k = 0, bd = Infinity;
      raw.forEach((p, j) => { const d = Math.hypot(p[0] - x, p[1] - z); if (d < bd) { bd = d; k = j; } });
      const at = (j, dist, dir) => { let acc = 0, m = j; while (acc < dist) { const nx = (m + dir + raw.length) % raw.length; acc += Math.hypot(raw[nx][0] - raw[m][0], raw[nx][1] - raw[m][1]); m = nx; if (m === j) break; } return raw[m]; };
      const a = at(k, 18, -1), b = at(k, 18, 1), c = raw[k];
      const a1 = Math.atan2(c[0] - a[0], c[1] - a[1]), a2 = Math.atan2(b[0] - c[0], b[1] - c[1]);
      if (Math.abs(wrapAngle(a2 - a1)) > 2.6) hp.push(i);
    });
    if (hp.length) add('error', `The route doubles back at waypoint ${hp.map(i => i + 1).join(', ')} (a U-turn). Move it so the loop flows around a block.`, [this.wps[hp[0]].lat, this.wps[hp[0]].lon]);
    // geometry checks on the smoothed centerline
    const width = +$('st-width').value;
    const center = buildCenterline(raw, width);
    if (!center) { add('error', 'The loop is too small.'); this.renderChecks(checks); return; }
    const tr = new Track({ width, pts: center.flatMap(p => [p[0], p[1]]) });
    const an = analyzeTrack(tr);
    const len = tr.L;
    if (len < TRACK_LIMITS.minLen) add('error', `Only ${Math.round(len)} m long - make it at least ${TRACK_LIMITS.minLen} m.`);
    else if (len > TRACK_LIMITS.maxLen) add('error', `${(len / 1000).toFixed(2)} km is too long (max ${TRACK_LIMITS.maxLen / 1000} km).`);
    else add('ok', `${(len / 1000).toFixed(2)} km - about ${fmtLap(len / 27)} a lap.`);
    // one line per kind of problem; every spot still gets a red ring on the map
    const byCode = new Map();
    for (const is of an.issues) {
      if (is.code === 'short' || is.code === 'long') continue;
      const ll2 = is.x != null ? proj.ll(is.x, is.z) : null;
      if (!byCode.has(is.code)) byCode.set(is.code, { ...is, spots: [] });
      if (ll2) byCode.get(is.code).spots.push(ll2);
    }
    for (const g of byCode.values()) {
      const more = g.spots.length > 1 ? ` <span class="dim">(${g.spots.length} spots, ringed in red)</span>` : '';
      add(g.level, g.msg + more, g.spots[0] || null);
      for (const sp of g.spots.slice(1)) checks.push({ level: g.level, hidden: true, ll: sp });
    }
    const corners = countCorners(tr);
    add('info', `${corners} corner${corners === 1 ? '' : 's'}. Start line goes on the longest straight.`);
    const ok = !checks.some(c => c.level === 'error');
    this.result = ok ? { raw, proj, width, center, ll, lat0, lon0 } : null;
    // issue markers
    for (const c of checks) if (c.ll && (c.level === 'error' || c.level === 'warn')) {
      L.circleMarker(c.ll, { radius: 16, color: '#ff2a2a', weight: 3, fillColor: '#ff2a2a', fillOpacity: 0.2 }).addTo(this.issueLayer);
    }
    // direction arrows along the route
    if (ok) {
      let acc = 0;
      for (let i = 0; i < raw.length; i++) {
        const a = raw[i], b = raw[(i + 1) % raw.length], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        acc += d;
        if (acc > 140 && d > 4) {
          acc = 0;
          const m = proj.ll((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
          const ang = Math.atan2(b[0] - a[0], -(b[1] - a[1])) * 180 / Math.PI;
          L.marker(m, { interactive: false, icon: L.divIcon({ className: 'arrow-icon', html: `<div style="transform:rotate(${ang - 90}deg)">&#10148;</div>`, iconSize: [16, 16] }) }).addTo(this.issueLayer);
        }
      }
    }
    if (!$('st-name').value && this.legs.every(l => l.nodes)) $('st-name').placeholder = this.suggestName();
    this.renderChecks(checks);
  }

  renderChecks(checks) {
    const box = $('st-checks');
    const sym = { ok: '&#10003;', error: '!', warn: '!', info: 'i' };
    box.innerHTML = checks.map((c, i) => (c.hidden ? '' : `<div class="check ${c.level}" data-i="${i}"><i>${sym[c.level]}</i><span>${c.text}</span></div>`)).join('');
    box.querySelectorAll('.check.error').forEach(el => el.addEventListener('click', () => { const c = checks[+el.dataset.i]; if (c.ll) this.map.setView(c.ll, Math.max(this.map.getZoom(), 17)); }));
    $('st-build').disabled = !this.result || this.busy;
  }

  suggestName() {
    const count = new Map();
    for (const leg of this.legs) for (let k = 0; k + 1 < (leg.nodes?.length || 0); k++) {
      const a = this.graph.nodes.get(leg.nodes[k]);
      const e = a.adj.find(x => x.to === leg.nodes[k + 1]);
      const w = e && this.graph.wayById.get(e.way);
      if (w?.name) count.set(w.name, (count.get(w.name) || 0) + e.len);
    }
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? `${top[0]} Circuit` : 'My Street Circuit';
  }

  // Random loop inside the loaded street network, around the map centre.
  async surprise() {
    // make sure ~750 m around the centre is loaded, whatever the window size
    const c0 = this.map.getCenter();
    const dLat = 750 / 110574, dLon = 750 / (111320 * Math.cos(c0.lat * Math.PI / 180));
    await this.loadRoads({ around: { s: c0.lat - dLat, n: c0.lat + dLat, w: c0.lng - dLon, e: c0.lng + dLon } });
    if (!this.graph) return;
    const nodes = [...this.graph.nodes.values()].filter(n => n.main && n.adj.length >= 3);
    if (nodes.length < 6) { this.toast('Not enough streets here for a loop.', 'err'); return; }
    // keep the loop inside the loaded area
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z); }
    const c = this.map.getCenter();
    const [mx, mz] = this.graph.proj.xz(c.lat, c.lng);
    const cx = Math.min(Math.max(mx, minX + 150), maxX - 150), cz = Math.min(Math.max(mz, minZ + 150), maxZ - 150);
    const room = Math.max(150, Math.min(cx - minX, maxX - cx, cz - minZ, maxZ - cz) - 30);
    const center = { x: cx, z: cz };
    for (let attempt = 0; attempt < 40; attempt++) {
      const R = Math.min(room, 180 + Math.random() * 300), k = 4 + Math.floor(Math.random() * 2), a0 = Math.random() * 6.283;
      const pick = [];
      for (let i = 0; i < k; i++) {
        const a = a0 + (i / k) * 6.283 + (Math.random() - 0.5) * 0.5;
        const tx = center.x + Math.sin(a) * R, tz = center.z + Math.cos(a) * R;
        let best = null, bd = 90;
        for (const n of nodes) { const d = Math.hypot(n.x - tx, n.z - tz); if (d < bd) { bd = d; best = n; } }
        if (best && !pick.includes(best)) pick.push(best);
      }
      if (pick.length < 3) continue;
      this.clear();
      for (const p of pick) {
        const w = { node: p.id, lat: p.lat, lon: p.lon };
        this.wps.push(w);
        w.marker = window.L.marker([p.lat, p.lon], { draggable: true, icon: this.icon(0) }).addTo(this.map);
        w.marker.on('dragend', ev => { const q = ev.target.getLatLng(); const n2 = nearestNode(this.graph, q.lat, q.lng, 120); if (n2) { w.node = n2.id; w.lat = n2.lat; w.lon = n2.lon; } w.marker.setLatLng([w.lat, w.lon]); this.recompute(); });
        w.marker.on('contextmenu', () => { this.map.removeLayer(w.marker); this.wps = this.wps.filter(q => q !== w); this.recompute(); });
      }
      this.recompute();
      clearTimeout(this.vT);
      this.validate();
      if (this.result) {
        this.map.fitBounds(window.L.latLngBounds(this.result.ll), { padding: [40, 40], maxZoom: 17 });
        this.toast('Found a loop! Drag the waypoints to tweak it.', 'good');
        return;
      }
    }
    this.toast('Could not find a clean loop here - try placing waypoints yourself.', 'err');
  }

  async build() {
    if (!this.result || this.busy) return;
    const r = this.result;
    this.busy = true; $('st-build').disabled = true;
    const status = s => { $('st-progress').textContent = s; };
    try {
      const name = ($('st-name').value || $('st-name').placeholder || 'My Street Circuit').trim().slice(0, 40);
      const tmpTrack = new Track({ width: r.width, pts: r.center.flatMap(p => [p[0], p[1]]) });
      let scen;
      try { scen = await loadSceneryVT(tmpTrack, r.proj, status); }
      catch (err) {
        try { scen = await loadScenery(tmpTrack, r.proj, status); }
        catch (err2) {
          status('Map servers busy - using generic buildings instead.');
          scen = genScenery(tmpTrack, 'mixed', Date.now() & 0xffff);
        }
      }
      const data = finalizeTrack({ name, width: r.width, center: r.center, scen, origin: { lat: r.lat0, lon: r.lon0 }, author: this.profile.name, extra: { style: 'osm', ll: r.ll.filter((_, i) => i % 3 === 0).map(p => [+p[0].toFixed(5), +p[1].toFixed(5)]) } });
      status(`Built "${name}": ${(data.len / 1000).toFixed(2)} km, ${scen.b.length} buildings.`);
      try { await this.store.put(data); } catch { /* storage may be unavailable */ }
      this.onBuilt(data);
    } catch (err) {
      status(err.message);
      this.toast(err.message, 'err');
    } finally { this.busy = false; $('st-build').disabled = !this.result; }
  }
}

function fmtLap(s) { const m = Math.floor(s / 60); return `${m}:${String(Math.round(s % 60)).padStart(2, '0')}`; }
function countCorners(tr) {
  let n = 0, inC = false;
  for (let i = 0; i < tr.n; i++) {
    const c = Math.abs(tr.k[i]) > 1 / 60;
    if (c && !inC) n++;
    inC = c;
  }
  return n;
}
