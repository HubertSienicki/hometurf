// Persistent player profile (localStorage): identity, per-car builds,
// progression (XP -> driver level -> part unlocks, credits -> part upgrade
// levels), settings. Saved tracks live in IndexedDB (see TrackStore).
import { CAR_IDS, PAINT, DEFAULT_SETTINGS } from './sim/config.js';
import { PARTS, SLOTS, MAX_PART_LEVEL, UPGRADE_COST, sanitizeBuild, stockBuild } from './sim/parts.js';

const KEY = 'hometurf.profile.v1';
const DEFAULT_PREFS = { volume: 0.8, sfx: 0.8, music: 0.45, quality: 'high', assist: true, cam: 'normal', units: 'kmh', showFps: false, sandbox: false };

// cumulative XP needed to reach driver level L
export const xpFor = L => 100 * (L - 1) * (L - 1) + 200 * (L - 1);
export function levelFromXp(xp) { let L = 1; while (xpFor(L + 1) <= xp) L++; return L; }

export class Profile {
  constructor() {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { d = {}; }
    this.d = {
      name: typeof d.name === 'string' && d.name.trim() ? d.name.slice(0, 18) : `Driver${Math.floor(100 + Math.random() * 900)}`,
      car: CAR_IDS.includes(d.car) ? d.car : 'comet',
      color: PAINT.includes(d.color) ? d.color : PAINT[Math.floor(Math.random() * 6)],
      builds: d.builds && typeof d.builds === 'object' ? d.builds : {},
      xp: Number(d.xp) || 0,
      credits: Number.isFinite(d.credits) ? d.credits : 600,
      owned: d.owned && typeof d.owned === 'object' ? d.owned : {},
      stats: { races: 0, wins: 0, podiums: 0, hits: 0, bestLaps: {}, ...(d.stats || {}) },
      settings: { ...DEFAULT_PREFS, ...(d.settings || {}) },
      host: { ...DEFAULT_SETTINGS, ...(d.host || {}) },
      token: d.token || Math.random().toString(36).slice(2),
      seenUnlocks: d.seenUnlocks || 1,
    };
    this.save();
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.d)); } catch { /* storage full / private mode */ } }

  get name() { return this.d.name; }
  set name(v) { this.d.name = String(v || '').replace(/[<>]/g, '').trim().slice(0, 18) || this.d.name; this.save(); }
  get car() { return this.d.car; }
  set car(v) { if (CAR_IDS.includes(v)) { this.d.car = v; this.save(); } }
  get color() { return this.d.color; }
  set color(v) { if (PAINT.includes(v)) { this.d.color = v; this.save(); } }
  get settings() { return this.d.settings; }
  get xp() { return this.d.xp; }
  get level() { return levelFromXp(this.d.xp); }
  get credits() { return this.d.credits; }

  isUnlocked(slot, opt, type = this.car) {
    if (this.d.settings.sandbox) return true;
    const p = PARTS[slot]?.options[opt];
    if (!p) return false;
    if (stockBuild(type)[slot] === opt) return true;
    return this.level >= (p.lvl || 1);
  }
  partLevel(slot, opt) {
    if (this.d.settings.sandbox) return MAX_PART_LEVEL;
    return Math.max(1, Math.min(MAX_PART_LEVEL, this.d.owned[`${slot}:${opt}`] || 1));
  }
  upgradeCost(slot, opt) { const L = this.partLevel(slot, opt); return L >= MAX_PART_LEVEL ? null : UPGRADE_COST[L + 1]; }
  upgrade(slot, opt) {
    const cost = this.upgradeCost(slot, opt);
    if (cost == null || this.d.credits < cost || !this.isUnlocked(slot, opt)) return false;
    this.d.credits -= cost;
    this.d.owned[`${slot}:${opt}`] = this.partLevel(slot, opt) + 1;
    this.save();
    return true;
  }

  // Equipped build for a car, with the levels the player owns. Locked parts fall back to stock.
  build(type = this.car) {
    const b = sanitizeBuild(type, this.d.builds[type]);
    const stock = stockBuild(type);
    b.lv = {};
    for (const s of SLOTS) {
      if (!this.isUnlocked(s, b[s], type)) b[s] = stock[s];
      const L = b[s] === stock[s] && s !== 'engine' ? 1 : this.partLevel(s, b[s]);
      if (L > 1) b.lv[s] = L;
    }
    return b;
  }
  setBuild(type, b) {
    const clean = sanitizeBuild(type, b);
    delete clean.lv;
    this.d.builds[type] = clean;
    this.save();
  }

  hello() {
    return { name: this.name, car: this.car, color: this.color, build: this.build(), xpLevel: this.level, token: this.d.token };
  }

  // Race / session rewards. Returns a summary for the results screen.
  reward(results, myId, laps, hitsLanded) {
    const rows = results.rows, me = rows.find(r => r.id === myId);
    if (!me) return null;
    const n = rows.length, beaten = n - me.pos;
    const before = this.level;
    let xp, cr;
    if (results.kind === 'race') {
      xp = 150 + 40 * beaten + 15 * laps + 20 * hitsLanded + (me.pos === 1 && n > 1 ? 150 : 0);
      cr = 200 + 50 * beaten + ([300, 150, 75][me.pos - 1] || 0) * (n > 1 ? 1 : 0);
      this.d.stats.races++;
      if (me.pos === 1 && n > 1) this.d.stats.wins++;
      if (me.pos <= 3 && n > 2) this.d.stats.podiums++;
    } else {
      xp = 50 + 15 * laps + (me.pos === 1 && n > 1 ? 40 : 0);
      cr = 60 + 10 * laps;
    }
    if (me.dnf) { xp = Math.round(xp * 0.5); cr = Math.round(cr * 0.5); }
    this.d.xp += xp; this.d.credits += cr;
    this.d.stats.hits += hitsLanded;
    this.save();
    const after = this.level;
    const unlocks = [];
    for (const s of SLOTS) for (const [k, p] of Object.entries(PARTS[s].options)) if (p.lvl > before && p.lvl <= after) unlocks.push(`${PARTS[s].label}: ${p.name}`);
    return { xp, cr, levelUp: after > before ? after : null, unlocks };
  }
}

// ------------------------------------------------------------ saved tracks
export class TrackStore {
  constructor() { this.dbp = null; }
  db() {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise((res, rej) => {
      const r = indexedDB.open('hometurf', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('tracks', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return this.dbp;
  }
  async tx(mode, fn) {
    const db = await this.db();
    return new Promise((res, rej) => {
      const t = db.transaction('tracks', mode), st = t.objectStore('tracks');
      const out = fn(st);
      t.oncomplete = () => res(out?.result ?? out);
      t.onerror = () => rej(t.error);
    });
  }
  async list() {
    const all = await this.tx('readonly', st => st.getAll());
    return (all || []).map(t => ({ id: t.id, name: t.name, len: t.len, created: t.created, origin: t.origin, author: t.author, pts: t.pts })).sort((a, b) => b.created - a.created);
  }
  get(id) { return this.tx('readonly', st => st.get(id)); }
  put(track) { return this.tx('readwrite', st => st.put(track)); }
  del(id) { return this.tx('readwrite', st => st.delete(id)); }
}
