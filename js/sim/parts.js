// Car builds: every car is a body (base stats, see CARS) plus one part per
// slot. Parts trade stats against each other AND add or remove mass, and mass
// feeds back into everything:
//   heavier  ->  slower acceleration, worse handling, but harder to shove
//                around and quicker to shake off hits.
// A big wing buys grip with drag and kilos; a V12 buys top speed with a heavy
// nose. Values were tuned with `npm run sim -- parts`, which laps every part
// on every body (clean + with item hits) and checks no swap is a free win.
//
// Upgrades: each non-stock part has levels 1-3 (credits). Higher levels
// strengthen the upside and shave the downside (~+0.25% lap time per level
// on a typical part). Hosts can set lobbies to "equalized" = everything at L1.
import { CARS } from './config.js';
import { clamp } from './util.js';

// d: stat deltas (spd / acc / hnd), kg: mass change, lvl: driver level to unlock.
// Traits (multipliers, 1 = neutral):
//   drift - drift turn rate + mini-turbo charge speed     stun - spin-out / flip time
//   oil   - oil-slick spin time                           ram  - collision mass (who gets shoved)
//   jump  - ramp launch height
export const PARTS = {
  engine: {
    label: 'Engine', icon: 'engine',
    options: {
      twin:   { name: 'Twin 0.7',      hp: 75,  kg: 90,  d: { spd: -0.15, acc: -0.09 },  lvl: 1, desc: 'Featherweight bike-derived twin. Saves a lot of kilos.' },
      i4:     { name: 'Street I4',     hp: 160, kg: 130, d: { spd: 0, acc: 0 },          lvl: 1, desc: 'Honest four-banger. The reference everything is measured against.' },
      turbo:  { name: 'Turbo I4',      hp: 235, kg: 145, d: { spd: 0.15, acc: -0.05 },        lvl: 2, desc: 'Big turbo on a light block. More top end for a few kilos.' },
      rotary: { name: 'Rotary',        hp: 250, kg: 115, d: { spd: 0.3, acc: -0.55 },     lvl: 4, desc: 'Screams to the redline. Light, but lazy off the line.' },
      diesel: { name: 'Turbo Diesel',  hp: 260, kg: 220, d: { spd: 0, acc: 0.72 },       lvl: 5, desc: 'Mountains of torque, and it weighs like one.' },
      v8:     { name: 'V8 Muscle',     hp: 390, kg: 210, d: { spd: 0.25, acc: 0.26 },    lvl: 7, desc: 'Big, loud and heavy in the nose.' },
      ev:     { name: 'Dual Motor EV', hp: 420, kg: 280, d: { spd: -0.1, acc: 1.35 },     lvl: 9, desc: 'Instant torque from standstill. The battery is the catch.' },
      v12:    { name: 'V12',           hp: 540, kg: 260, d: { spd: 0.64, acc: 0.12 },     lvl: 12, desc: 'Absurd top end. Absurd weight.' },
    },
  },
  exhaust: {
    label: 'Exhaust', icon: 'exhaust',
    options: {
      stock:    { name: 'Stock',          kg: 0,   d: {},                        lvl: 1, desc: 'Quiet and legal.' },
      sport:    { name: 'Sport Twin',     kg: 3,   d: { spd: 0.03, acc: 0.03 },  lvl: 1, desc: 'Twin tips and a nicer note.' },
      straight: { name: 'Straight Pipe',  kg: -6,  d: { spd: 0.12, acc: -0.2 },  lvl: 3, desc: 'No back-pressure: top end up, bottom end down. Spits flames.' },
      side:     { name: 'Side Pipes',     kg: 8,   d: { spd: -0.03, acc: 0.15 }, lvl: 6, desc: 'Short, loud runners for punch out of corners.' },
      quad:     { name: 'Quad Tips',      kg: 10,  d: { spd: 0.05, acc: 0.05 },  lvl: 8, desc: 'Four pipes, free-flowing, a little heavier.' },
      titanium: { name: 'Titanium',       kg: -10, d: { spd: -0.05 },            lvl: 10, desc: 'Featherweight and blue-tinted. Slightly restrictive.' },
    },
  },
  hood: {
    label: 'Hood', icon: 'hood',
    options: {
      stock:  { name: 'Stock',          kg: 0,   d: {},                        lvl: 1, desc: 'Factory bonnet.' },
      vented: { name: 'Vented',         kg: -4,  d: { spd: -0.05, acc: 0.05 }, lvl: 2, desc: 'Heat extractors. Cooler engine, a touch of drag.' },
      scoop:  { name: 'Ram-air Scoop',  kg: 6,   d: { spd: 0.05, acc: 0.03 },  lvl: 4, desc: 'Force-feeds the intake at speed.' },
      carbon: { name: 'Carbon',         kg: -14, d: {}, stun: 1.02,            lvl: 7, desc: 'Weightless weave. Cracks if you look at it.' },
      blower: { name: 'Supercharger',   kg: 22,  d: { spd: -0.1, acc: 0.35 },  lvl: 11, desc: 'A blower poking through the hood. Brutal low-end.' },
    },
  },
  vents: {
    label: 'Vents', icon: 'vents',
    options: {
      none:    { name: 'None',          kg: 0, d: {},                        lvl: 1, desc: 'Clean flanks.' },
      fender:  { name: 'Fender Vents',  kg: 3, d: { spd: -0.04, hnd: 0.08 }, lvl: 2, desc: 'Bleed wheel-well pressure for a bit more front grip.' },
      scoops:  { name: 'Brake Scoops',  kg: 5, d: { spd: -0.06, hnd: 0.12 }, lvl: 5, desc: 'Cool brakes, braver corner entries.' },
      louvers: { name: 'Roof Louvers',  kg: 4, d: { spd: -0.05, hnd: 0.1 },  lvl: 9, desc: 'Rear-window slats that clean up airflow to the wing.' },
    },
  },
  wing: {
    label: 'Rear Wing', icon: 'wing',
    options: {
      stock:  { name: 'Stock',          kg: 0,   d: {},                        lvl: 1, desc: 'Factory rear end.' },
      none:   { name: 'Delete',         kg: -12, d: { spd: 0.1, hnd: -0.25 },  lvl: 1, desc: 'Less drag, less weight, less grip.' },
      duck:   { name: 'Ducktail',       kg: 8,   d: { spd: -0.04, hnd: 0.14 }, lvl: 2, desc: 'A subtle kick of downforce.' },
      gt:     { name: 'GT Wing',        kg: 22,  d: { spd: -0.18, hnd: 0.48 }, lvl: 4, desc: 'Real downforce, real drag.' },
      swan:   { name: 'Swan-neck Wing', kg: 34,  d: { spd: -0.32, hnd: 0.8 },  lvl: 10, desc: 'Glued to the road. Draggy as a parachute.' },
    },
  },
  aero: {
    label: 'Front Aero', icon: 'aero',
    options: {
      stock:  { name: 'Stock',          kg: 0,  d: {},                        lvl: 1, desc: 'Factory bumper.' },
      lip:    { name: 'Lip Spoiler',    kg: 3,  d: { spd: -0.02, hnd: 0.07 }, lvl: 1, desc: 'A little chin.' },
      split:  { name: 'Splitter',       kg: 10, d: { spd: -0.05, hnd: 0.17 }, lvl: 3, desc: 'Front downforce for sharper turn-in.' },
      canard: { name: 'Canards',        kg: 6,  d: { spd: -0.12, hnd: 0.25 }, lvl: 6, desc: 'Dive planes. Bite now, drag later.' },
    },
  },
  fenders: {
    label: 'Fenders', icon: 'fenders',
    options: {
      stock:  { name: 'Stock',          kg: 0,  d: {},                        lvl: 1, desc: 'Factory arches.' },
      flared: { name: 'Flared Arches',  kg: 18, d: { spd: -0.08, hnd: 0.29 }, lvl: 3, desc: 'Room for wider rubber.' },
      wide:   { name: 'Wide-body Kit',  kg: 45, d: { spd: -0.16, hnd: 0.65 }, ram: 1.1, lvl: 8, desc: 'Full wide-body with fat tyres. Grippy, heavy, shoves back.' },
    },
  },
  tires: {
    label: 'Tyres', icon: 'tires',
    options: {
      street: { name: 'Street',         kg: 0,  d: {},                          lvl: 1, desc: 'All-rounders.' },
      slick:  { name: 'Racing Slicks',  kg: 4,  d: { hnd: 0.45 }, drift: 0.85,    lvl: 3, desc: 'Huge grip, but slides charge mini-turbos slowly.' },
      drift:  { name: 'Drift Compound', kg: 0,  d: { hnd: -0.55 }, drift: 1.22,   lvl: 4, desc: 'Slippery. Drifts tighter and charges mini-turbos fast.' },
      knobby: { name: 'Off-road Knobbies', kg: 30, d: { spd: -0.2, hnd: -0.1 }, stun: 0.9, oil: 0.55, lvl: 6, desc: 'Shrug off oil and bounce back from hits faster.' },
    },
  },
  wheels: {
    label: 'Wheels', icon: 'wheels',
    options: {
      stock:    { name: 'Stock Steelies', kg: 0,   d: {},                        lvl: 1, desc: 'Heavy, cheap, unbreakable.' },
      alloy:    { name: 'Light Alloys',   kg: -20, d: {}, stun: 1.02,            lvl: 2, desc: 'Less unsprung weight. Bend easily.' },
      dish:     { name: 'Deep Dish',      kg: 10,  d: { hnd: 0.1 },              lvl: 4, desc: 'Wide lips, wider stance.' },
      big:      { name: '20" Rims',       kg: 14,  d: { hnd: 0.2, acc: -0.1 },   lvl: 7, desc: 'Big wheels, low profile, slow to spin up.' },
      beadlock: { name: 'Beadlocks',      kg: 22,  d: {}, stun: 0.97, oil: 0.7,  lvl: 9, desc: 'Off-road wheels that keep the tyre on no matter what.' },
    },
  },
  susp: {
    label: 'Suspension', icon: 'susp',
    options: {
      stock:   { name: 'Stock',         kg: 0,  d: {},                                 lvl: 1, desc: 'Comfortable.' },
      lowered: { name: 'Lowered',       kg: 0,  d: { hnd: 0.15 }, jump: 0.75,          lvl: 2, desc: 'Slammed. Turns in flat, bottoms out on ramps.' },
      rally:   { name: 'Rally',         kg: 8,  d: { hnd: -0.1 }, drift: 1.07,        lvl: 5, desc: 'Long travel tuned for sliding.' },
      lifted:  { name: 'Lifted',        kg: 15, d: { hnd: -0.2 }, stun: 0.95, jump: 1.3, lvl: 8, desc: 'Sky-high. Floppy in turns, huge air off ramps.' },
    },
  },
  armor: {
    label: 'Armour', icon: 'armor',
    options: {
      none:   { name: 'None',           kg: 0,   d: {},                         lvl: 1, desc: 'Nothing bolted on.' },
      bull:   { name: 'Bull Bar',       kg: 55,  d: {}, ram: 1.45, stun: 0.95,  lvl: 3, desc: 'Shove other cars out of your way.' },
      cage:   { name: 'Roll Cage',      kg: 45,  d: {}, stun: 0.95,             lvl: 5, desc: 'Recover from spins and flips faster.' },
      carbon: { name: 'Carbon Panels',  kg: -45, d: {}, ram: 0.85, stun: 1.04,  lvl: 11, desc: 'Lighter everything. Crumples like paper.' },
    },
  },
};
export const SLOTS = Object.keys(PARTS);
export const PERF_SLOTS = SLOTS;
export const MAX_PART_LEVEL = 3;
export const UPGRADE_COST = [0, 0, 400, 1000];   // credits to reach level n

