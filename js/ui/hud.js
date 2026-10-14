// In-race HUD: DOM for text/panels, canvases for the minimap and screen FX.
import { ITEM_ICONS, ABILITY_ICONS } from './icons.js';
import { ITEMS, ABILITIES, CARS, ITEM_TUNE, SPEEDO } from '../sim/config.js';
import { GEARBOX, gearLabel } from '../sim/drivetrain.js';
import { fmtTime, ordinal, escapeHtml, clamp } from '../sim/util.js';

const $ = id => document.getElementById(id);
const ITEM_KEYS = Object.keys(ITEM_ICONS);
const FEED_ICON = { oil: ITEM_ICONS.oil, mine: ITEM_ICONS.mine, bouncer: ITEM_ICONS.bouncer, missile: ITEM_ICONS.missile, seeker: ITEM_ICONS.seeker, star: ITEM_ICONS.star, ram: ABILITY_ICONS.ram, slam: ABILITY_ICONS.slam, emp: ABILITY_ICONS.emp };

export class HUD {
  constructor(profile) {
    this.profile = profile;
    this.el = $('hud');
    this.fxc = $('hud-fx'); this.fxg = this.fxc.getContext('2d');
    this.map = $('h-map'); this.mapg = this.map.getContext('2d');
    this.towerT = 0; this.rouletteT = 0; this.splats = []; this.lines = [];
    this.secEls = [...document.querySelectorAll('#h-sectors .sec')];
    this.resize();
    addEventListener('resize', () => this.resize());
  }
  resize() { this.fxc.width = innerWidth; this.fxc.height = innerHeight; }

  show(v) { this.el.classList.toggle('hidden', !v); }

  sessionStart(game) {
    const s = game.session;
    this.game = game;
    this.show(!game.attract);
    this.el.classList.toggle('timed', s.kind !== 'race');
    this.el.classList.toggle('noitems', !s.items);
    this.el.classList.toggle('noabil', !s.abilities);
    this.el.classList.toggle('spectating', !game.me);
    this.secEls.forEach(e => { e.className = 'sec'; e.querySelector('span').textContent = ''; });
    $('h-banner').className = ''; $('h-count').className = '';
    $('h-feed').innerHTML = '';
    this.mapPath = null;
    this.splats = [];
    this.lastItem = null;
    $('h-best').textContent = '';
    const a = game.me ? CARS[game.me.type].ability : null;
    $('h-abil').querySelector('.ic').innerHTML = a ? ABILITY_ICONS[a] : '';
    $('h-abil').querySelector('.nm').textContent = a ? ABILITIES[a].name : '';
    this.buildMap(game.track);
  }
  sessionEnd() { this.show(false); this.game = null; }

