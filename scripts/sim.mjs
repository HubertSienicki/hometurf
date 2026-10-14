// Headless balance checks. A Hard bot drives (no items) and we compare lap times.
//   npm run sim                 stock car balance on every preset track
//   npm run sim -- sens         lap-time value of one stat point
//   npm run sim -- parts        every part swap on every body vs stock
//   npm run sim -- random       random full builds vs stock
import { PRESETS, buildPreset } from '../js/sim/presets.js';
import { Track, analyzeTrack } from '../js/sim/track.js';
import { makeCarState, stepCar, respawn, placeCar, specFromStats, makeSpec, stun } from '../js/sim/physics.js';
import { BotBrain } from '../js/sim/ai.js';
import { CAR_IDS, CARS, PHYS } from '../js/sim/config.js';
import { PARTS, SLOTS, stockBuild, computeStats } from '../js/sim/parts.js';
import { mulberry32 } from '../js/sim/util.js';

const mode = process.argv[2] || 'cars';
const tracks = PRESETS.map(p => {
  const data = buildPreset(p.key);
  const track = new Track(data);
  const an = analyzeTrack(track);
  console.log(`${p.name}: ${Math.round(track.L)} m, ${an.ok ? 'valid' : 'INVALID'} [${an.issues.map(i => i.code).join(',')}] ` +
    `buildings=${data.scen.b.length} trees=${data.scen.t.length / 2} boxes=${data.feats.boxes.length} pads=${data.feats.pads.length} ramps=${data.feats.ramps.length}`);
  return { name: p.name, track };
});

// chaos: every 330 m the car gets spun out (or flipped), like a race with items flying.
function lapTime(track, spec, laps = 3, chaos = false) {
  const c = makeCarState('comet');
  c.spec = spec;
  placeCar(c, track, track.gridSlot(0));
  const brain = new BotBrain(2, 7);
  const times = [];
  let t = 0, lap = 0, last = 0, walls = 0, hits = 0, nextHit = 150;
  const dt = PHYS.dt;
  while (times.length < laps && t < 900) {
    const inp = brain.think(c, track, dt, { started: true });
    stepCar(c, inp, track, dt, { allowDrive: true, topMul: 1 });
    for (const e of c.ev) if (e.k === 'wall') walls++;
    c.ev.length = 0;
    if (brain.wantRespawn) { respawn(c, track); brain.wantRespawn = false; }
    t += dt;
    if (chaos && c.P > nextHit) { hits++; nextHit += 330; stun(c, hits % 3 ? 'spin' : 'tumble', hits % 3 ? 1.15 : 1.45); }
    const cur = Math.floor(c.P / track.L) + 1;
    if (c.P >= 0 && cur > lap) { if (lap >= 1) times.push(t - last); lap = cur; last = t; }
  }
  const timed = times.slice(1);
  return { avg: timed.reduce((a, b) => a + b, 0) / timed.length, walls };
}
// Each track is run clean and with chaos; score = time / reference time.
// Columns: one per track (clean+chaos averaged).
const refTimes = spec => tracks.map(tr => (lapTime(tr.track, spec).avg + lapTime(tr.track, spec, 3, true).avg) / 2);
function score(spec, ref) {
  const per = refTimes(spec).map((v, i) => v / ref[i]);
  return { per, avg: per.reduce((a, b) => a + b, 0) / per.length };
}
const pct = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;

if (mode === 'cars') {
  const ref = refTimes(makeSpec('comet'));
  console.log('\nStock cars vs Comet (negative = faster):   ' + tracks.map(t => t.name.split(' ')[0].padEnd(9)).join(''));
  for (const type of CAR_IDS) {
    const s = score(makeSpec(type), ref);
    console.log(`  ${type.padEnd(7)} avg ${pct(s.avg - 1).padStart(6)}   ` + s.per.map(v => pct(v - 1).padEnd(9)).join(''));
  }
} else if (mode === 'sens') {
  const base = { spd: 3, acc: 3, hnd: 3, wgt: 3 };
  const ref = refTimes(specFromStats(base));
  for (const k of ['spd', 'acc', 'hnd', 'wgt']) for (const d of [-1, 1]) {
    const s = score(specFromStats({ ...base, [k]: base[k] + d }), ref);
    console.log(`  ${k}${d > 0 ? '+1' : '-1'}  avg ${pct(s.avg - 1).padStart(6)}   ` + s.per.map(v => pct(v - 1).padEnd(9)).join(''));
  }
} else if (mode === 'parts') {
  const rows = {};
  const bodies = process.argv[3] === 'all' ? CAR_IDS : ['comet', 'pixie', 'viper', 'titan'];
  for (const type of bodies) {
    const stock = stockBuild(type);
    const ref = refTimes(makeSpec(type, stock));
    for (const slot of SLOTS) for (const opt of Object.keys(PARTS[slot].options)) {
      if (opt === stock[slot]) continue;
      const s = score(makeSpec(type, { ...stock, [slot]: opt }), ref);
      (rows[`${slot}:${opt}`] ||= []).push([type, s.avg - 1, s.per.map(v => v - 1)]);
    }
  }
  console.log('\nPart swap vs stock, averaged over tracks (negative = faster). Worst body / best body shown.');
  for (const [k, list] of Object.entries(rows)) {
    const avg = list.reduce((a, r) => a + r[1], 0) / list.length;
    const sorted = list.slice().sort((a, b) => a[1] - b[1]);
    const trackAvg = tracks.map((_, i) => list.reduce((a, r) => a + r[2][i], 0) / list.length);
    console.log(`  ${k.padEnd(15)} avg ${pct(avg).padStart(6)}  best ${sorted[0][0]} ${pct(sorted[0][1])}  worst ${sorted[sorted.length - 1][0]} ${pct(sorted[sorted.length - 1][1])}   per track ${trackAvg.map(pct).join(' ')}`);
  }
} else if (mode === 'random') {
  const rng = mulberry32(42);
  for (const type of CAR_IDS) {
    const stock = stockBuild(type);
    const ref = refTimes(makeSpec(type, stock));
    const res = [];
    for (let i = 0; i < 6; i++) {
      const b = { ...stock };
      for (const s of SLOTS) { const o = Object.keys(PARTS[s].options); b[s] = o[Math.floor(rng() * o.length)]; }
      const st = computeStats(type, b);
      res.push([score(makeSpec(type, b), ref).avg - 1, `${b.engine}/${b.wing}/${b.aero}/${b.tires}/${b.armor} ${st.kg}kg`]);
    }
    res.sort((a, b) => a[0] - b[0]);
    console.log(`  ${type.padEnd(7)} ` + res.map(r => `${pct(r[0])} (${r[1]})`).join('\n          '));
  }
}
