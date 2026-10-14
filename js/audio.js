// Game audio. Engines and tyres are real recordings (CC0, assets/audio):
// each car crossfades an idle loop into a driving loop whose pitch follows
// the car's real engine speed and gear (sim/drivetrain.js: shifts, limiter,
// lift-off backfires, turbo spool and blow-off). A sub-octave layer and a
// gentle EQ keep high revs full rather than thin. Tyre squeal is granular - short overlapping slices of real
// squeals - and crashes layer recorded impacts with a synthesized thud.
// Opponents are 3D-positioned with Doppler. If the recordings can't load, a
// synthesized engine (engineWorklet.js) takes over.
import { sanitizeBuild } from './sim/parts.js';
import { ENGINES as DRIVE } from './sim/drivetrain.js';

// Firing points are fractions of the 720-degree cycle. The V8 is spaced
// unevenly and its banks differ in loudness - that's the cross-plane burble.
const EVEN = n => Array.from({ length: n }, (_, i) => i / n);
const ENGINES = {
  twin:   { fire: [0, 0.5], idle: 1450, red: 11500, body: 230, q: 1.4, bright: 3600, noise: 0.34, decay: 5, drive: 2.4, vol: 0.75, intake: 0.7, ampVar: 0.22 },
  i4:     { fire: EVEN(4), idle: 850, red: 7000, body: 150, q: 1.2, bright: 2400, noise: 0.28, decay: 6, drive: 1.8, vol: 0.9, intake: 0.5 },
  turbo:  { fire: EVEN(4), idle: 900, red: 7300, body: 140, q: 1.1, bright: 1900, noise: 0.3, decay: 6, drive: 1.7, vol: 0.85, intake: 0.3, turbo: 1 },
  rotary: { fire: EVEN(4), idle: 1050, red: 9500, body: 270, q: 2.2, bright: 4200, noise: 0.42, decay: 3.4, drive: 2.9, vol: 0.8, intake: 0.5, ampVar: 0.32 },
  diesel: { fire: EVEN(4), idle: 750, red: 4600, body: 92, q: 1, bright: 1300, noise: 0.5, decay: 7.5, drive: 1.4, vol: 1, intake: 0.25, knock: 0.32, turbo: 0.55 },
  v8:     { fire: [0, 0.135, 0.25, 0.365, 0.5, 0.64, 0.75, 0.86], amp: [1, 0.68, 1, 0.95, 0.7, 1, 0.66, 0.74], idle: 700, red: 7000, body: 105, q: 1.4, bright: 1500, noise: 0.24, decay: 6.5, drive: 2.2, vol: 1.05, intake: 0.4, jitter: 0.008 },
  v12:    { fire: EVEN(12), idle: 950, red: 9200, body: 245, q: 1.2, bright: 4200, noise: 0.18, decay: 5, drive: 1.6, vol: 1.0, intake: 0.5, jitter: 0.003 },
  ev:     { electric: true, base: 55, top: 720, vol: 0.32 },
};
const EXHAUSTS = {
  stock:    { bright: 0.72, vol: 0.85, pops: 0 },
  sport:    { bright: 1.0, vol: 1.0, pops: 0.35 },
  straight: { bright: 1.5, vol: 1.3, pops: 1, drive: 1.35 },
  side:     { bright: 1.25, vol: 1.2, pops: 0.7 },
  quad:     { bright: 1.1, vol: 1.15, pops: 0.5 },
  titanium: { bright: 1.4, vol: 1.06, pops: 0.6 },
};
// Recorded sound bank. seg = loop cut from that stretch of the file (seconds),
// whole = loop the entire file, raw = keep as a one-shot / grain source.
const BANK = {
  drive:  { file: 'engine-sedan.mp3', whole: true },
  idle:   { file: 'engine-idle.mp3', whole: true },
  v8idle: { file: 'engine-v8.mp3', seg: [0.5, 7.5] },
  v8:     { file: 'engine-v8.mp3', seg: [12.6, 16.3] },
  squealA: { file: 'tyre-squeal-1.mp3', raw: true },
  squealB: { file: 'tyre-squeal-2.mp3', raw: true },
  crash:  { file: 'crash.mp3', raw: true },
  hit:    { file: 'collision.mp3', raw: true },
  tap:    { file: 'collision-fast.mp3', raw: true },
};
// loudest real squeals in each tyre recording (seconds) - grains come from here
const SQUEAL_GRAINS = [['squealA', 3.95, 4.45], ['squealA', 5.75, 6.2], ['squealB', 5.95, 6.35], ['squealB', 3.95, 4.35]];
// How each engine part uses the recordings: playback-rate ranges map idle..redline.
// Rates stay under ~2x (sped-up recordings turn thin and nasal); sub = level of
// the same loop an octave down for body; chorus = a slightly detuned double
// that smooths it out (many cylinders).
const SAMPLED = {
  twin:   { idle: 'idle', idleRate: [1.3, 1.6], drive: 'drive', rate: [1.1, 2.25], lp: 4600, sub: 0.25 },
  i4:     { idle: 'idle', idleRate: [1.0, 1.3], drive: 'drive', rate: [0.9, 1.85], lp: 3900, sub: 0.35 },
  turbo:  { idle: 'idle', idleRate: [1.0, 1.3], drive: 'drive', rate: [0.9, 1.8], lp: 3400, sub: 0.38 },
  rotary: { idle: 'idle', idleRate: [1.25, 1.5], drive: 'drive', rate: [1.05, 2.05], lp: 4800, sub: 0.3 },
  diesel: { idle: 'idle', idleRate: [0.8, 1.0], drive: 'drive', rate: [0.7, 1.32], lp: 2400, sub: 0.45 },
  v8:     { idle: 'v8idle', idleRate: [1.0, 1.2], drive: 'v8', rate: [0.75, 1.6], lp: 3800, sub: 0.4 },
  v12:    { idle: 'v8idle', idleRate: [1.1, 1.3], drive: 'v8', rate: [0.92, 1.72], lp: 4300, sub: 0.42, chorus: 1.012 },
};
const SPEED_OF_SOUND = 343;
const fin = (v, d = 0) => (Number.isFinite(v) ? v : d);

export function engineProfile(type, buildIn) {
  const b = sanitizeBuild(type, buildIn);
  const e = ENGINES[b.engine] || ENGINES.i4, x = EXHAUSTS[b.exhaust] || EXHAUSTS.stock;
  if (e.electric) return { ...e, key: 'ev' + (b.hood === 'blower' ? 'b' : '') , blower: b.hood === 'blower' };
  const sm = SAMPLED[b.engine] || SAMPLED.i4;
  const dr = DRIVE[b.engine] || DRIVE.i4;
  return {
    ...e, idle: dr.idle, red: dr.red, key: `${b.engine}|${b.exhaust}|${b.hood}`,
    bright: e.bright * x.bright, vol: e.vol * x.vol, pops: x.pops, drive: e.drive * (x.drive || 1),
    blower: b.hood === 'blower',
    sample: { ...sm, lp: sm.lp * (0.75 + 0.25 * x.bright) },
  };
}