  // ---- minimap
  buildMap(track) {
    const W = this.map.width, pad = 16, b = track.bounds;
    const sc = Math.min((W - pad * 2) / (b.maxX - b.minX || 1), (W - pad * 2) / (b.maxZ - b.minZ || 1));
    const ox = (W - (b.maxX - b.minX) * sc) / 2, oz = (W - (b.maxZ - b.minZ) * sc) / 2;
    this.mp = { sc, x: x => ox + (x - b.minX) * sc, z: z => oz + (z - b.minZ) * sc };
    const p = new Path2D();
    for (let i = 0; i <= track.n; i += 2) { const k = i % track.n; const X = this.mp.x(track.px[k]), Z = this.mp.z(track.pz[k]); i ? p.lineTo(X, Z) : p.moveTo(X, Z); }
    p.closePath();
    this.mapPath = p;
    this.mapW = Math.max(3, track.width * sc);
    const s0 = track.pointAt(0);
    this.startMark = [this.mp.x(s0.x), this.mp.z(s0.z), s0.h];
    // course features: one marker per item-box row, boost pads, ramps
    const f = track.feats, rows = [...new Set((f.boxes || []).map(b => b[0]))];
    const at = (s, lat = 0) => { const p = track.pointAt(s); return [this.mp.x(p.x + p.nx * lat), this.mp.z(p.z + p.nz * lat), p.h]; };
    this.marks = [
      ...rows.map(s => ['box', ...at(s)]),
      ...(f.pads || []).map(([s, lat]) => ['pad', ...at(s + 4, lat)]),
      ...(f.ramps || []).map(s => ['ramp', ...at(s + 3)]),
    ];
  }
  drawMap(game) {
    const g = this.mapg, W = this.map.width, mp = this.mp;
    g.clearRect(0, 0, W, W);
    if (!this.mapPath) return;
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = 'rgba(8,10,18,0.75)'; g.lineWidth = this.mapW + 7; g.stroke(this.mapPath);
    g.strokeStyle = 'rgba(235,238,245,0.92)'; g.lineWidth = this.mapW; g.stroke(this.mapPath);
    const [sx, sz, sh] = this.startMark;
    g.save(); g.translate(sx, sz); g.rotate(-sh); g.fillStyle = '#ff6b2c'; g.fillRect(-this.mapW, -2, this.mapW * 2, 4); g.restore();
    const hue = (performance.now() / 25) % 360;
    for (const [kind, X, Z, h] of this.marks || []) {
      g.save(); g.translate(X, Z); g.rotate(-h);
      if (kind === 'box') { g.fillStyle = `hsl(${hue},90%,62%)`; g.strokeStyle = '#0b0d16'; g.lineWidth = 1.5; g.fillRect(-3.5, -3.5, 7, 7); g.strokeRect(-3.5, -3.5, 7, 7); }
      else if (kind === 'pad') { g.fillStyle = '#ff8a1f'; g.beginPath(); g.moveTo(0, 5); g.lineTo(-4, -3); g.lineTo(4, -3); g.closePath(); g.fill(); }
      else { g.fillStyle = '#ffd23f'; g.fillRect(-this.mapW * 0.6, -1.5, this.mapW * 1.2, 3); }
      g.restore();
    }
    if (game.items) for (const o of game.items.objs.values()) {
      g.fillStyle = { missile: '#ff4a3a', seeker: '#4aa8ff', bouncer: '#4ade5a', oil: '#111', mine: '#ff7a7a' }[o.kind] || '#fff';
      g.beginPath(); g.arc(mp.x(o.x), mp.z(o.z), o.kind === 'seeker' ? 4 : 2.5, 0, 7); g.fill();
    }
    const focus = game.me || game.cars.get(game.spectate);
    for (const e of [...game.cars.values()].sort((a, b) => (a === focus) - (b === focus))) {
      const X = mp.x(e.c.x), Z = mp.z(e.c.z), me = e === focus;
      g.fillStyle = e.color; g.strokeStyle = me ? '#fff' : '#0b0d16'; g.lineWidth = me ? 3 : 2;
      g.beginPath(); g.arc(X, Z, me ? 6.5 : 4.5, 0, 7); g.fill(); g.stroke();
      if (me) {
        g.save(); g.translate(X, Z); g.rotate(-e.c.h); g.fillStyle = '#fff';
        g.beginPath(); g.moveTo(0, 13); g.lineTo(-4, 7); g.lineTo(4, 7); g.closePath(); g.fill(); g.restore();
      }
    }
  }

