// Small math / formatting helpers shared by everything.
export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export const smooth01 = t => t * t * (3 - 2 * t);
export function wrapAngle(a) {
  a %= TAU;
  if (a > Math.PI) a -= TAU; else if (a < -Math.PI) a += TAU;
  return a;
}
export const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
export const dampAngle = (a, b, lambda, dt) => lerpAngle(a, b, 1 - Math.exp(-lambda * dt));

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function pickWeighted(rng, entries) {
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = rng() * total;
  for (const [k, w] of entries) { if ((r -= w) <= 0) return k; }
  return entries[entries.length - 1][0];
}

export function fmtTime(ms, withMs = true) {
  if (ms == null || !isFinite(ms)) return '-:--.---';
  const neg = ms < 0; ms = Math.abs(ms);
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), x = Math.floor(ms % 1000);
  const core = `${m}:${String(s).padStart(2, '0')}` + (withMs ? `.${String(x).padStart(3, '0')}` : '');
  return (neg ? '-' : '') + core;
}
export function fmtGap(ms) {
  if (ms == null || !isFinite(ms)) return '';
  const s = ms / 1000;
  return (s >= 0 ? '+' : '-') + Math.abs(s).toFixed(3);
}
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}
export const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
