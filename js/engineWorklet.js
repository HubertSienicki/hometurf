// AudioWorklet engine synthesizer. Models a 4-stroke engine as a train of
// combustion pulses: each cylinder fires at its own point in the 720-degree
// cycle, producing a decaying burst (tone + combustion noise) with a little
// cycle-to-cycle variation. The rest of the "car" (exhaust resonance, intake,
// turbo, saturation) is built from regular WebAudio nodes in audio.js.
class EngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'rpm', defaultValue: 900, minValue: 0, maxValue: 30000, automationRate: 'k-rate' },
      { name: 'load', defaultValue: 0.2, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    this.configure(options.processorOptions || {});
    this.phase = Math.random();
    this.env = new Float32Array(16);
    this.jit = new Float32Array(16);
    this.seed = (Math.random() * 4294967295) >>> 0;
    this.popQueue = 0; this.popWait = 0; this.pop = 0;
    this.kn = 0;
    this.port.onmessage = e => {
      const d = e.data;
      if (d.profile) this.configure(d.profile);
      if (d.pops) this.popQueue = Math.min(12, this.popQueue + d.pops);
    };
  }

  configure(p) {
    this.fire = p.fire || [0, 0.25, 0.5, 0.75];      // firing points as fractions of the cycle
    this.amp = p.amp || this.fire.map(() => 1);       // per-cylinder loudness (bank / header differences)
    this.noise = p.noise ?? 0.3;                      // combustion noise vs. clean pulse
    this.decay = p.decay ?? 6;                        // pulse decay per firing interval
    this.jitter = p.jitter ?? 0.005;                  // timing wobble (fraction of a cycle)
    this.ampVar = p.ampVar ?? 0.18;                   // cycle-to-cycle strength variation
    this.knock = p.knock ?? 0;                        // diesel clatter
  }

  rnd() {
    let t = (this.seed = (this.seed + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  process(_inputs, outputs, params) {
    const out = outputs[0], ch = out[0];
    if (!ch) return true;
    const rpm = Math.max(30, params.rpm[0]), load = params.load[0];
    const cyc = rpm / 120;                               // 4-stroke: one cycle per two revolutions
    const dph = cyc / sampleRate;
    const n = this.fire.length;
    const interval = sampleRate / (cyc * n);             // samples between firings
    const k = Math.exp(-this.decay / interval);
    const strength = 0.16 + 0.84 * load;
    const knockK = Math.exp(-1 / (0.0016 * sampleRate));
    for (let i = 0; i < ch.length; i++) {
      const prev = this.phase;
      let ph = prev + dph;
      if (ph >= 1) ph -= 1;
      this.phase = ph;
      for (let c = 0; c < n; c++) {
        let f = this.fire[c] + this.jit[c];
        if (f >= 1) f -= 1; else if (f < 0) f += 1;
        const hit = ph >= prev ? f > prev && f <= ph : f > prev || f <= ph;
        if (hit) {
          this.env[c] = strength * this.amp[c] * (1 - this.ampVar * 0.5 + this.ampVar * this.rnd());
          this.jit[c] = (this.rnd() - 0.5) * this.jitter;
          if (this.knock) this.kn = this.knock * (0.6 + 0.8 * this.rnd());
        }
      }
      let s = 0;
      for (let c = 0; c < n; c++) {
        const e = this.env[c];
        if (e > 1e-5) {
          s += e * (1 - this.noise + this.noise * (this.rnd() * 2 - 1));
          this.env[c] = e * k;
        }
      }
      // diesel clatter: a sharp click riding on every combustion
      if (this.kn > 1e-4) { s += this.kn * (this.rnd() * 2 - 1); this.kn *= knockK; }
      // overrun backfires: short, loud cracks of unburnt fuel in the exhaust
      if (this.popQueue > 0) {
        if (this.popWait <= 0) {
          this.pop = 1.2 + this.rnd() * 1.4;
          this.popQueue--;
          this.popWait = (0.025 + this.rnd() * 0.14) * sampleRate;
        } else this.popWait--;
      }
      if (this.pop > 1e-4) { s += this.pop * (this.rnd() * 2 - 1); this.pop *= 0.9955; }
      ch[i] = s;
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch);
    return true;
  }
}
registerProcessor('ht-engine', EngineProcessor);
