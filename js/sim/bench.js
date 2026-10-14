// Test Bench: drives a build around a track with the Hard bot (no traffic)
// and measures lap / sector times, plus straight-line numbers. Pure, so it
// runs in a worker (benchWorker.js) and in Node (scripts/sim.mjs).
import { Track } from './track.js';
import { makeCarState, stepCar, placeCar, respawn, stun, specFromStats } from './physics.js';
import { computeStats } from './parts.js';
import { BotBrain } from './ai.js';
import { PHYS } from './config.js';

function lapRun(track, spec, { laps = 3, chaos = false } = {}) {
  const c = makeCarState('comet');
  c.spec = spec;
  placeCar(c, track, track.gridSlot(0));
  const brain = new BotBrain(2, 11);
  const dt = PHYS.dt;
  let t = 0, bIdx = track.boundaryIndex(c.P), secStart = null, lapStart = null, hits = 0, nextHit = 150;
  let cur = [null, null, null], vmax = 0, cornerSum = 0, cornerN = 0, walls = 0, mts = 0;
  const lapsOut = [];
  while (lapsOut.length < laps && t < 600) {
    const prevP = c.P;
    const inp = brain.think(c, track, dt, { started: true });
    stepCar(c, inp, track, dt, { allowDrive: true, topMul: 1 });
    for (const e of c.ev) { if (e.k === 'wall') walls++; else if (typeof e === 'string' && e.startsWith('mt')) mts++; }
    c.ev.length = 0;
    if (brain.wantRespawn) { respawn(c, track); brain.wantRespawn = false; }
    t += dt;
    if (chaos && c.P > nextHit) { hits++; nextHit += 330; stun(c, hits % 3 ? 'spin' : 'tumble', hits % 3 ? 1.15 : 1.45); }
    vmax = Math.max(vmax, c.vf);
    if (Math.abs(track.curvAt(c.lastS)) > 1 / 45) { cornerSum += c.vf; cornerN++; }
    const b = track.boundaryIndex(c.P);
    for (let k = bIdx + 1; k <= b; k++) {
      const lap = Math.floor(k / 3), type = ((k % 3) + 3) % 3;
      const Pk = lap * track.L + (type === 0 ? 0 : track.sectors[type - 1]);
      const at = t - dt * (c.P > prevP ? (c.P - Pk) / (c.P - prevP) : 0);
      const ended = (type + 2) % 3;
      if (secStart != null) cur[ended] = at - secStart;
      secStart = at;
      if (type === 0) {
        if (lapStart != null) lapsOut.push({ time: at - lapStart, secs: cur.slice() });
        lapStart = at;
        cur = [null, null, null];
      }
    }
    bIdx = Math.max(bIdx, b);
  }
  return { laps: lapsOut, vmax, corner: cornerN ? cornerSum / cornerN : 0, walls, mts };
}

function straightLine(spec) {
  let v = 0, t = 0, t100 = null, t160 = null;
  const dt = 1 / 240;
  while (t < 30 && (t100 == null || (t160 == null && spec.top * 3.6 > 160))) {
    v += spec.accel * Math.max(0.04, 1 - (v / spec.top) ** 2) * dt;
    t += dt;
    if (t100 == null && v >= 100 / 3.6) t100 = t;
    if (t160 == null && v >= 160 / 3.6) t160 = t;
    if (v >= spec.top * 0.995) break;
  }
  return { t100, t160 };
}

export function runBench(trackData, type, build, equalize = false) {
  const track = trackData instanceof Track ? trackData : new Track(trackData);
  const st = computeStats(type, build, equalize);
  const spec = specFromStats(st);
  const clean = lapRun(track, spec, { laps: 3 });
  const race = lapRun(track, spec, { laps: 2, chaos: true });
  const timed = clean.laps.slice(1);
  const best = timed.reduce((a, l) => (!a || l.time < a.time ? l : a), null);
  const sl = straightLine(spec);
  return {
    stats: st,
    best: best ? best.time : null,
    sectors: best ? best.secs : [null, null, null],
    avg: timed.length ? timed.reduce((a, l) => a + l.time, 0) / timed.length : null,
    racePace: race.laps.length ? race.laps.reduce((a, l) => a + l.time, 0) / race.laps.length : null,
    top: spec.top * 3.6, vmax: clean.vmax * 3.6, corner: clean.corner * 3.6,
    t100: sl.t100, t160: sl.t160, walls: clean.walls, mts: clean.mts,
    len: track.L,
  };
}
