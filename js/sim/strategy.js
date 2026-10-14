// Tyre strategy for pit-stop races. Simulate this car (Hard bot driving, no
// traffic) on each compound for a stint, measure what a pit stop costs on this
// track, then search every plan with 1-3 stops for the quickest race.
// Pure: runs in a worker (strategyWorker.js) and in Node.
import { Track } from './track.js';
import { makeCarState, stepCar, placeCar, respawn, specFromStats } from './physics.js';
import { computeStats } from './parts.js';
import { BotBrain } from './ai.js';
import { PHYS } from './config.js';
import { COMPOUND_IDS } from './tyres.js';

export const SERVICE_TIME = 2.4;     // a decent crew (the quick-time event decides the real one)
const SEEDS = [7, 23];

// Lap times on one set of tyres from a standing start.
function stint(track, spec, cmp, laps, wear, seed, pitAfter = 0) {
  const c = makeCarState('comet');
  c.spec = spec; c.cmp = cmp;
  placeCar(c, track, track.gridSlot(0));
  const brain = new BotBrain(2, seed);
  const dt = PHYS.dt, out = [];
  let t = 0, lap = 0, last = 0;
  while (out.length < laps && t < laps * 240) {
    const want = pitAfter > 0 && c.stops === 0 && c.P / track.L > pitAfter - 0.5;
    const inp = brain.think(c, track, dt, { started: true, wantPit: want });
    stepCar(c, inp, track, dt, { allowDrive: true, topMul: 1, pits: true, wear });
    for (const e of c.ev) if (e === 'pitbox') c.pitT = SERVICE_TIME;
    c.ev.length = 0;
    if (brain.wantRespawn) { respawn(c, track); brain.wantRespawn = false; }
    t += dt;
    const cur = Math.floor(c.P / track.L) + 1;
    if (c.P >= 0 && cur > lap) { if (lap >= 1) out.push(t - last); lap = cur; last = t; }
  }
  return out;
}

const mean = arrs => arrs[0].map((_, i) => arrs.reduce((a, r) => a + (r[i] ?? r[r.length - 1]), 0) / arrs.length);

// { table: { US: [lap 1, lap 2, ...], ... }, pitLoss, laps }
export function simulateTyres(trackData, type, build, { laps, wear = 1, equalize = false }) {
  const track = trackData instanceof Track ? trackData : new Track(trackData);
  if (!track.pit) throw new Error('This track has no pit lane.');
  const spec = specFromStats(computeStats(type, build, equalize));
  const n = Math.max(2, Math.min(laps, 9));
  const table = {};
  for (const cmp of COMPOUND_IDS) {
    const t = mean(SEEDS.map(s => stint(track, spec, cmp, n, wear, s)));
    // past the simulated laps, carry on with the last lap's trend (worn tyres only get worse)
    for (let i = n; i < laps; i++) t.push(t[i - 1] + Math.max(0, Math.min(t[i - 1] * 0.03, t[i - 1] - t[i - 2])));
    table[cmp] = t.map(x => Math.round(x * 1000) / 1000);
  }
  // what a stop costs: the same two laps with and without one (fresh Mediums both times)
  const plain = mean(SEEDS.map(s => stint(track, spec, 'M', 2, wear, s)));
  const pitted = mean(SEEDS.map(s => stint(track, spec, 'M', 2, wear, s, 1)));
  const pitLoss = Math.max(4, pitted[0] + pitted[1] - plain[0] - plain[1]);
  return { table, pitLoss: Math.round(pitLoss * 100) / 100, laps, len: track.L };
}

// Every plan with 1..3 stops: stints of whole laps, any compound per stint.
// The first stint starts from the grid (lap 1 of the table); later stints start
// on a flying out-lap (lap 2 onwards of the table).
export function planStrategies(sim, laps, keep = 6) {
  const { table, pitLoss } = sim;
  const stintTime = (cmp, n, first) => { let s = 0; for (let i = 0; i < n; i++) s += table[cmp][first ? i : i + 1] ?? table[cmp][table[cmp].length - 1]; return s; };
  const best = new Map();
  const maxStops = Math.min(3, laps - 1);
  const parts = [];
  const rec = (left, k, acc) => {
    if (k === 1) { parts.push([...acc, left]); return; }
    for (let a = 1; a <= left - (k - 1); a++) rec(left - a, k - 1, [...acc, a]);
  };
  for (let stops = 1; stops <= maxStops; stops++) {
    parts.length = 0;
    rec(laps, stops + 1, []);
    const nComb = 4 ** (stops + 1);
    for (const split of parts) {
      for (let m = 0; m < nComb; m++) {
        let x = m, time = stops * pitLoss;
        const stints = [];
        for (let k = 0; k <= stops; k++) {
          const cmp = COMPOUND_IDS[x % 4]; x = Math.floor(x / 4);
          stints.push({ cmp, laps: split[k] });
          time += stintTime(cmp, split[k], k === 0);
        }
        // keep the quickest plan for each compound sequence
        const key = stints.map(s => s.cmp).join('-');
        const prev = best.get(key);
        if (!prev || time < prev.time) best.set(key, { stints, time, stops });
      }
    }
  }
  const all = [...best.values()].sort((a, b) => a.time - b.time);
  const top = all.slice(0, keep);
  const t0 = top[0]?.time ?? 0;
  for (const p of top) { p.delta = Math.round((p.time - t0) * 100) / 100; p.time = Math.round(p.time * 100) / 100; }
  return top;
}

export const planLabel = p => p.stints.map(s => `${s.cmp} ${s.laps}`).join(' > ');
