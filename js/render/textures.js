// Procedural canvas textures. Everything is generated at runtime, so the game
// ships without image assets.
import * as THREE from 'three';
import { mulberry32 } from '../sim/util.js';

const cache = new Map();
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }
function tex(key, make, opts = {}) {
  if (cache.has(key)) return cache.get(key);
  const c = make();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = opts.clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  t.anisotropy = opts.aniso ?? 8;
  if (opts.nearest) { t.magFilter = THREE.NearestFilter; }
  cache.set(key, t);
  return t;
}
function noise(g, w, h, base, amp, n, seed = 1) {
  const r = mulberry32(seed);
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = (r() - 0.5) * amp;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    const s = 1 + r() * 2.5;
    g.fillRect(r() * w, r() * h, s, s);
  }
}

// Track surface: u across the road (0..1), v along it (one repeat = 12 m).
export const asphalt = () => tex('asphalt', () => {
  const [c, g] = canvas(256, 512);
  noise(g, 256, 512, '#3b3e45', 0.22, 9000, 3);
  // tyre-worn racing line shading
  const grd = g.createLinearGradient(0, 0, 256, 0);
  grd.addColorStop(0, 'rgba(0,0,0,0)'); grd.addColorStop(0.3, 'rgba(0,0,0,0.12)'); grd.addColorStop(0.5, 'rgba(0,0,0,0.05)');
  grd.addColorStop(0.7, 'rgba(0,0,0,0.12)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 256, 512);
  g.fillStyle = '#e9e9e2';
  g.fillRect(6, 0, 7, 512); g.fillRect(243, 0, 7, 512);
  g.fillStyle = '#f2d34a';
  g.fillRect(124, 0, 8, 256);
  return c;
});
export const asphaltPlain = () => tex('asphaltPlain', () => {
  const [c, g] = canvas(256, 256);
  noise(g, 256, 256, '#44474d', 0.18, 5000, 5);
  return c;
});
export const groundTex = color => tex('ground' + color, () => {
  const [c, g] = canvas(512, 512);
  noise(g, 512, 512, color, 0.12, 22000, 9);
  const r = mulberry32(2);
  for (let i = 0; i < 70; i++) {
    g.fillStyle = `rgba(0,0,0,${0.02 + r() * 0.04})`;
    g.beginPath(); g.arc(r() * 512, r() * 512, 20 + r() * 60, 0, Math.PI * 2); g.fill();
  }
  return c;
});
export const concrete = () => tex('concrete', () => {
  const [c, g] = canvas(256, 256);
  noise(g, 256, 256, '#b9b6ae', 0.12, 6000, 11);
  g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 2;
  for (let i = 0; i <= 256; i += 64) { g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke(); }
  return c;
});

// Building facade tile = 8 m wide x 12 m tall (4 windows x 4 floors).
// White walls (tinted by vertex colour) with glass; the emissive twin lights
// random windows for night scenes.
export const facade = () => tex('facade', () => {
  const [c, g] = canvas(256, 384);
  noise(g, 256, 384, '#efefef', 0.08, 3000, 21);
  for (let fy = 0; fy < 4; fy++) for (let fx = 0; fx < 4; fx++) {
    const x = fx * 64 + 14, y = fy * 96 + 22;
    g.fillStyle = '#9aa3ad'; g.fillRect(x - 3, y - 3, 42, 58);
    const grd = g.createLinearGradient(x, y, x + 36, y + 52);
    grd.addColorStop(0, '#2c3d52'); grd.addColorStop(0.55, '#4d6b8a'); grd.addColorStop(1, '#1d2633');
    g.fillStyle = grd; g.fillRect(x, y, 36, 52);
    g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x + 17, y, 2, 52);
  }
  g.fillStyle = 'rgba(0,0,0,0.12)';
  for (let fy = 1; fy < 4; fy++) g.fillRect(0, fy * 96 - 2, 256, 4);
  return c;
});
export const facadeLit = () => tex('facadeLit', () => {
  const [c, g] = canvas(256, 384);
  g.fillStyle = '#000'; g.fillRect(0, 0, 256, 384);
  const r = mulberry32(77);
  for (let fy = 0; fy < 4; fy++) for (let fx = 0; fx < 4; fx++) {
    if (r() < 0.42) continue;
    const x = fx * 64 + 14, y = fy * 96 + 22;
    const warm = r() < 0.8;
    g.fillStyle = warm ? `hsl(${38 + r() * 12},90%,${55 + r() * 15}%)` : `hsl(200,70%,${60 + r() * 15}%)`;
    g.fillRect(x, y, 36, 52);
  }
  return c;
});
export const roofTex = () => tex('roof', () => {
  const [c, g] = canvas(128, 128);
  noise(g, 128, 128, '#cfcfcf', 0.2, 2000, 31);
  return c;
});