  // ---- per frame
  frame(game, dt) {
    if (!game?.session || game.attract) return;
    const me = game.me, s = game.session, now = game.now;
    const focus = me || game.cars.get(game.spectate);
    // position
    const n = game.ranked.length;
    if (focus) {
      const r = focus.rank + 1;
      $('h-pos').innerHTML = `<span class="n">${r}</span><span class="suf">${ordinal(r)}</span><span class="of">/${n}</span>`;
      $('h-pos').dataset.pos = r <= 3 ? r : '';
    }
    // laps / session clock
    const t = game.goT;
    if (s.kind === 'race') {
      const lap = focus ? clamp((focus.lapN || 0) + 1, 1, s.laps) : 1;
      $('h-sess').innerHTML = `LAP <b>${lap}</b><i>/${s.laps}</i>`;
      const lt = focus && focus.owned ? (focus.lapN === 0 ? now - s.startAt : focus.lapStart != null ? now - focus.lapStart : 0) : null;
      $('h-laptime').textContent = focus?.finished ? fmtTime(focus.finTotal) : lt != null && t > 0 ? fmtTime(lt) : '0:00.000';
    } else {
      const left = s.state === 'flag' ? 0 : Math.max(0, s.endAt - now);
      const label = s.kind === 'quali' ? 'QUALIFYING' : 'PRACTICE';
      $('h-sess').innerHTML = s.state === 'flag' ? `<span class="flag">🏁 FINAL LAP</span>` : `${label} <b>${fmtTime(left, false)}</b>`;
      const lt = focus && focus.owned && focus.lapStart != null ? now - focus.lapStart : null;
      $('h-laptime').textContent = lt != null && t > 0 ? fmtTime(lt) : focus?.lapN === 0 || !focus ? 'OUT LAP' : '0:00.000';
    }
    if (focus?.best != null) $('h-best').innerHTML = `BEST <b>${fmtTime(focus.best)}</b>`;
    // speed, revs, gear + drift charge
    if (focus) {
      const c = focus.c;
      const kmh = Math.abs(c.vf) * 3.6 * SPEEDO;
      const mph = this.profile.settings.units === 'mph';
      $('h-speed').innerHTML = `<b>${Math.round(mph ? kmh * 0.621 : kmh)}</b><i>${mph ? 'mph' : 'km/h'}</i>`;
      this.tach(c, focus === me && !!c.manual);
      const ch = $('h-charge');
      const T = [0.7, 1.5, 2.4];
      const tier = c.driftTier || 0;
      ch.dataset.tier = c.drift ? tier : '';
      ch.firstElementChild.style.width = c.drift ? `${clamp((c.driftCharge || 0) / T[2], 0, 1) * 100}%` : '0%';
      $('h-wrong').classList.toggle('on', !!(focus.owned && c.wrongT > 1.2 && !focus.finished));
    }
    // item slot
    if (me) {
      const slot = $('h-item');
      if (me.roulette > 0) {
        this.rouletteT -= dt;
        if (this.rouletteT <= 0) {
          this.rouletteT = 0.07 + (1 - me.roulette / ITEM_TUNE.roulette) * 0.08;
          slot.querySelector('.ic').innerHTML = ITEM_ICONS[ITEM_KEYS[Math.floor(Math.random() * ITEM_KEYS.length)]];
        }
        slot.className = 'slot rolling';
        this.lastItem = '?';
      } else if (me.item) {
        if (this.lastItem !== me.item + me.itemCount) {
          this.lastItem = me.item + me.itemCount;
          slot.querySelector('.ic').innerHTML = ITEM_ICONS[me.item];
          slot.querySelector('.cnt').textContent = me.itemCount > 1 ? `×${me.itemCount}` : '';
          slot.title = ITEMS[me.item].name;
          slot.className = 'slot full pop';
          setTimeout(() => slot.classList.remove('pop'), 300);
          $('h-itemname').textContent = ITEMS[me.item].name;
        }
      } else if (this.lastItem) {
        this.lastItem = null;
        slot.className = 'slot';
        slot.querySelector('.ic').innerHTML = ''; slot.querySelector('.cnt').textContent = '';
        $('h-itemname').textContent = '';
      }
      const ab = $('h-abil');
      const f = clamp(me.ability, 0, 1);
      ab.style.setProperty('--f', f);
      ab.classList.toggle('ready', f >= 1);
    }
    const pad = game.inp?.usingPad;
    if (pad !== this.padHints) {
      this.padHints = pad;
      $('h-item').querySelector('kbd').textContent = pad ? 'X' : 'E';
      $('h-abil').querySelector('kbd').textContent = pad ? 'Y' : 'Q';
    }
    // spectator label
    $('h-spec').textContent = !me || me.finished ? (focus && focus !== me ? `WATCHING ${focus.name.toUpperCase()}  ·  ←/→ to switch` : '') : '';
    // tower (4 Hz)
    this.towerT -= dt;
    if (this.towerT <= 0) { this.towerT = 0.25; this.tower(game); }
    $('h-tab').classList.toggle('hidden', !game.inp?.tab);
    this.drawMap(game);
    this.drawFx(game, dt);
  }