// ------------------------------------------------------------ engine state
// Follows the car's real engine (sim/drivetrain.js): revs, gear changes and
// throttle, plus the bits only the sound needs (smoothed load, lift-off).
class EngineTrack {
  constructor() { this.gear = 1; this.rpm = 900; this.load = 0.1; this.prevThr = 0; }
  update(p, c, dt, thr) {
    dt = fin(dt, 0); thr = fin(thr, 0);
    let ev = null;
    const g = c.gear || 1;
    if (g > this.gear) ev = 'up'; else if (g < this.gear) ev = 'down';
    this.gear = g;
    const r = Math.max(0, Math.min(1.02, fin(c.rpm, 0.15)));
    this.rpm = Math.max(p.idle, r * p.red);
    let load = thr > 0.05 ? 0.35 + 0.65 * thr : 0.04;
    if (c.shiftT > 0 && c.lastShift !== 'down') load = 0.08;     // torque cut while the gear changes
    if (c.limT > 0 && Math.floor(c.limT * 16) % 2) load = 0.05;  // bouncing off the limiter
    this.load = fin(this.load + (load - this.load) * Math.min(1, dt * 30), 0.1);
    const lift = this.prevThr > 0.6 && thr < 0.1;
    this.prevThr = thr;
    return { ev, lift, rpmF: Math.max(0, Math.min(1.05, (this.rpm - p.idle) / (p.red - p.idle))) };
  }
}