export const checker = () => tex('checker', () => {
  const [c, g] = canvas(256, 32);
  for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) {
    g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4';
    g.fillRect(x * 16, y * 16, 16, 16);
  }
  return c;
}, { nearest: true });

export const boxFace = () => tex('boxFace', () => {
  const [c, g] = canvas(128, 128);
  g.clearRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 8;
  g.beginPath(); g.roundRect(8, 8, 112, 112, 18); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.15)'; g.fill();
  g.fillStyle = '#fff'; g.font = 'bold 84px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('?', 64, 70);
  return c;
}, { clamp: true });
export const mineFace = () => tex('mineFace', () => {
  const [c, g] = canvas(128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 8;
  g.beginPath(); g.roundRect(8, 8, 112, 112, 18); g.stroke();
  g.fillStyle = 'rgba(255,255,255,0.15)'; g.fill();
  g.save(); g.translate(64, 64); g.rotate(Math.PI);
  g.fillStyle = '#fff'; g.font = 'bold 84px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('?', 0, -6);
  g.restore();
  return c;
}, { clamp: true });

export const chevrons = () => tex('chevrons', () => {
  const [c, g] = canvas(128, 256);
  g.fillStyle = '#ff7a1a'; g.fillRect(0, 0, 128, 256);
  g.fillStyle = '#ffd84a';
  for (let i = 0; i < 2; i++) {
    const y = i * 128;
    g.beginPath(); g.moveTo(10, y + 100); g.lineTo(64, y + 30); g.lineTo(118, y + 100); g.lineTo(118, y + 128); g.lineTo(64, y + 58); g.lineTo(10, y + 128); g.closePath(); g.fill();
  }
  return c;
});
export const hazard = () => tex('hazard', () => {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#ffcc1f'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#1b1b1b';
  for (let i = -128; i < 256; i += 48) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 24, 0); g.lineTo(i + 24 + 128, 128); g.lineTo(i + 128, 128); g.closePath(); g.fill(); }
  return c;
});
export const cornerSign = () => tex('cornerSign', () => {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#ffd21f'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#121212';
  g.beginPath(); g.moveTo(30, 14); g.lineTo(78, 64); g.lineTo(30, 114); g.lineTo(54, 114); g.lineTo(102, 64); g.lineTo(54, 14); g.closePath(); g.fill();
  g.strokeStyle = '#121212'; g.lineWidth = 6; g.strokeRect(3, 3, 122, 122);
  return c;
}, { clamp: true });

export const banner = (text, bg = '#11131c', fg = '#ffd23f') => tex('banner' + text + bg + fg, () => {
  const [c, g] = canvas(1024, 128);
  g.fillStyle = bg; g.fillRect(0, 0, 1024, 128);
  g.fillStyle = '#ff6b2c'; g.fillRect(0, 0, 1024, 10); g.fillRect(0, 118, 1024, 10);
  g.fillStyle = fg; g.font = '900 78px "Bungee", "Arial Black", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 512, 68);
  return c;
}, { clamp: true });

// Floating course markers: item-box row (rainbow "?") and boost pad (chevrons).
export const markerIcon = kind => tex('marker' + kind, () => {
  const [c, g] = canvas(128, 128);
  g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 8;
  if (kind === 'box') {
    const grd = g.createLinearGradient(16, 16, 112, 112);
    ['#ff3d7f', '#ffd23f', '#3ddc84', '#29d8ff', '#b06bff'].forEach((col, i) => grd.addColorStop(i / 4, col));
    g.fillStyle = grd; g.beginPath(); g.roundRect(18, 18, 92, 92, 20); g.fill();
    g.lineWidth = 7; g.strokeStyle = '#fff'; g.stroke();
    g.shadowBlur = 0; g.fillStyle = '#fff'; g.font = '900 66px Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('?', 64, 68);
  } else {
    g.fillStyle = '#ff7a1a'; g.beginPath(); g.arc(64, 64, 48, 0, Math.PI * 2); g.fill();
    g.lineWidth = 7; g.strokeStyle = '#fff'; g.stroke();
    g.shadowBlur = 0; g.fillStyle = '#fff';
    for (const y of [70, 92]) { g.beginPath(); g.moveTo(34, y); g.lineTo(64, y - 28); g.lineTo(94, y); g.lineTo(94, y - 12); g.lineTo(64, y - 40); g.lineTo(34, y - 12); g.closePath(); g.fill(); }
  }
  return c;
}, { clamp: true });