  tower(game) {
    const s = game.session, room = game.room, rows = [];
    const focus = game.me || game.cars.get(game.spectate);
    const lead = game.ranked[0];
    const best = room?.best || { secs: [] };
    for (const e of game.ranked) {
      let right = '';
      if (s.kind === 'race') {
        if (e === lead) right = e.finished ? 'FIN' : `L${Math.max(1, (e.lapN || Math.floor(e.c.P / game.track.L) + 1))}`;
        else if (e.finTotal != null && lead.finTotal != null) right = `+${((e.finTotal - lead.finTotal) / 1000).toFixed(1)}`;
        else {
          const gapP = lead.c.P - e.c.P;
          right = gapP > game.track.L ? `+${Math.floor(gapP / game.track.L)} LAP` : `+${(gapP / Math.max(18, Math.abs(lead.c.vf || 25))).toFixed(1)}`;
        }
      } else {
        right = e.best == null ? '<span class="dim">no time</span>' : e === game.ranked[0] ? fmtTime(e.best) : `+${((e.best - game.ranked[0].best) / 1000).toFixed(3)}`;
      }
      let secs = '';
      if (s.kind !== 'race') {
        const tm = room?.timing?.[e.id];
        secs = '<span class="ms">' + [0, 1, 2].map(k => {
          let col = '';
          if (e.owned && e.secs?.[k]) col = e.secs[k].color;
          else if (tm?.cur?.[k] != null) col = tm.cur[k] <= best.secs[k] ? 'purple' : tm.cur[k] <= tm.bestSecs[k] ? 'green' : 'yellow';
          return `<i class="${col}"></i>`;
        }).join('') + '</span>';
      }
      const fl = room?.best?.lapId === e.id && s.kind !== 'race' ? ' fastest' : '';
      rows.push(`<li class="${e === focus ? 'me' : ''}${e.finished ? ' fin' : ''}${fl}"><b>${e.rank + 1}</b><span class="dot" style="background:${e.color}"></span><span class="nm">${escapeHtml(e.name)}</span>${secs}<span class="gap">${right}</span></li>`);
    }
    $('h-tower').innerHTML = rows.slice(0, 12).join('');
    $('h-tab').innerHTML = `<h3>${{ race: 'Race', quali: 'Qualifying', practice: 'Practice' }[s.kind]} standings</h3><ol>${rows.join('')}</ol>`;
  }

