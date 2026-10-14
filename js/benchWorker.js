// Runs Test Bench simulations off the main thread.
import { runBench } from './sim/bench.js';

self.onmessage = e => {
  const { id, track, type, build, compare, equalize } = e.data;
  try {
    const res = runBench(track, type, build, equalize);
    const ref = compare ? runBench(track, type, compare, equalize) : null;
    self.postMessage({ id, res, ref });
  } catch (err) {
    self.postMessage({ id, error: String(err && err.message || err) });
  }
};