// Vertical light beam: bright at the base, fading out upwards.
export const beam = () => tex('beam', () => {
  const [c, g] = canvas(8, 128);
  const grd = g.createLinearGradient(0, 128, 0, 0);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.45)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 8, 128);
  return c;
}, { clamp: true, linear: true });

export const glowDisc = () => tex('glowDisc', () => {
  const [c, g] = canvas(128, 128);
  const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.35, 'rgba(255,255,255,0.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return c;
}, { clamp: true, linear: true });

export const carbon = () => tex('carbon', () => {
  const [c, g] = canvas(64, 64);
  g.fillStyle = '#1a1b1f'; g.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    g.fillStyle = (x + y) % 2 ? '#2a2c33' : '#141518';
    g.fillRect(x * 8, y * 8, 8, 8);
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x * 8, y * 8, 8, 2);
  }
  return c;
});

export const flamesDecal = color => tex('flames' + color, () => {
  const [c, g] = canvas(512, 128);
  g.clearRect(0, 0, 512, 128);
  const r = mulberry32(5);
  const draw = (col, s) => {
    g.fillStyle = col;
    g.beginPath(); g.moveTo(512, 20 * s + 50);
    let x = 512;
    for (let i = 0; i < 6; i++) {
      const len = 80 + r() * 90, y = 18 + r() * 92;
      g.quadraticCurveTo(x - len * 0.5, y - 26 * s, x - len, y);
      g.quadraticCurveTo(x - len * 0.6, y + 14 * s, x - 30, 64 + (r() - 0.5) * 40);
      x -= 20;
    }
    g.lineTo(512, 110); g.closePath(); g.fill();
  };
  draw(color, 1); draw('rgba(255,230,120,0.9)', 0.6);
  return c;
}, { clamp: true });

export const numberDecal = (n, color) => tex('num' + n + color, () => {
  const [c, g] = canvas(128, 128);
  g.fillStyle = '#f7f7f7'; g.beginPath(); g.arc(64, 64, 58, 0, Math.PI * 2); g.fill();
  g.lineWidth = 8; g.strokeStyle = color; g.stroke();
  g.fillStyle = '#111'; g.font = '900 64px "Bungee", "Arial Black", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(n), 64, 70);
  return c;
}, { clamp: true });

export const checkerDecal = () => tex('checkerDecal', () => {
  const [c, g] = canvas(256, 32);
  for (let x = 0; x < 16; x++) for (let y = 0; y < 2; y++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x * 16, y * 16, 16, 16); }
  return c;
}, { nearest: true, clamp: true });

export function nameTag(name, color, pos = '') {
  const [c, g] = canvas(256, 64);
  g.font = '700 26px "Rubik", Arial, sans-serif';
  const w = Math.min(250, g.measureText(name).width + 46);
  const x0 = (256 - w) / 2;
  g.fillStyle = 'rgba(10,12,20,0.72)';
  g.beginPath(); g.roundRect(x0, 12, w, 40, 20); g.fill();
  g.fillStyle = color; g.beginPath(); g.arc(x0 + 20, 32, 8, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(name, x0 + 34, 33);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function crowdTex() {
  return tex('crowd', () => {
    const [c, g] = canvas(256, 64);
    g.fillStyle = '#3a3f4c'; g.fillRect(0, 0, 256, 64);
    const r = mulberry32(8);
    for (let i = 0; i < 260; i++) {
      g.fillStyle = `hsl(${r() * 360},70%,${45 + r() * 25}%)`;
      g.beginPath(); g.arc(r() * 256, r() * 64, 2.5 + r() * 2, 0, Math.PI * 2); g.fill();
    }
    return c;
  });
}