  // ---- screen FX: speed lines + paint splats
  drawFx(game, dt) {
    const g = this.fxg, W = this.fxc.width, H = this.fxc.height;
    g.clearRect(0, 0, W, H);
    const me = game.me;
    if (!me) return;
    const c = me.c;
    const fast = c.boostT > 0 ? 1 : clamp((Math.abs(c.vf) - c.spec.top * 0.92) / (c.spec.top * 0.1), 0, 1) * 0.5;
    if (fast > 0.05 && game.goT > 0) {
      if (this.lines.length < 40 * fast) this.lines.push({ a: Math.random() * 6.283, r: 0.25 + Math.random() * 0.3, v: 1.4 + Math.random(), l: 0.06 + Math.random() * 0.1 });
      g.strokeStyle = c.invT > 0 ? 'rgba(255,220,120,0.5)' : 'rgba(255,255,255,0.45)';
      g.lineWidth = 2;
      const cx = W / 2, cy = H * 0.48, R = Math.hypot(W, H) / 2;
      g.beginPath();
      for (const L of this.lines) {
        L.r += L.v * dt;
        const x1 = cx + Math.cos(L.a) * L.r * R, y1 = cy + Math.sin(L.a) * L.r * R;
        const x2 = cx + Math.cos(L.a) * (L.r + L.l) * R, y2 = cy + Math.sin(L.a) * (L.r + L.l) * R;
        g.moveTo(x1, y1); g.lineTo(x2, y2);
      }
      g.stroke();
    }
    this.lines = this.lines.filter(L => L.r < 1.1 && fast > 0.05);
    // drafting wind
    if (me.drafting && c.draftT > 0.15) {
      g.fillStyle = `rgba(160,220,255,${0.15 * c.draftT})`;
      g.fillRect(0, 0, W, H);
    }
    // paint splats
    if (c.inkT > 0 && this.splats.length) {
      const a = clamp(c.inkT / 1.2, 0, 1);
      for (const s of this.splats) {
        g.fillStyle = `rgba(${s.c},${0.92 * a})`;
        g.beginPath();
        for (let k = 0; k <= 14; k++) {
          const ang = k / 14 * 6.283, rr = s.r * (0.75 + 0.35 * Math.sin(ang * 3 + s.p) + 0.12 * Math.sin(ang * 7 + s.p * 2));
          const x = s.x * W + Math.cos(ang) * rr, y = s.y * H + Math.sin(ang) * rr;
          k ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.fill();
      }
    } else if (c.inkT <= 0) this.splats = [];
  }
  ink() {
    this.splats = [];
    const cols = ['255,79,216', '41,216,255', '255,210,63', '125,255,90'];
    for (let i = 0; i < 9; i++) this.splats.push({ x: 0.15 + Math.random() * 0.7, y: 0.15 + Math.random() * 0.65, r: 70 + Math.random() * 150, p: Math.random() * 6, c: cols[i % cols.length] });
  }

  // ---- one-shot messages
  countdown(n) {
    const el = $('h-count');
    el.textContent = n > 0 ? n : 'GO!';
    el.className = ''; void el.offsetWidth; el.className = n > 0 ? 'show' : 'show go';
  }
  banner(text, cls = '') {
    const el = $('h-banner');
    el.textContent = text; el.className = ''; void el.offsetWidth; el.className = 'show ' + cls;
  }
  // Rev counter: redline zone, the perfect-shift window (manual), live revs, gear.
  tach(c, manual) {
    const D = c.spec?.drive;
    if (!D) return;
    const cv = this.tachC || (this.tachC = $('h-tach-c')), g = this.tachG || (this.tachG = cv.getContext('2d'));
    const W = 230, H = 150, dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const E = D.E, red = E.red, maxK = Math.ceil(red * 1.04 / 1000), full = maxK * 1000;
    const cx = W / 2, cy = 90, R = 76, a0 = Math.PI * 0.8, a1 = Math.PI * 2.2;
    const ang = rpm => a0 + (a1 - a0) * clamp(rpm / full, 0, 1);
    const arc = (from, to, color, w) => { g.strokeStyle = color; g.lineWidth = w; g.beginPath(); g.arc(cx, cy, R, from, to); g.stroke(); };
    g.lineCap = 'butt';
    arc(a0, a1, 'rgba(8, 10, 20, 0.6)', 12);
    const geared = D.gv.length > 1;
    if (!E.electric) arc(ang(red), ang(full), 'rgba(255, 64, 52, 0.85)', 12);
    const lo = (E.shiftAt + GEARBOX.perfectWin[0]) * red, hi = (E.shiftAt + GEARBOX.perfectWin[1]) * red;
    if (manual && geared) arc(ang(lo), ang(hi), 'rgba(70, 255, 150, 0.75)', 12);
    // ticks every 1000 rpm, numbers every 1000 (every 2000 past 12k)
    g.fillStyle = 'rgba(255, 255, 255, 0.8)'; g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    const step = maxK > 12 ? 2 : 1;
    for (let k = 0; k <= maxK; k++) {
      const a = ang(k * 1000), ca = Math.cos(a), sa = Math.sin(a);
      g.strokeStyle = k * 1000 >= red && !E.electric ? '#ff6a5a' : 'rgba(255, 255, 255, 0.7)';
      g.lineWidth = 2; g.beginPath(); g.moveTo(cx + ca * (R - 10), cy + sa * (R - 10)); g.lineTo(cx + ca * (R - 17), cy + sa * (R - 17)); g.stroke();
      if (k % step === 0) g.fillText(String(k), cx + ca * (R - 27), cy + sa * (R - 27));
    }
    // live revs
    const r = clamp(c.rpm || 0, 0, 1.02), rpm = Math.max(E.idle, r * red);
    const inWin = manual && geared && rpm >= lo && rpm <= hi;
    const col = rpm > hi && geared && !E.electric ? '#ff4a3a' : inWin ? '#4dff9a' : r > 0.72 ? '#ffb43a' : '#ffffff';
    g.shadowColor = col; g.shadowBlur = 12;
    arc(a0, ang(rpm), col, 8);
    g.shadowBlur = 0;
    const gearEl = $('h-gear'), label = gearLabel(c, D);
    if (gearEl.textContent !== label) gearEl.textContent = label;
    gearEl.dataset.s = r >= 0.985 && geared ? 'limit' : inWin ? 'go' : '';
    $('h-rpm').textContent = `${(Math.round(rpm / 50) * 50).toLocaleString()} rpm${geared ? (manual ? ' · MANUAL' : ' · AUTO') : ''}`;
  }

  popup(text, cls = '') {
    const p = document.createElement('div');
    p.className = 'pop ' + cls; p.textContent = text;
    $('h-pops').appendChild(p);
    setTimeout(() => p.remove(), 1400);
  }
  flash(color) {
    const f = $('h-flash');
    f.style.background = color; f.className = ''; void f.offsetWidth; f.className = 'on';
  }
  sector(k, ms, color, delta) {
    const el = this.secEls[k];
    if (!el) return;
    el.className = 'sec ' + color;
    el.querySelector('span').textContent = (ms / 1000).toFixed(3);
    if (k < 2) for (let j = k + 1; j < 3; j++) { this.secEls[j].className = 'sec'; this.secEls[j].querySelector('span').textContent = ''; }
    const d = $('h-delta');
    if (delta != null) {
      d.textContent = (delta <= 0 ? '−' : '+') + Math.abs(delta / 1000).toFixed(3);
      d.className = 'show ' + (delta <= 0 ? 'good' : 'bad');
      clearTimeout(this.deltaT); this.deltaT = setTimeout(() => { d.className = ''; }, 2500);
    }
    this.game?.audio.sfx('sector', { color });
  }
  lap(ms, prevPB, sessBest) {
    const pb = prevPB == null || ms < prevPB, purple = sessBest == null || ms <= sessBest;
    this.popup(`LAP ${fmtTime(ms)}`, purple ? 'purple' : pb ? 'green' : 'yellow');
  }
  finish(place, total) {
    this.banner(place === 1 ? 'YOU WIN!' : `FINISHED ${place}${ordinal(place).toUpperCase()}`, place === 1 ? 'win' : 'fin');
  }
  feed({ by, v, kind }) {
    if (!by || !v) return;
    const li = document.createElement('div');
    li.className = 'fl';
    li.innerHTML = `<b style="color:${by.color}">${escapeHtml(by.name)}</b><span class="fi">${FEED_ICON[kind] || ITEM_ICONS.bouncer}</span><b style="color:${v.color}">${escapeHtml(v.name)}</b>`;
    this.pushFeed(li);
  }
  feedUse(e, item) {
    const li = document.createElement('div');
    li.className = 'fl';
    li.innerHTML = `<b style="color:${e.color}">${escapeHtml(e.name)}</b> used <span class="fi">${ITEM_ICONS[item]}</span>${ITEMS[item].name}`;
    this.pushFeed(li);
  }
  feedAbility(e, a) {
    if (!['emp', 'slam', 'grapple', 'blink'].includes(a)) return;
    const li = document.createElement('div');
    li.className = 'fl';
    li.innerHTML = `<b style="color:${e.color}">${escapeHtml(e.name)}</b><span class="fi">${ABILITY_ICONS[a]}</span>${ABILITIES[a].name}`;
    this.pushFeed(li);
  }
  pushFeed(li) {
    const f = $('h-feed');
    f.appendChild(li);
    while (f.children.length > 5) f.firstChild.remove();
    setTimeout(() => li.classList.add('out'), 5000);
    setTimeout(() => li.remove(), 5600);
  }
  chat(m) {
    const box = $('h-chat');
    const li = document.createElement('div');
    li.className = m.sys ? 'cm sys' : 'cm';
    li.innerHTML = m.sys ? escapeHtml(m.text) : `<b style="color:${m.color}">${escapeHtml(m.name)}</b> ${escapeHtml(m.text)}`;
    box.appendChild(li);
    while (box.children.length > 6) box.firstChild.remove();
    setTimeout(() => li.classList.add('out'), 9000);
    setTimeout(() => li.remove(), 9700);
  }
}
