// Garage: pick a car, bolt on parts (with live stat deltas that include the
// mass penalty), buy upgrade levels, paint it, and run the Test Bench.
import { CARS, CAR_IDS, ABILITIES, PAINT, SPEEDO } from '../sim/config.js';
import { PARTS, SLOTS, LIVERIES, GLOWS, MAX_PART_LEVEL, computeStats, stockBuild, partAt } from '../sim/parts.js';
import { PRESETS, buildPreset } from '../sim/presets.js';
import { ABILITY_ICONS, SLOT_ICONS } from './icons.js';
import { fmtTime, escapeHtml } from '../sim/util.js';
import { xpFor } from '../profile.js';
import { ENGINES } from '../sim/drivetrain.js';

const $ = id => document.getElementById(id);
const STAT_KEYS = [['spd', 'SPEED'], ['acc', 'ACCEL'], ['hnd', 'HANDLING'], ['wgt', 'WEIGHT']];
const MAX_STAT = 6.5;
const LIV_NAMES = { none: 'Clean', stripes: 'Racing stripes', flames: 'Flames', checker: 'Checker band', split: 'Two-tone', number: 'Race number' };

export class Garage {
  constructor({ profile, view, audio, toast, store, onChange, currentTrack }) {
    Object.assign(this, { profile, view, audio, toast, store, onChange, currentTrack });
    this.slot = 'engine';
    this.tab = 'parts';
    this.benchHist = {};
    this.worker = null; this.benchId = 0;
    $('g-tabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      this.tab = b.dataset.tab;
      this.render();
    });
  }

  open() {
    this.type = this.profile.car;
    this.render();
    this.preview();
  }
  close() { this.view.hideGarage(this.returnMode || 'menu'); }

  get build() { return this.profile.build(this.type); }
  preview() { this.view.showGarage(this.type, this.profile.color, this.build, this.profile.name); }

  render() {
    const p = this.profile, type = this.type, car = CARS[type];
    // wallet
    const L = p.level, x0 = xpFor(L), x1 = xpFor(L + 1);
    $('g-wallet').innerHTML = `<span class="badge lv">Driver Lv ${L}</span><div class="xpbar" title="${p.xp - x0} / ${x1 - x0} XP"><i style="width:${Math.min(100, (p.xp - x0) / (x1 - x0) * 100)}%"></i></div><span class="cr">${p.credits.toLocaleString()} cr</span>`;
    // car list
    $('g-cars').innerHTML = CAR_IDS.map(id => {
      const c = CARS[id], st = c.stats;
      const bars = STAT_KEYS.map(([k], i) => `<i style="--v:${st[k] / 5 * 100}%;--c:${['#ff6b2c', '#ffd23f', '#29d8ff', '#b06bff'][i]}"></i>`).join('');
      return `<div class="g-car${id === type ? ' on' : ''}" data-car="${id}"><div><b>${c.name}</b><small>${c.kind}</small><div class="mini">${bars}</div></div></div>`;
    }).join('');
    $('g-cars').querySelectorAll('.g-car').forEach(el => el.addEventListener('click', () => {
      this.type = el.dataset.car;
      this.profile.car = this.type;
      this.audio.sfx('click');
      this.render(); this.preview(); this.onChange();
    }));
    // hero
    $('g-carname').textContent = car.name;
    $('g-carkind').textContent = car.kind;
    $('g-blurb').textContent = car.blurb;
    const ab = ABILITIES[car.ability];
    $('g-abil').innerHTML = `${ABILITY_ICONS[car.ability]}<div><b>${ab.name}</b><span>${ab.desc}</span></div>`;
    this.renderStats();
    document.querySelectorAll('#g-tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === this.tab));
    for (const t of ['parts', 'paint', 'bench']) $('g-' + t).classList.toggle('hidden', t !== this.tab);
    if (this.tab === 'parts') this.renderParts();
    if (this.tab === 'paint') this.renderPaint();
    if (this.tab === 'bench') this.renderBench();
  }

  renderStats(preview = null) {
    const type = this.type, b = this.build;
    const base = computeStats(type, stockBuild(type), true);
    const cur = computeStats(type, b);
    const show = preview || cur;
    const rows = STAT_KEYS.map(([k, lab]) => {
      const v0 = base[k], v1 = show[k];
      const lo = Math.min(v0, v1), hi = Math.max(v0, v1);
      const W = v => `${Math.max(0, Math.min(100, v / MAX_STAT * 100))}%`;
      const up = v1 > v0 + 0.005, down = v1 < v0 - 0.005;
      return `<span class="lab">${lab}</span><div class="bar"><div class="base" style="width:${W(lo)}"></div>${up ? `<div class="up" style="left:${W(lo)};width:${W(hi - lo)}"></div>` : ''}${down ? `<div class="down" style="left:${W(lo)};width:${W(hi - lo)}"></div>` : ''}</div><span class="val">${v1.toFixed(2)}</span>`;
    }).join('');
    const traits = [];
    if (Math.abs(show.drift - 1) > 0.01) traits.push(`drift ×${show.drift.toFixed(2)}`);
    if (Math.abs(show.stun - 1) > 0.01) traits.push(`spin time ×${show.stun.toFixed(2)}`);
    if (Math.abs(show.oil - 1) > 0.01) traits.push(`oil ×${show.oil.toFixed(2)}`);
    if (Math.abs(show.ram - 1) > 0.01) traits.push(`ram ×${show.ram.toFixed(2)}`);
    if (Math.abs(show.jump - 1) > 0.01) traits.push(`air ×${show.jump.toFixed(2)}`);
    $('g-stats').innerHTML = rows + `<div class="meta"><span><b>${show.kg}</b> kg</span><span><b>${show.hp}</b> hp</span><span><b>${(show.hp / show.kg * 1000).toFixed(0)}</b> hp/t</span>${traits.map(t => `<span>${t}</span>`).join('')}</div>`;
  }

  // ---- parts
  renderParts() {
    const p = this.profile, type = this.type, b = this.build, stock = stockBuild(type);
    $('g-slots').innerHTML = SLOTS.map(s => `<button data-slot="${s}" class="${s === this.slot ? 'on' : ''}" title="${PARTS[s].label}">${SLOT_ICONS[s]}<span>${PARTS[s].label.replace('Front ', '').replace('Rear ', '')}</span>${b[s] !== stock[s] ? '<i class="dot"></i>' : ''}</button>`).join('');
    $('g-slots').querySelectorAll('button').forEach(el => el.addEventListener('click', () => { this.slot = el.dataset.slot; this.audio.sfx('click'); this.renderParts(); }));
    const slot = this.slot, cur = computeStats(type, b);
    const html = Object.entries(PARTS[slot].options).map(([id, opt]) => {
      const unlocked = p.isUnlocked(slot, id, type);
      const isStock = stock[slot] === id;
      const lv = isStock && slot !== 'engine' ? 1 : p.partLevel(slot, id);
      const st = computeStats(type, { ...b, [slot]: id, lv: { ...b.lv, [slot]: lv } });
      const chips = [];
      for (const [k, lab] of STAT_KEYS) {
        const d = st[k] - cur[k];
        if (Math.abs(d) >= 0.01) chips.push(`<span class="${(k === 'wgt' ? 0 : d) > 0 ? 'p' : k === 'wgt' ? 't' : 'n'}">${d > 0 ? '+' : ''}${d.toFixed(2)} ${lab.slice(0, 3)}</span>`);
      }
      const dkg = st.kg - cur.kg;
      if (dkg) chips.push(`<span class="${dkg > 0 ? 'n' : 'p'}">${dkg > 0 ? '+' : ''}${dkg} kg</span>`);
      const pa = partAt(opt, lv);
      if (pa.drift && pa.drift !== 1) chips.push(`<span class="t">drift ×${pa.drift}</span>`);
      if (pa.stun && Math.abs(pa.stun - 1) > 0.005) chips.push(`<span class="${pa.stun < 1 ? 'p' : 'n'}">spin ×${pa.stun.toFixed(2)}</span>`);
      if (pa.oil && pa.oil !== 1) chips.push(`<span class="p">oil ×${pa.oil.toFixed(2)}</span>`);
      if (pa.ram && Math.abs(pa.ram - 1) > 0.005) chips.push(`<span class="${pa.ram > 1 ? 'p' : 'n'}">ram ×${pa.ram.toFixed(2)}</span>`);
      if (pa.jump && pa.jump !== 1) chips.push(`<span class="t">air ×${pa.jump}</span>`);
      if (opt.hp) {
        const E = ENGINES[id];
        if (E) chips.unshift(`<span class="t">${E.electric ? 'single speed' : `${E.gears}-speed · ${(E.red / 1000).toFixed(1)}k rpm`}</span>`);
        chips.unshift(`<span class="t">${opt.hp} hp</span>`);
      }
      const on = b[slot] === id;
      const canLevel = !isStock && unlocked;
      const pips = canLevel ? `<span class="lvl" title="Upgrade level">${[1, 2, 3].map(i => `<i class="${i <= lv ? 'on' : ''}"></i>`).join('')}</span>` : '';
      const cost = canLevel ? p.upgradeCost(slot, id) : null;
      const upRow = canLevel ? `<div class="up"><span>${lv >= MAX_PART_LEVEL ? 'Fully upgraded' : `Lv ${lv + 1}: stronger upside, lighter downside`}</span>${cost != null ? `<button class="btn small${p.credits >= cost ? ' primary' : ''}" data-up="${id}" ${p.credits >= cost ? '' : 'disabled'}>Upgrade · ${cost} cr</button>` : ''}</div>` : '';
      return `<div class="opt${on ? ' on' : ''}${unlocked ? '' : ' locked'}" data-opt="${id}">
        <div class="hd"><b>${escapeHtml(opt.name)}${isStock ? ' <span class="badge">factory</span>' : ''}</b>${pips}${unlocked ? (on ? '<span class="badge ready">fitted</span>' : '') : `<span class="badge">Lv ${opt.lvl}</span>`}</div>
        <p>${escapeHtml(opt.desc)}${unlocked ? '' : ` <b>Unlocks at driver level ${opt.lvl}.</b>`}</p>
        <div class="deltas">${chips.join('') || '<span>no change</span>'}</div>${on ? upRow : ''}</div>`;
    }).join('');
    $('g-opts').innerHTML = html;
    $('g-opts').querySelectorAll('.opt').forEach(el => {
      const id = el.dataset.opt;
      el.addEventListener('mouseenter', () => {
        if (!p.isUnlocked(slot, id, type)) return;
        const stock2 = stockBuild(type);
        const lv = stock2[slot] === id && slot !== 'engine' ? 1 : p.partLevel(slot, id);
        this.renderStats(computeStats(type, { ...b, [slot]: id, lv: { ...b.lv, [slot]: lv } }));
      });
      el.addEventListener('mouseleave', () => this.renderStats());
      el.addEventListener('click', ev => {
        const up = ev.target.closest('[data-up]');
        if (up) {
          if (p.upgrade(slot, id)) { this.audio.sfx('unlock'); this.toast(`${PARTS[slot].options[id].name} upgraded to Lv ${p.partLevel(slot, id)}`, 'good'); this.onChange(); }
          this.render(); return;
        }
        if (!p.isUnlocked(slot, id, type)) { this.toast(`Reach driver level ${PARTS[slot].options[id].lvl} to unlock this.`, 'err'); return; }
        const nb = { ...b, [slot]: id };
        p.setBuild(type, nb);
        this.audio.sfx('click');
        this.preview(); this.render(); this.onChange();
      });
    });
  }

  // ---- paint & style
  renderPaint() {
    const p = this.profile, b = this.build;
    const sw = (list, cur, attr) => list.map(c => `<div class="swatch${c === cur ? ' on' : ''}${c ? '' : ' none'}" data-${attr}="${c || ''}" style="${c ? `background:${c}` : ''}"></div>`).join('');
    $('g-paint').innerHTML = `
      <div class="kicker">Driver name</div><input id="g-name" maxlength="18" value="${escapeHtml(p.name)}">
      <div class="kicker">Paint</div><div class="swatches">${sw(PAINT, p.color, 'paint')}</div>
      <div class="kicker">Accent (stripes, wing plates, decals)</div><div class="swatches">${sw(['#f1f1f1', ...PAINT.filter(c => c !== '#f1f1f1'), '#111111'], b.accent, 'accent')}</div>
      <div class="kicker">Livery</div><div class="chips">${LIVERIES.map(l => `<button class="chip${l === b.livery ? ' on' : ''}" data-liv="${l}">${LIV_NAMES[l]}</button>`).join('')}</div>
      <div class="kicker">Underglow</div><div class="swatches">${sw(GLOWS, b.glow, 'glow')}</div>
      <p class="muted small">Paint and style are cosmetic - they never change performance.</p>`;
    const save = nb => { p.setBuild(this.type, nb); this.audio.sfx('click'); this.preview(); this.renderPaint(); this.onChange(); };
    $('g-name').addEventListener('change', e => { p.name = e.target.value; this.onChange(); });
    $('g-paint').querySelectorAll('[data-paint]').forEach(el => el.addEventListener('click', () => { p.color = el.dataset.paint; save(this.build); }));
    $('g-paint').querySelectorAll('[data-accent]').forEach(el => el.addEventListener('click', () => save({ ...this.build, accent: el.dataset.accent })));
    $('g-paint').querySelectorAll('[data-liv]').forEach(el => el.addEventListener('click', () => save({ ...this.build, livery: el.dataset.liv })));
    $('g-paint').querySelectorAll('[data-glow]').forEach(el => el.addEventListener('click', () => save({ ...this.build, glow: el.dataset.glow || null })));
  }

  // ---- test bench
  async renderBench() {
    const opts = [];
    const cur = this.currentTrack?.();
    if (cur) opts.push([`room:${cur.id}`, `${cur.name} (current room)`]);
    for (const pr of PRESETS) opts.push([`preset:${pr.key}`, pr.name]);
    let mine = [];
    try { mine = await this.store.list(); } catch { mine = []; }
    for (const t of mine) opts.push([`mine:${t.id}`, t.name]);
    if (!this.benchTrack || !opts.some(o => o[0] === this.benchTrack)) this.benchTrack = opts[0][0];
    $('g-bench').innerHTML = `
      <p class="muted small">Runs this exact setup around a track with a flawless robot driver (no traffic, no items), plus a "race pace" run where it gets hit every 330 m. Compare setups before you race.</p>
      <div class="bench-run"><select id="g-btrack">${opts.map(([v, l]) => `<option value="${v}"${v === this.benchTrack ? ' selected' : ''}>${escapeHtml(l)}</option>`).join('')}</select><button class="btn primary" id="g-brun">Run test</button></div>
      <div id="g-bout">${this.benchHtml || ''}</div>`;
    $('g-btrack').addEventListener('change', e => { this.benchTrack = e.target.value; });
    $('g-brun').addEventListener('click', () => this.runBench());
  }

  async trackData(key) {
    const [kind, id] = key.split(/:(.+)/);
    if (kind === 'preset') return buildPreset(id);
    if (kind === 'room') return this.currentTrack();
    return this.store.get(id);
  }

  async runBench() {
    const data = await this.trackData(this.benchTrack);
    if (!data) { this.toast('Track not available.', 'err'); return; }
    if (!this.worker) {
      this.worker = new Worker(new URL('../benchWorker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => this.onBench(e.data);
    }
    const id = ++this.benchId;
    this.benchCtx = { id, key: this.benchTrack, type: this.type, build: this.build, name: data.name };
    $('g-brun').disabled = true;
    $('g-bout').innerHTML = `<div class="muted small" style="margin-top:12px">Testing on ${escapeHtml(data.name)}...</div><div class="bench-bar"><i></i></div>`;
    const { scen, ...lean } = data;   // the bench doesn't need buildings
    this.worker.postMessage({ id, track: lean, type: this.type, build: this.build, compare: stockBuild(this.type) });
  }

  onBench(msg) {
    if (!this.benchCtx || msg.id !== this.benchCtx.id) return;
    const btn = $('g-brun'); if (btn) btn.disabled = false;
    if (msg.error) { this.benchHtml = `<p class="err">${escapeHtml(msg.error)}</p>`; $('g-bout').innerHTML = this.benchHtml; return; }
    const r = msg.res, s = msg.ref, ctx = this.benchCtx;
    const histKey = `${ctx.key}|${ctx.type}`;
    const prev = this.benchHist[histKey];
    this.benchHist[histKey] = r;
    const d = (a, b, lowerBetter = true, unit = 's', dec = 3) => {
      if (a == null || b == null) return '';
      const x = a - b;
      if (Math.abs(x) < Math.pow(10, -dec)) return '<em>=</em>';
      const good = lowerBetter ? x < 0 : x > 0;
      return `<em class="${good ? 'good' : 'bad'}">${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(dec)}${unit}</em>`;
    };
    const secs = r.sectors.map((t, k) => {
      const ref = s.sectors[k], col = t == null || ref == null ? '' : t < ref - 0.0005 ? 'green' : t > ref + 0.0005 ? 'yellow' : 'purple';
      return `<div class="${col}">S${k + 1}<b>${t != null ? t.toFixed(3) : '-'}</b>${d(t, ref)}</div>`;
    }).join('');
    const kmh = v => (v * SPEEDO).toFixed(0);
    this.benchHtml = `<div class="bench-res">
      <div class="m wide"><small>Best lap · ${escapeHtml(ctx.name)}</small><b>${fmtTime(r.best * 1000)}</b>${d(r.best, s.best)} <span class="muted small">vs stock</span>${prev ? ` ${d(r.best, prev.best)} <span class="muted small">vs last test</span>` : ''}
        <div class="secrow">${secs}</div></div>
      <div class="m"><small>Race pace (with hits)</small><b>${fmtTime(r.racePace * 1000)}</b>${d(r.racePace, s.racePace)}</div>
      <div class="m"><small>0-100 km/h</small><b>${r.t100 != null ? r.t100.toFixed(2) + 's' : '-'}</b>${d(r.t100, s.t100, true, 's', 2)}</div>
      <div class="m"><small>Top speed</small><b>${kmh(r.top)}</b> <span class="muted small">km/h</span>${d(r.top * SPEEDO, s.top * SPEEDO, false, '', 0)}</div>
      <div class="m"><small>Avg corner speed</small><b>${kmh(r.corner)}</b> <span class="muted small">km/h</span>${d(r.corner * SPEEDO, s.corner * SPEEDO, false, '', 1)}</div>
      <div class="m"><small>Mini-turbos / lap</small><b>${(r.mts / 3).toFixed(1)}</b></div>
      <div class="m"><small>Mass</small><b>${r.stats.kg}</b> <span class="muted small">kg</span>${d(r.stats.kg, s.stats.kg, true, ' kg', 0)}</div>
    </div><p class="muted small">Green sectors beat the stock setup, yellow ones are slower.</p>`;
    $('g-bout').innerHTML = this.benchHtml;
    this.audio.sfx('sector', { color: r.best < s.best ? 'green' : 'yellow' });
  }
}