// Cosmetic-only choices.
export const LIVERIES = ['none', 'stripes', 'flames', 'checker', 'split', 'number'];
export const GLOWS = [null, '#29d8ff', '#ff3d7f', '#7dff5a', '#ffd23f', '#b46bff'];

export const STOCK_ENGINE = { comet: 'i4', viper: 'v12', pixie: 'twin', hornet: 'turbo', brute: 'diesel', mudcat: 'rotary', titan: 'v8', volt: 'ev' };
// Each body's own factory parts (stock options in other slots are always 0-delta).
export function stockBuild(type) {
  const b = { livery: 'none', glow: null, accent: '#f1f1f1', lv: {} };
  for (const s of SLOTS) b[s] = Object.keys(PARTS[s].options)[0];
  b.engine = STOCK_ENGINE[type] || 'i4';
  b.wing = 'stock';
  return b;
}
export const isStockPart = (type, slot, opt) => opt === stockBuild(type)[slot];

export function sanitizeBuild(type, b) {
  const out = stockBuild(type);
  if (b && typeof b === 'object') {
    for (const s of SLOTS) if (PARTS[s].options[b[s]]) out[s] = b[s];
    if (LIVERIES.includes(b.livery)) out.livery = b.livery;
    if (GLOWS.includes(b.glow)) out.glow = b.glow;
    if (typeof b.accent === 'string' && /^#[0-9a-f]{6}$/i.test(b.accent)) out.accent = b.accent;
    if (b.lv && typeof b.lv === 'object') for (const s of SLOTS) {
      const l = Math.round(Number(b.lv[s]) || 1);
      if (l > 1) out.lv[s] = clamp(l, 1, MAX_PART_LEVEL);
    }
  }
  return out;
}

// Body mass (kg) at stock: derived from the weight stat so stock cars keep
// the collision behaviour the base stats promise.
export const massFromWgt = w => 680 * (0.8 + 0.3 * w);
const wgtFromMass = m => (m / 680 - 0.8) / 0.3;

// Mass coupling: stat points lost per log-unit of mass gained.
export const MASS_ACC = 8, MASS_HND = 6;

// A part at upgrade level L: upsides grow 15% per level, downsides (negative
// stats, added kilos, bad trait multipliers) shrink 15-20% per level.
export function partAt(p, L = 1) {
  if (L <= 1) return p;
  const k = L - 1;
  const d = {};
  for (const [s, v] of Object.entries(p.d)) d[s] = v > 0 ? v * (1 + 0.15 * k) : v * (1 - 0.15 * k);
  const tr = (m, goodBelow) => m == null ? m : (goodBelow ? (m < 1 ? 1 - (1 - m) * (1 + 0.15 * k) : 1 + (m - 1) * (1 - 0.15 * k))
    : (m > 1 ? 1 + (m - 1) * (1 + 0.15 * k) : 1 - (1 - m) * (1 - 0.15 * k)));
  return {
    ...p, d,
    kg: p.kg > 0 ? p.kg * (1 - 0.2 * k) : p.kg * (1 + 0.2 * k),
    stun: tr(p.stun, true), oil: tr(p.oil, true), ram: tr(p.ram, false),
    drift: p.drift, jump: p.jump,
  };
}

// -> { spd, acc, hnd, wgt, drift, stun, oil, ram, jump, kg, hp }
// equalize: ignore upgrade levels (everything at level 1).
export function computeStats(type, build, equalize = false) {
  const car = CARS[type] || CARS.comet;
  const b = sanitizeBuild(type, build);
  const st = car.stats;
  const m0 = massFromWgt(st.wgt);
  const lvOf = s => (equalize ? 1 : b.lv[s] || 1);
  const stockEng = PARTS.engine.options[STOCK_ENGINE[type] || 'i4'];
  const eng = partAt(PARTS.engine.options[b.engine], b.engine === STOCK_ENGINE[type] ? 1 : lvOf('engine'));
  let spd = st.spd + ((eng.d.spd || 0) - (stockEng.d.spd || 0));
  let acc = st.acc + ((eng.d.acc || 0) - (stockEng.d.acc || 0));
  let hnd = st.hnd;
  let kg = m0 + (eng.kg - stockEng.kg);
  let drift = 1, stun = 1, oil = 1, ram = 1, jump = 1;
  for (const slot of SLOTS) {
    if (slot === 'engine') continue;
    const p = partAt(PARTS[slot].options[b[slot]], lvOf(slot));
    spd += p.d.spd || 0; acc += p.d.acc || 0; hnd += p.d.hnd || 0;
    kg += p.kg;
    if (p.drift) drift *= p.drift;
    if (p.stun) stun *= p.stun;
    if (p.oil) oil *= p.oil;
    if (p.ram) ram *= p.ram;
    if (p.jump) jump *= p.jump;
  }
  const lm = Math.log(kg / m0);
  acc -= MASS_ACC * lm;
  hnd -= MASS_HND * lm;
  const r = v => Math.round(v * 100) / 100;
  return {
    spd: r(clamp(spd, 0.2, 6.5)), acc: r(clamp(acc, 0.2, 6.5)), hnd: r(clamp(hnd, 0.2, 6.5)), wgt: r(clamp(wgtFromMass(kg), 0.2, 7)),
    drift, stun, oil, ram, jump, kg: Math.round(kg), hp: eng.hp,
  };
}
