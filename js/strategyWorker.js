// Simulates tyre strategies off the main thread (sim/strategy.js).
import { simulateTyres, planStrategies } from './sim/strategy.js';

self.onmessage = e => {
  const { id, track, type, build, laps, wear, equalize } = e.data;
  try {
    const sim = simulateTyres(track, type, build, { laps, wear, equalize });
    self.postMessage({ id, sim, plans: planStrategies(sim, laps) });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