export class Audio {
  constructor(settings) {
    this.settings = settings;
    this.ctx = null;
    this.step = 0; this.nextNote = 0;
    this.mood = 'menu';
    this.remotes = [];
    this.lastCam = null;
  }

  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC({ latencyHint: 'interactive' });
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master = ctx.createGain();
    comp.connect(this.master); this.master.connect(ctx.destination);
    this.sfxG = ctx.createGain(); this.sfxG.connect(comp);
    this.musG = ctx.createGain(); this.musG.connect(comp);
    this.engG = ctx.createGain(); this.engG.connect(comp);
    // reverb: short city-street reflections
    this.rev = ctx.createConvolver();
    this.rev.buffer = this.impulse(1.7);
    this.revIn = ctx.createGain(); this.revIn.gain.value = 0.22;
    const revOut = ctx.createGain(); revOut.gain.value = 0.42;
    this.revIn.connect(this.rev); this.rev.connect(revOut); revOut.connect(comp);
    this.sfxG.connect(this.revIn);
    const engRev = ctx.createGain(); engRev.gain.value = 0.12;
    this.engG.connect(engRev); engRev.connect(this.revIn);
    // noise sources
    this.white = this.noiseBuffer('white');
    this.brown = this.noiseBuffer('brown');
    this.applyVolumes();
    this.buildLoops();
    this.bank = null;
    this.loadBank().catch(err => console.warn('Sound bank failed to load, using synthesized engines', err));
    this.workletReady = false;
    if (ctx.audioWorklet) {
      ctx.audioWorklet.addModule(new URL('./engineWorklet.js', import.meta.url))
        .then(() => { this.workletReady = true; })
        .catch(err => console.warn('Engine worklet unavailable, using simple engines', err));
    }
  }

  // ------------------------------------------------------------ recordings
  async loadBank() {
    const files = new Map();
    const fetchFile = f => {
      if (!files.has(f)) {
        files.set(f, fetch(new URL(`../assets/audio/${f}`, import.meta.url))
          .then(r => { if (!r.ok) throw new Error(f); return r.arrayBuffer(); })
          .then(b => this.ctx.decodeAudioData(b)));
      }
      return files.get(f);
    };
    const bank = {};
    await Promise.all(Object.entries(BANK).map(async ([k, d]) => {
      const buf = await fetchFile(d.file);
      if (d.raw) bank[k] = buf;
      else if (d.whole) bank[k] = this.makeLoop(buf, 0.06, buf.duration - 0.06);
      else bank[k] = this.makeLoop(buf, d.seg[0], d.seg[1]);
    }));
    this.bank = bank;
  }
  // Mono loop from [t0, t1] with its tail crossfaded into its head, so it
  // repeats without a click; normalised so every engine sits at one level.
  makeLoop(buf, t0, t1, xf = 0.12) {
    const sr = buf.sampleRate, n = buf.numberOfChannels;
    const s0 = Math.floor(t0 * sr), s1 = Math.min(buf.length, Math.floor(t1 * sr)), X = Math.floor(xf * sr);
    const len = s1 - s0 - X;
    const chans = Array.from({ length: n }, (_, c) => buf.getChannelData(c));
    const src = i => { let v = 0; for (const ch of chans) v += ch[i]; return v / n; };
    const out = this.ctx.createBuffer(1, len, sr), o = out.getChannelData(0);
    let e = 0;
    for (let i = 0; i < len; i++) {
      let v = src(s0 + i);
      if (i < X) { const a = i / X; v = v * Math.sqrt(a) + src(s0 + len + i) * Math.sqrt(1 - a); }
      o[i] = v; e += v * v;
    }
    const k = 0.12 / (Math.sqrt(e / len) || 1);
    for (let i = 0; i < len; i++) o[i] *= k;
    return out;
  }
  // One recorded sample, optionally positional. Returns false if not loaded.
  play(name, { vol = 1, rate = 1, dest, offset = 0, dur } = {}) {
    const b = this.bank?.[name];
    if (!b) return false;
    const s = this.src(b, false, rate), g = this.gain(vol);
    this.chain(s, g, dest || this.sfxG);
    s.start(this.t, offset, dur);
    return true;
  }
  // A short slice of a real tyre squeal with a smooth envelope.
  squealGrain(level, rate, when) {
    const [name, a, b] = SQUEAL_GRAINS[Math.floor(Math.random() * SQUEAL_GRAINS.length)];
    const buf = this.bank[name], dur = 0.15 + Math.random() * 0.05;
    const off = a + Math.random() * Math.max(0, b - a - dur);
    const s = this.src(buf, false, rate * (0.96 + Math.random() * 0.08)), g = this.gain(0);
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(level, when + 0.045);
    g.gain.setValueAtTime(level, when + dur - 0.06);
    g.gain.linearRampToValueAtTime(0, when + dur);
    this.chain(s, g, this.loops.squealRec);
    s.start(when, off, dur + 0.01);
  }
  // Exhaust backfire: a short, sharp crack.
  pop(dest) {
    this.noise(0.035, { vol: 0.5, freq: 1300, q: 0.8, type: 'bandpass', dest });
    this.tone(70, 0.05, { vol: 0.25, slide: -30, dest });
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.settings;
    this.master.gain.value = s.volume ?? 0.8;
    this.sfxG.gain.value = (s.sfx ?? 0.8) * 0.9;
    this.musG.gain.value = (s.music ?? 0.45) * 0.5;
    this.engG.gain.value = (s.sfx ?? 0.8) * 0.85;
  }

  get t() { return this.ctx.currentTime; }

  noiseBuffer(kind) {
    const ctx = this.ctx, len = ctx.sampleRate * 3, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
    }
    return buf;
  }
  impulse(sec) {
    const ctx = this.ctx, sr = ctx.sampleRate, len = Math.floor(sr * sec), ir = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.4) * (i < sr * 0.006 ? 0 : 0.5);
      for (const [ms, g] of [[11, 0.5], [19, 0.35], [31, 0.3], [47, 0.22], [71, 0.16]]) {
        const k = Math.floor(sr * (ms + c * 3) / 1000);
        if (k < len) d[k] += g * (Math.random() < 0.5 ? -1 : 1);
      }
    }
    return ir;
  }
  src(buf, loop = true, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf; s.loop = loop; s.playbackRate.value = rate;
    return s;
  }
  filt(type, freq, q = 1, gain = 0) {
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = q; f.gain.value = gain;
    return f;
  }
  gain(v = 0) { const g = this.ctx.createGain(); g.gain.value = v; return g; }
  chain(...nodes) { for (let i = 0; i + 1 < nodes.length; i++) nodes[i].connect(nodes[i + 1]); return nodes[nodes.length - 1]; }
  shaper(drive) {
    const ws = this.ctx.createWaveShaper(), n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(x * drive) / Math.tanh(drive); }
    ws.curve = curve; ws.oversample = '2x';
    return ws;
  }
  panner() {
    return new PannerNode(this.ctx, { panningModel: 'HRTF', distanceModel: 'inverse', refDistance: 7, maxDistance: 600, rolloffFactor: 1.25 });
  }

  // Continuous sounds for the player's own car.
  buildLoops() {
    const ctx = this.ctx, L = this.loops = {};
    const loop = (buf, rate = 1) => { const s = this.src(buf, true, rate); s.start(0, Math.random() * 2); return s; };
    // road / tyre roar and wind
    L.road = this.gain(); this.chain(loop(this.brown), this.filt('lowpass', 520, 0.7), L.road, this.sfxG);
    L.wind = this.gain(); this.chain(loop(this.white, 0.7), this.filt('bandpass', 850, 0.45), L.wind, this.sfxG);
    // tyre squeal: a narrow noise band plus two wandering tonal partials, lightly overdriven
    const mix = this.gain(1);
    L.sqF = this.filt('bandpass', 1150, 7);
    this.chain(loop(this.white), L.sqF, mix);
    L.sqO1 = ctx.createOscillator(); L.sqO1.type = 'sawtooth'; L.sqO1.frequency.value = 780;
    L.sqO2 = ctx.createOscillator(); L.sqO2.type = 'sawtooth'; L.sqO2.frequency.value = 1210;
    const tone = this.gain(0.07);
    L.sqO1.connect(tone); L.sqO2.connect(tone);
    this.chain(tone, this.filt('bandpass', 950, 3), mix);
    L.squeal = this.gain();
    this.chain(mix, this.shaper(1.6), L.squeal, this.sfxG);
    L.squealRec = this.gain(1.1);
    this.chain(L.squealRec, this.filt('highpass', 350, 0.7), this.sfxG);
    this.nextGrain = 0;
    // kerb rumble: low noise chopped by a square LFO at the stripe rate
    L.kerb = this.gain();
    const kerbAM = this.gain(0.5);
    this.chain(loop(this.brown), this.filt('lowpass', 220, 1), kerbAM, L.kerb, this.sfxG);
    L.kerbLfo = ctx.createOscillator(); L.kerbLfo.type = 'square'; L.kerbLfo.frequency.value = 12;
    const depth = this.gain(0.5);
    L.kerbLfo.connect(depth); depth.connect(kerbAM.gain);
    // wall scrape and boost afterburner
    L.scrape = this.gain();
    this.chain(loop(this.white, 1.3), this.filt('bandpass', 2300, 1.8), this.shaper(2), L.scrape, this.sfxG);
    L.boost = this.gain();
    this.chain(loop(this.white, 0.6), this.filt('lowpass', 1100, 0.8), L.boost, this.sfxG);
    for (const o of [L.sqO1, L.sqO2, L.kerbLfo]) o.start();
  }

  // ------------------------------------------------------------ engine voices
  makeVoice(positional) {
    const ctx = this.ctx;
    const v = { out: this.gain(0), dt: new EngineTrack(), key: null, nodes: [], car: null, spool: 0, popAcc: 0 };
    if (positional) { v.pan = this.panner(); v.out.connect(v.pan); v.pan.connect(this.engG); }
    else v.out.connect(this.engG);
    return v;
  }
  configureVoice(v, p) {
    const sampled = !p.electric && this.bank;
    const key = p.key + (sampled ? '|s' : this.workletReady ? '|w' : '');
    if (v.key === key) return;
    for (const n of v.nodes) { try { n.stop?.(); } catch { /* ignore */ } try { n.disconnect(); } catch { /* ignore */ } }
    v.nodes = []; v.key = key; v.p = p; v.node = null; v.osc = null; v.sampled = false;
    const ctx = this.ctx, keep = n => { v.nodes.push(n); return n; };
    if (sampled) {
      const sp = p.sample;
      v.sampled = true;
      v.idleSrc = keep(this.src(this.bank[sp.idle], true));
      v.driveSrc = keep(this.src(this.bank[sp.drive], true));
      v.idleG = keep(this.gain(0)); v.driveG = keep(this.gain(0));
      v.lp = keep(this.filt('lowpass', sp.lp, 0.6));
      // comfort EQ: a little weight down low, the harsh 2-6 kHz region eased off
      const eq = [keep(this.filt('lowshelf', 140, 0.7, 3)), keep(this.filt('peaking', 2700, 0.9, -4)), keep(this.filt('highshelf', 5200, 0.7, -5))];
      v.level = keep(this.gain(p.vol * 4.0));
      this.chain(v.idleSrc, v.idleG, v.lp); this.chain(v.driveSrc, v.driveG, v.lp); this.chain(v.lp, ...eq, v.level, v.out);
      // body: the same loop an octave down, low-passed
      v.subSrc = keep(this.src(this.bank[sp.drive], true));
      v.subG = keep(this.gain(0));
      this.chain(v.subSrc, keep(this.filt('lowpass', 280, 0.7)), v.subG, eq[0]);
      if (sp.chorus) {
        v.chSrc = keep(this.src(this.bank[sp.drive], true));
        this.chain(v.chSrc, v.driveG);
      }
      // random start points so several cars never phase against each other
      for (const src of [v.idleSrc, v.driveSrc, v.subSrc, v.chSrc]) if (src) src.start(0, Math.random() * src.buffer.duration);
    } else if (p.electric) {
      v.osc = [1, 2.02, 3.15].map((m, i) => {
        const o = keep(ctx.createOscillator()); o.type = 'sine';
        const g = keep(this.gain([0.4, 0.1, 0.03][i]));
        o.connect(g); g.connect(v.out); o.start();
        return { o, m };
      });
      v.hiss = keep(this.gain(0));
      const s = keep(this.src(this.white)); this.chain(s, keep(this.filt('bandpass', 4200, 2)), v.hiss, v.out); s.start();
    } else if (this.workletReady) {
      v.node = keep(new AudioWorkletNode(ctx, 'ht-engine', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: p }));
      v.body = keep(this.filt('peaking', p.body, p.q, 7));
      v.lp = keep(this.filt('lowpass', p.bright, 0.8));
      v.level = keep(this.gain(p.vol * 0.55));
      this.chain(v.node, keep(this.filt('highpass', 32, 0.7)), v.body, v.lp, keep(this.shaper(p.drive * 0.85)), keep(this.filt('lowpass', 5200, 0.6)), v.level, v.out);
      // intake / induction roar
      v.intake = keep(this.gain(0));
      v.intakeF = keep(this.filt('bandpass', 600, 1.4));
      const s = keep(this.src(this.white)); this.chain(s, v.intakeF, v.intake, v.out); s.start();
    } else {
      // fallback without AudioWorklet: detuned saws through the same body filters
      v.osc = [1, 1.007, 0.5].map(m => { const o = keep(ctx.createOscillator()); o.type = 'sawtooth'; return { o, m }; });
      v.lp = keep(this.filt('lowpass', p.bright, 2));
      v.level = keep(this.gain(p.vol * 0.12));
      for (const { o } of v.osc) { o.connect(v.lp); o.start(); }
      this.chain(v.lp, v.level, v.out);
    }
    if (p.turbo) {
      v.turbo = keep(ctx.createOscillator()); v.turbo.type = 'sine';
      v.turboG = keep(this.gain(0));
      this.chain(v.turbo, v.turboG, v.out); v.turbo.start();
    }
    if (p.blower) {
      v.blow = keep(ctx.createOscillator()); v.blow.type = 'sawtooth';
      v.blowG = keep(this.gain(0));
      this.chain(v.blow, keep(this.filt('bandpass', 2000, 4)), v.blowG, v.out); v.blow.start();
    }
  }

  // Drives one voice from a car's state. doppler scales every pitch.
  driveVoice(v, c, thr, dt, doppler = 1, isMe = false) {
    const p = v.p, t = this.t;
    const r = v.dt.update(p.electric ? { idle: 0, red: 16000 } : p, c, dt, thr);
    const rpm = v.dt.rpm, load = v.dt.load;
    if (p.electric) {
      const f = (p.base + (p.top - p.base) * Math.min(1.1, (c.rpm || 0) / 0.97)) * doppler;
      for (const { o, m } of v.osc) o.frequency.setTargetAtTime(f * m, t, 0.03);
      v.hiss.gain.setTargetAtTime(0.02 + 0.05 * thr, t, 0.05);
      v.out.gain.setTargetAtTime(p.vol * (0.25 + 0.75 * Math.max(thr, 0.2)) * (isMe ? 1 : 1.4), t, 0.05);
    } else if (v.sampled) {
      const sp = p.sample, f = Math.min(1.05, r.rpmF);
      const idleMix = Math.max(0, Math.min(1, 1 - f / 0.18));
      const drive = sp.rate[0] * Math.pow(sp.rate[1] / sp.rate[0], f) * doppler;
      const idle = (sp.idleRate[0] + (sp.idleRate[1] - sp.idleRate[0]) * Math.min(1, f / 0.18)) * doppler;
      v.driveSrc.playbackRate.setTargetAtTime(drive, t, 0.03);
      v.subSrc.playbackRate.setTargetAtTime(drive * 0.5, t, 0.03);
      if (v.chSrc) v.chSrc.playbackRate.setTargetAtTime(drive * sp.chorus, t, 0.03);
      v.idleSrc.playbackRate.setTargetAtTime(idle, t, 0.03);
      v.idleG.gain.setTargetAtTime(idleMix * (0.8 + 0.2 * load), t, 0.05);
      v.driveG.gain.setTargetAtTime((1 - idleMix) * (0.4 + 0.6 * load) * (v.chSrc ? 0.7 : 1), t, 0.04);
      v.subG.gain.setTargetAtTime((1 - idleMix * 0.7) * sp.sub * (0.45 + 0.55 * load), t, 0.05);
      v.lp.frequency.setTargetAtTime(sp.lp * (0.45 + 0.55 * load) * (0.75 + 0.4 * f), t, 0.04);
      v.out.gain.setTargetAtTime(1, t, 0.05);
      if (p.pops > 0) {
        if (r.lift && r.rpmF > 0.45) {
          const n = Math.round(2 + Math.random() * 4 * p.pops);
          for (let i = 0; i < n; i++) setTimeout(() => this.pop(v.out), 30 + i * (40 + Math.random() * 90));
        }
        if (r.ev === 'up' && p.pops >= 0.6 && Math.random() < 0.6) this.pop(v.out);
        if (r.ev === 'down' && thr < 0.1 && p.pops >= 0.35 && Math.random() < 0.5) setTimeout(() => this.pop(v.out), 60);   // blip on the downshift
        if (thr < 0.1 && r.rpmF > 0.35) { v.popAcc += dt * p.pops * 2 * r.rpmF; if (v.popAcc > Math.random() * 3) { v.popAcc = 0; this.pop(v.out); } }
      }
    } else {
      if (v.node) {
        v.node.parameters.get('rpm').setTargetAtTime(rpm * doppler, t, 0.012);
        v.node.parameters.get('load').setTargetAtTime(load, t, 0.012);
        v.body.frequency.setTargetAtTime(p.body * (0.85 + 0.35 * r.rpmF) * doppler, t, 0.03);
        v.lp.frequency.setTargetAtTime(Math.min(8000, p.bright * (0.3 + 0.7 * load) * (0.5 + 0.6 * r.rpmF)), t, 0.03);
        v.intakeF.frequency.setTargetAtTime((380 + 2400 * r.rpmF) * doppler, t, 0.03);
        v.intake.gain.setTargetAtTime(p.intake * 0.09 * load * (0.25 + r.rpmF), t, 0.03);
        // backfires: lifting off at high revs, crackle on the overrun, "brap" on upshifts
        if (p.pops > 0) {
          if (r.lift && r.rpmF > 0.45) v.node.port.postMessage({ pops: Math.round(2 + Math.random() * 5 * p.pops) });
          if (r.ev === 'up' && p.pops >= 0.6 && Math.random() < 0.7) v.node.port.postMessage({ pops: 1 + (Math.random() < 0.4 ? 1 : 0) });
          if (thr < 0.1 && r.rpmF > 0.35) { v.popAcc += dt * p.pops * 2.5 * r.rpmF; if (v.popAcc > Math.random() * 3) { v.popAcc = 0; v.node.port.postMessage({ pops: 1 }); } }
        }
      } else if (v.osc) {
        const f = (rpm / 60) * (p.fire.length / 2) * doppler;
        for (const { o, m } of v.osc) o.frequency.setTargetAtTime(f * m, t, 0.02);
        v.lp.frequency.setTargetAtTime(p.bright * (0.4 + 0.6 * load), t, 0.03);
      }
      v.out.gain.setTargetAtTime(0.55 + 0.45 * load, t, 0.03);
    }
    if (v.turbo) {
      const want = thr * r.rpmF;
      v.spool = fin(v.spool + (want - v.spool) * Math.min(1, dt * (want > v.spool ? 1.8 : 5)));
      v.turbo.frequency.setTargetAtTime((2400 + 7000 * v.spool) * doppler, t, 0.03);
      v.turboG.gain.setTargetAtTime(0.022 * p.turbo * v.spool * v.spool, t, 0.03);
      if (r.lift && v.spool > 0.45 && isMe) this.blowOff(p.turbo);
    }
    if (v.blow) {
      v.blow.frequency.setTargetAtTime((rpm / 60) * 6.5 * doppler, t, 0.02);
      v.blowG.gain.setTargetAtTime(0.012 + 0.03 * load * r.rpmF, t, 0.03);
    }
    if (isMe && r.ev === 'up' && !p.electric) this.shiftClunk();
    return r;
  }

  blowOff(k) {
    const t = this.t, s = this.src(this.white, false, 1), f = this.filt('bandpass', 3200, 1.2), g = this.gain(0), am = this.gain(0.5);
    const flutter = this.ctx.createOscillator(); flutter.frequency.value = 26; flutter.connect(am.gain);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18 * k, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    f.frequency.setValueAtTime(3600, t); f.frequency.exponentialRampToValueAtTime(1400, t + 0.45);
    this.chain(s, f, am, g, this.sfxG);
    s.start(t, Math.random()); s.stop(t + 0.5); flutter.start(t); flutter.stop(t + 0.5);
  }
  shiftClunk() {
    this.tone(95, 0.06, { vol: 0.06, slide: -30 });
    this.noise(0.04, { vol: 0.05, freq: 1800, type: 'bandpass', q: 3 });
  }

  // ------------------------------------------------------------ one-shots
  out(o) {
    if (!o?.at || !o.game) return this.sfxG;
    const p = this.panner();
    const x = o.at.x ?? 0, z = o.at.z ?? 0;
    p.positionX.value = x; p.positionY.value = (o.at.y ?? 0) + 0.8; p.positionZ.value = z;
    p.connect(this.sfxG);
    setTimeout(() => p.disconnect(), 4000);
    return p;
  }
  tone(freq, dur, { type = 'sine', vol = 0.2, slide = 0, delay = 0, attack = 0.004, dest, curve = 'exp' } = {}) {
    if (!this.ctx) return;
    const t0 = this.t + delay, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + attack);
    if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); else g.gain.linearRampToValueAtTime(0, t0 + dur);
    o.connect(g); g.connect(dest || this.sfxG);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  noise(dur, { vol = 0.3, freq = 1000, q = 1, type = 'lowpass', slide = 0, delay = 0, dest, attack = 0.002, brown = false } = {}) {
    if (!this.ctx) return;
    const t0 = this.t + delay, s = this.src(brown ? this.brown : this.white, false, 0.85 + Math.random() * 0.3), f = this.filt(type, freq, q), g = this.ctx.createGain();
    if (slide) f.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + attack); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    this.chain(s, f, g, dest || this.sfxG);
    s.start(t0, Math.random() * 2); s.stop(t0 + dur + 0.05);
  }
  // metal: a few inharmonic partials ringing out
  metal(vol, dest, base = 900) {
    for (let i = 0; i < 4; i++) this.tone(base * (1 + Math.random() * 2.5), 0.12 + Math.random() * 0.3, { vol: vol * (0.4 + Math.random() * 0.6), dest, attack: 0.001 });
  }
  impact(p, dest) {
    const k = Math.min(1, 0.25 + p / 30);
    this.tone(80, 0.22, { vol: 0.5 * k, slide: -45, dest, attack: 0.002 });
    this.noise(0.16, { vol: 0.45 * k, freq: 1600, q: 0.8, type: 'bandpass', dest, slide: -900 });
    this.noise(0.08, { vol: 0.25 * k, freq: 5000, type: 'highpass', dest });
    if (p > 8) this.metal(0.05 * k, dest, 700 + Math.random() * 600);
  }
  explosion(size, dest) {
    this.tone(58, 1.1, { vol: 0.7 * size, slide: -30, dest, attack: 0.003 });
    this.noise(1.4, { vol: 0.75 * size, freq: 4000, slide: -3850, dest, attack: 0.003 });
    this.noise(0.9, { vol: 0.5 * size, brown: true, freq: 400, dest });
    for (let i = 0; i < 9; i++) this.noise(0.04, { vol: 0.2 * size * Math.random(), freq: 3000 + Math.random() * 4000, type: 'bandpass', q: 2, delay: 0.05 + Math.random() * 0.7, dest });
    this.metal(0.03 * size, dest, 1500);
  }
  crowd(dur = 2.6, vol = 0.18) {
    const t = this.t;
    for (const f of [520, 1150, 2400]) {
      const s = this.src(this.white, false), bp = this.filt('bandpass', f, 1.6), g = this.gain(0), am = this.gain(0.6);
      const lfo = this.ctx.createOscillator(); lfo.frequency.value = 3 + Math.random() * 5;
      const depth = this.gain(0.4); lfo.connect(depth); depth.connect(am.gain);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + 0.35); g.gain.setValueAtTime(vol, t + dur * 0.6); g.gain.linearRampToValueAtTime(0, t + dur);
      this.chain(s, bp, am, g, this.sfxG);
      s.start(t, Math.random()); s.stop(t + dur + 0.1); lfo.start(t); lfo.stop(t + dur + 0.1);
    }
  }
  bell(f, dur, vol, delay = 0) {          // soft FM-ish bell for UI / pickups
    this.tone(f, dur, { vol, delay, attack: 0.003 });
    this.tone(f * 2.76, dur * 0.4, { vol: vol * 0.3, delay, attack: 0.002 });
  }

  sfx(name, o = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    if (o.at && o.game) {
      const ref = o.game.me?.c || o.game.cars?.get(o.game.spectate)?.c;
      if (ref && Math.hypot((o.at.x ?? 0) - ref.x, (o.at.z ?? 0) - ref.z) > 350) return;
    }
    const d = this.out(o);
    switch (name) {
      // race control
      case 'beep': this.tone(880, 0.32, { vol: 0.16 }); this.tone(1760, 0.1, { vol: 0.03 }); break;
      case 'go': this.tone(1320, 0.7, { vol: 0.18 }); this.tone(2640, 0.25, { vol: 0.04 }); this.crowd(1.6, 0.08); break;
      case 'finallap': this.bell(1047, 0.5, 0.12); this.bell(1319, 0.6, 0.12, 0.15); this.bell(1568, 0.9, 0.12, 0.3); break;
      case 'finish': this.crowd(3, 0.16); this.bell(784, 0.8, 0.1); this.bell(1047, 1, 0.1, 0.18); break;
      case 'win': this.crowd(4.5, 0.24); [784, 988, 1175, 1568].forEach((f, i) => this.bell(f, 1.1, 0.1, i * 0.14)); break;
      case 'sector': this.bell(o.color === 'purple' ? 1568 : o.color === 'green' ? 1319 : 988, 0.25, 0.07); break;
      // driving
      case 'boost': this.noise(0.9, { vol: 0.32, freq: 350, slide: 3200, type: 'bandpass', q: 0.7 }); this.noise(0.6, { vol: 0.2, brown: true, freq: 300 }); break;
      case 'mt': this.noise(0.35, { vol: 0.16, freq: 3000, type: 'bandpass', q: 1.5, slide: -1800 }); this.noise(0.7, { vol: 0.12 + 0.06 * (o.tier || 1), freq: 400, slide: 2500, type: 'bandpass', q: 0.7, delay: 0.05 }); break;
      case 'tier': this.tone(1400 + (o.tier || 1) * 300, 0.06, { vol: 0.03 }); break;
      case 'hop': this.noise(0.08, { vol: 0.08, brown: true, freq: 300 }); break;
      case 'perfect': this.tone(1180, 0.07, { vol: 0.05, slide: 600 }); this.tone(2360, 0.05, { vol: 0.015, delay: 0.03 }); break;
      case 'deny': this.tone(150, 0.12, { type: 'square', vol: 0.03 }); break;
      case 'pitin': for (let i = 0; i < 3; i++) this.noise(0.07, { vol: 0.14, freq: 2600, type: 'bandpass', q: 2, delay: 0.25 + i * 0.09 }); break;
      case 'qte': for (let i = 0; i < (o.r === 'perfect' ? 4 : 6); i++) this.noise(0.05, { vol: 0.16, freq: o.r === 'perfect' ? 3200 : 2400, type: 'bandpass', q: 2.5, delay: i * 0.045 }); if (o.r === 'perfect') this.tone(1560, 0.08, { vol: 0.04 }); break;
      case 'pitout': this.noise(0.5, { vol: 0.12, freq: 500, slide: 1800, type: 'bandpass', q: 0.8 }); break;
      case 'land': this.tone(70, 0.25, { vol: 0.35, slide: -30 }); this.noise(0.2, { vol: 0.2, brown: true, freq: 500 }); this.noise(0.18, { vol: 0.06, freq: 1300, type: 'bandpass', q: 6 }); break;
      case 'ramp': this.noise(0.5, { vol: 0.1, freq: 600, slide: 900, type: 'bandpass', q: 0.8 }); break;
      case 'trick': this.noise(0.4, { vol: 0.12, freq: 500, slide: 1500, type: 'bandpass', q: 1 }); break;
      case 'wall': {
        const p = o.p || 6;
        if (this.play(p > 10 ? 'hit' : 'tap', { vol: Math.min(1.2, 0.35 + p / 25), rate: 0.85 + Math.random() * 0.25 })) this.tone(70, 0.2, { vol: Math.min(0.4, p / 40), slide: -35 });
        else { this.impact(p); this.noise(0.4, { vol: Math.min(0.3, p / 50), freq: 2400, type: 'bandpass', q: 2 }); }
        break;
      }
      case 'bump': if (!this.play('tap', { vol: Math.min(1, 0.3 + (o.p || 4) / 25), rate: 0.9 + Math.random() * 0.3 })) this.impact((o.p || 4) * 0.8); break;
      case 'bog': for (let i = 0; i < 4; i++) this.noise(0.09, { vol: 0.2, brown: true, freq: 250, delay: i * 0.13 }); break;
      case 'respawn': this.noise(0.5, { vol: 0.12, freq: 900, slide: 2500, type: 'bandpass', q: 3 }); this.bell(660, 0.4, 0.06, 0.1); break;
      // items
      case 'box': this.noise(0.12, { vol: 0.12, freq: 5000, type: 'highpass' }); [1319, 1760, 2093].forEach((f, i) => this.bell(f, 0.25, 0.05, 0.03 + i * 0.05)); break;
      case 'itemget': this.bell(1175, 0.3, 0.08); this.bell(1760, 0.45, 0.07, 0.08); break;
      case 'fire_bouncer': this.tone(160, 0.15, { vol: 0.35, slide: -80, dest: d }); this.noise(0.25, { vol: 0.15, freq: 1200, slide: -600, type: 'bandpass', dest: d }); break;
      case 'fire_missile': this.noise(0.15, { vol: 0.4, freq: 800, dest: d }); this.noise(1.2, { vol: 0.3, freq: 2200, slide: -1500, type: 'bandpass', q: 0.9, dest: d }); break;
      case 'fire_seeker': this.noise(2, { vol: 0.25, freq: 900, slide: 1500, type: 'bandpass', q: 3, dest: d }); [0, 1, 2, 3].forEach(i => this.tone(i % 2 ? 980 : 760, 0.2, { vol: 0.05, delay: i * 0.22, type: 'triangle' })); break;
      case 'fire_oil': this.tone(110, 0.3, { vol: 0.25, slide: -50, dest: d }); this.noise(0.3, { vol: 0.18, freq: 700, slide: -400, dest: d, delay: 0.05 }); break;
      case 'fire_mine': this.tone(220, 0.08, { vol: 0.2, dest: d }); this.noise(0.06, { vol: 0.12, freq: 2500, type: 'bandpass', dest: d }); break;
      case 'hit':
        if (!this.play('crash', { vol: 0.9, rate: 0.95 + Math.random() * 0.15, dest: d })) this.impact(16, d);
        this.noise(0.9, { vol: 0.25, freq: 1700, type: 'bandpass', q: 5, slide: -700, dest: d, delay: 0.05 });
        break;
      case 'skid': this.noise(1.1, { vol: 0.3, freq: 1250, type: 'bandpass', q: 6, slide: -500, dest: d }); this.tone(900, 0.9, { type: 'sawtooth', vol: 0.03, slide: -300, dest: d }); break;
      case 'boom': this.explosion(1, d); break;
      case 'slam': this.tone(45, 0.9, { vol: 0.7, slide: -20, dest: d }); this.noise(0.6, { vol: 0.5, brown: true, freq: 600, dest: d }); this.noise(0.4, { vol: 0.25, freq: 2000, type: 'bandpass', slide: -1500, dest: d }); break;
      case 'splat': this.noise(0.3, { vol: 0.3, freq: 900, slide: -600, q: 2 }); this.tone(140, 0.2, { vol: 0.2, slide: -80 }); break;
      case 'zap':
        for (let i = 0; i < 10; i++) this.noise(0.05, { vol: 0.35 * Math.random(), freq: 3500, type: 'highpass', delay: i * 0.035 });
        this.noise(2.4, { vol: 0.45, brown: true, freq: 260, delay: 0.25, attack: 0.08 });
        this.tone(42, 1.8, { vol: 0.3, slide: -12, delay: 0.25, attack: 0.05 });
        break;
      case 'emp': this.tone(180, 0.7, { type: 'sawtooth', vol: 0.06, slide: 2400, dest: d }); this.noise(0.5, { vol: 0.25, freq: 3500, type: 'highpass', dest: d, delay: 0.3 }); this.tone(60, 0.6, { vol: 0.4, slide: -25, dest: d, delay: 0.3 }); break;
      case 'grapple': this.noise(0.35, { vol: 0.25, freq: 3500, slide: -2000, type: 'bandpass', q: 4, dest: d }); for (let i = 0; i < 6; i++) this.tone(2500 + Math.random() * 1500, 0.03, { vol: 0.04, delay: i * 0.04, dest: d }); break;
      case 'shield': this.noise(0.8, { vol: 0.12, freq: 2600, type: 'bandpass', q: 8, slide: 1500 }); this.bell(880, 0.8, 0.05); this.bell(1320, 0.8, 0.04, 0.05); break;
      case 'star': this.noise(1.3, { vol: 0.25, freq: 300, slide: 2600, type: 'bandpass', q: 2 }); this.tone(220, 1.3, { type: 'sawtooth', vol: 0.03, slide: 440 }); break;
      case 'swap': this.noise(0.8, { vol: 0.25, freq: 400, slide: 3000, type: 'bandpass', q: 6 }); this.noise(0.8, { vol: 0.2, freq: 3400, slide: -3000, type: 'bandpass', q: 6, delay: 0.1 }); break;
      // UI
      case 'click': this.tone(2200, 0.03, { vol: 0.035 }); break;
      case 'hover': this.tone(3200, 0.02, { vol: 0.012 }); break;
      case 'chat': this.bell(1568, 0.18, 0.05); this.bell(2093, 0.2, 0.04, 0.07); break;
      case 'unlock': [784, 1047, 1319, 1568].forEach((f, i) => this.bell(f, 0.5, 0.07, i * 0.09)); break;
      default:
        if (name.startsWith('abil_')) { this.noise(0.7, { vol: 0.28, freq: 500, slide: 2200, type: 'bandpass', q: 1.5, dest: d }); this.tone(110, 0.5, { vol: 0.25, slide: -40, dest: d }); }
    }
  }

  // ------------------------------------------------------------ per frame
  frame(game, dt) {
    if (!this.ctx) return;
    const t = this.t;
    const me = game?.me && !game.attract && game.session ? game.me : null;
    this.updateListener(game, dt);
    const L = this.loops;
    if (me) {
      const c = me.c;
      if (!this.myVoice) this.myVoice = this.makeVoice(false);
      this.configureVoice(this.myVoice, engineProfile(me.type, me.build));
      const input = game.inp?.throttle || 0;
      const thr = (me.finished ? me.thr ?? 0.75 : input) * (c.stunT > 0 ? 0.2 : 1);   // revving on the grid works too
      try { this.driveVoice(this.myVoice, c, thr, dt, 1, true); } catch (err) { console.warn('engine voice', err); this.myVoice.dt = new EngineTrack(); }
      const sp = Math.abs(c.vf), top = c.spec.top;
      const slide = Math.abs(c.vl || 0);
      const squeal = c.y > 0.3 ? 0 : Math.max(c.drift ? 0.45 + 0.12 * c.driftTier : 0, Math.min(1, (slide - 2.2) / 7), c.stunT > 0 && sp > 6 ? 0.6 : 0, (game.inp?.brake || 0) > 0.5 && sp > 22 ? 0.25 : 0);
      if (this.bank) {
        L.squeal.gain.setTargetAtTime(0, t, 0.05);
        if (squeal > 0.04) {
          if (this.nextGrain < t) this.nextGrain = t;
          while (this.nextGrain < t + 0.1) {
            this.squealGrain(Math.min(1, squeal) * 0.9, 1 + 0.03 * (c.driftTier || 0), this.nextGrain);
            this.nextGrain += 0.06 + Math.random() * 0.03;
          }
        }
      } else L.squeal.gain.setTargetAtTime(0.75 * squeal, t, 0.04);
      L.sqF.frequency.setTargetAtTime(1050 + Math.random() * 250 + c.driftTier * 90, t, 0.06);
      L.sqO1.frequency.setTargetAtTime(760 + Math.random() * 60 + sp * 2, t, 0.05);
      L.sqO2.frequency.setTargetAtTime(1190 + Math.random() * 90, t, 0.05);
      L.road.gain.setTargetAtTime(c.y > 0.3 ? 0.02 : 0.32 * Math.pow(sp / top, 1.3), t, 0.08);
      L.wind.gain.setTargetAtTime(0.16 * Math.pow(sp / (top * 1.2), 2) + (c.y > 0.5 ? 0.05 : 0), t, 0.1);
      const tr = game.track, onKerb = tr && Math.abs(c.lat) > tr.halfW - 0.25 && c.y < 0.2 && sp > 4;
      L.kerb.gain.setTargetAtTime(onKerb ? 0.35 * Math.min(1, sp / 25) : 0, t, 0.03);
      L.kerbLfo.frequency.setTargetAtTime(Math.max(2, sp / 2), t, 0.05);
      L.scrape.gain.setTargetAtTime(c.wallT > 0 && sp > 3 ? 0.18 * Math.min(1, sp / 25) : 0, t, 0.03);
      L.boost.gain.setTargetAtTime(c.boostT > 0 ? 0.12 * (c.boostPow || 1) : 0, t, 0.05);
    } else {
      if (this.myVoice) this.myVoice.out.gain.setTargetAtTime(0, t, 0.1);
      for (const k of ['squeal', 'road', 'wind', 'kerb', 'scrape', 'boost']) L[k].gain.setTargetAtTime(0, t, 0.1);
    }
    this.updateRemotes(game, dt, me);
    this.music(game);
  }

  updateListener(game, dt) {
    const cam = game?.view?.camera;
    const li = this.ctx.listener;
    if (!cam) return;
    const p = cam.position, f = cam.getWorldDirection(this._dir || (this._dir = cam.position.clone()));
    if (li.positionX) {
      const t = this.t;
      li.positionX.setTargetAtTime(p.x, t, 0.02); li.positionY.setTargetAtTime(p.y, t, 0.02); li.positionZ.setTargetAtTime(p.z, t, 0.02);
      li.forwardX.setTargetAtTime(f.x, t, 0.02); li.forwardY.setTargetAtTime(f.y, t, 0.02); li.forwardZ.setTargetAtTime(f.z, t, 0.02);
      li.upX.value = 0; li.upY.value = 1; li.upZ.value = 0;
    } else { li.setPosition(p.x, p.y, p.z); li.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
    if (this.lastCam && dt > 0.004) {
      const vx = (p.x - this.lastCam.x) / dt, vz = (p.z - this.lastCam.z) / dt;
      this.camVel = Math.hypot(vx, vz) < 120 ? { x: vx, z: vz } : { x: 0, z: 0 };   // ignore camera cuts
    }
    this.lastCam = { x: p.x, z: p.z };
  }

  // The three nearest opponents get their own positional engine voices.
  updateRemotes(game, dt, me) {
    const t = this.t;
    const cars = game?.session ? [...game.cars.values()].filter(e => e !== me) : [];
    const cam = this.lastCam;
    const want = cam ? cars.map(e => [e, Math.hypot(e.c.x - cam.x, e.c.z - cam.z)]).filter(([, d]) => d < 160).sort((a, b) => a[1] - b[1]).slice(0, game?.attract ? 2 : 3).map(([e]) => e) : [];
    while (this.remotes.length < want.length) this.remotes.push(this.makeVoice(true));
    // keep existing assignments stable
    const free = this.remotes.filter(v => !want.includes(v.car));
    for (const e of want) if (!this.remotes.some(v => v.car === e)) { const v = free.shift(); if (v) v.car = e; }
    for (const v of this.remotes) {
      const e = v.car;
      if (!e || !want.includes(e)) { v.car = null; v.out.gain.setTargetAtTime(0, t, 0.1); continue; }
      const c = e.c;
      this.configureVoice(v, engineProfile(e.type, e.build));
      v.pan.positionX.setTargetAtTime(c.x, t, 0.02); v.pan.positionY.setTargetAtTime(c.y + 0.6, t, 0.02); v.pan.positionZ.setTargetAtTime(c.z, t, 0.02);
      // Doppler from the closing speed between car and camera
      let dop = 1;
      if (cam) {
        const dx = c.x - cam.x, dz = c.z - cam.z, d = Math.hypot(dx, dz) || 1;
        const vs = (c.vx * dx + c.vz * dz) / d, vl = this.camVel ? (this.camVel.x * dx + this.camVel.z * dz) / d : 0;
        dop = fin(Math.max(0.75, Math.min(1.3, (SPEED_OF_SOUND + vl) / (SPEED_OF_SOUND + vs))), 1);
      }
      const thr = e.thr ?? ((e.flags & 4096) !== 0 ? 0 : 1);
      try { this.driveVoice(v, c, thr, dt, dop, false); } catch (err) { v.dt = new EngineTrack(); v.spool = 0; }
    }
  }

  sessionStart() { this.mood = 'race'; }
  sessionEnd() { this.mood = 'menu'; }

  // ------------------------------------------------------------ music
  // A small drum machine + bass + pad/arp, scheduled 0.2 s ahead.
  music(game) {
    if ((this.settings.music ?? 0.45) <= 0.01) return;
    const race = this.mood === 'race' && game?.session && !game.attract;
    const bpm = race ? 128 : 100, spb = 60 / bpm / 4;
    if (this.nextNote < this.t) this.nextNote = this.t + 0.05;
    const prog = race ? [[45, 57, 60, 64], [41, 53, 57, 60], [43, 55, 59, 62], [40, 52, 55, 59]] : [[45, 57, 60, 64], [48, 55, 60, 64], [43, 55, 59, 62], [41, 53, 57, 60]];
    const dest = this.musG, hz = m => 440 * Math.pow(2, (m - 69) / 12);
    while (this.nextNote < this.t + 0.2) {
      const s = this.step % 64, bar = Math.floor(s / 16), b = s % 16, ch = prog[bar];
      const at = this.nextNote - this.t;
      if (race ? b % 4 === 0 : b === 0 || b === 10) this.kick(at, race ? 0.55 : 0.35);
      if (race && (b === 4 || b === 12)) this.snare(at, 0.3);
      if (b % 2 === 1 || (race && b % 4 === 2)) this.noise(b % 4 === 2 ? 0.12 : 0.035, { vol: race ? 0.06 : 0.03, freq: 7500, type: 'highpass', delay: at, dest });
      if ([0, 3, 6, 8, 11, 14].includes(b)) this.bassNote(hz(ch[0] - 12), spb * 1.7, at, race ? 0.22 : 0.16);
      if (b === 0) for (const n of ch.slice(1)) this.pad(hz(n), spb * 16, at, race ? 0.018 : 0.026);
      const arp = [0, 1, 2, 3, 2, 1, 2, 3];
      if (race && b % 2 === 0) this.tone(hz(ch[1 + (arp[(b / 2) % 8] % 3)] + 12), spb * 1.6, { type: 'triangle', vol: 0.03, delay: at, dest, attack: 0.005 });
      this.nextNote += spb;
      this.step++;
    }
  }
  kick(at, vol) {
    const t0 = this.t + at, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.frequency.setValueAtTime(150, t0); o.frequency.exponentialRampToValueAtTime(42, t0 + 0.12);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.4);
    o.connect(g); g.connect(this.musG); o.start(t0); o.stop(t0 + 0.45);
  }
  snare(at, vol) {
    this.noise(0.18, { vol, freq: 1800, type: 'highpass', delay: at, dest: this.musG });
    this.tone(190, 0.1, { type: 'triangle', vol: vol * 0.6, delay: at, dest: this.musG });
  }
  bassNote(f, dur, at, vol) {
    const t0 = this.t + at, o = this.ctx.createOscillator(), lp = this.filt('lowpass', 900, 4), g = this.ctx.createGain();
    o.type = 'sawtooth'; o.frequency.value = f;
    lp.frequency.setValueAtTime(1400, t0); lp.frequency.exponentialRampToValueAtTime(220, t0 + dur);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    this.chain(o, lp, g, this.musG); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  pad(f, dur, at, vol) {
    const t0 = this.t + at, lp = this.filt('lowpass', 1300, 0.7), g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + dur * 0.25); g.gain.linearRampToValueAtTime(0, t0 + dur);
    this.chain(lp, g, this.musG);
    for (const det of [-7, 0, 7]) {
      const o = this.ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      o.connect(lp); o.start(t0); o.stop(t0 + dur + 0.05);
    }
  }
}
