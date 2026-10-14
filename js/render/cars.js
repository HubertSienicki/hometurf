// Procedural car models. Bodies are side profiles extruded across the car's
// width with wheel arches cut out; every part slot changes the model.
// Local frame: +z forward, +y up, x across (left = +x).
import * as THREE from 'three';
import * as TX from './textures.js';
import { sanitizeBuild } from '../sim/parts.js';
import { hashString } from '../sim/util.js';

// top: silhouette from rear-bottom over the roof to front-bottom (z, y)
// glass: side window polygon; shield: windshield/rear-window polygon (slightly proud of the body)
export const BODIES = {
  comet: { W: 1.86, r: 0.36, tw: 0.3, zF: 1.28, zR: -1.28, yb: 0.36, belt: 0.86,
    top: [[-1.98, 0.36], [-2.03, 0.82], [-1.9, 1.02], [-1.52, 1.46], [0.1, 1.53], [0.92, 1.04], [1.85, 0.9], [2.03, 0.66], [2.0, 0.36]],
    glass: [[-1.5, 1.08], [-1.38, 1.4], [0.06, 1.46], [0.78, 1.06]], wing: [-1.6, 1.46], nose: [2.02, 0.4], hood: [1.38, 0.97, 0.14], roof: [-1.4, 0.05, 1.53] },
  viper: { W: 1.98, r: 0.36, tw: 0.34, zF: 1.42, zR: -1.38, yb: 0.32, belt: 0.72,
    top: [[-2.22, 0.32], [-2.27, 0.78], [-1.7, 0.93], [-0.95, 0.99], [-0.42, 1.2], [0.36, 1.19], [1.02, 0.85], [2.02, 0.62], [2.3, 0.46], [2.28, 0.32]],
    glass: [[-0.88, 0.98], [-0.38, 1.16], [0.32, 1.15], [0.95, 0.86]], wing: [-1.95, 0.9], nose: [2.28, 0.34], hood: [1.55, 0.74, 0.22], roof: [-0.35, 0.3, 1.2] },
  pixie: { W: 1.62, r: 0.3, tw: 0.26, zF: 0.98, zR: -0.95, yb: 0.32, belt: 0.88,
    top: [[-1.46, 0.32], [-1.53, 0.86], [-1.32, 1.36], [-0.72, 1.72], [0.22, 1.74], [0.88, 1.42], [1.36, 0.96], [1.53, 0.62], [1.5, 0.32]],
    glass: [[-1.12, 1.12], [-0.72, 1.56], [0.24, 1.58], [0.86, 1.18]], wing: [-1.3, 1.34], nose: [1.52, 0.34], hood: [1.18, 1.08, 0.55], roof: [-0.6, 0.15, 1.73] },
  hornet: { W: 1.84, r: 0.38, tw: 0.3, zF: 1.3, zR: -1.3, yb: 0.42, belt: 0.95,
    top: [[-1.95, 0.42], [-2.0, 0.96], [-1.86, 1.12], [-1.56, 1.58], [0.06, 1.62], [0.88, 1.12], [1.86, 0.98], [2.03, 0.74], [2.0, 0.42]],
    glass: [[-1.52, 1.16], [-1.4, 1.52], [0.02, 1.56], [0.75, 1.14]], wing: [-1.66, 1.58], nose: [2.02, 0.44], hood: [1.38, 1.05, 0.14], roof: [-1.45, 0.0, 1.62] },
  brute: { W: 2.0, r: 0.4, tw: 0.32, zF: 1.45, zR: -1.45, yb: 0.4, belt: 1.25,
    top: [[-2.2, 0.4], [-2.23, 2.02], [1.0, 2.08], [1.55, 1.46], [2.15, 1.16], [2.26, 0.86], [2.22, 0.4]],
    glass: [[0.32, 1.38], [0.32, 1.92], [0.98, 1.96], [1.44, 1.46]], wing: [-2.1, 2.04], nose: [2.24, 0.42], hood: [1.86, 1.3, 0.45], roof: [-2.0, 0.9, 2.06] },
  mudcat: { W: 1.72, r: 0.48, tw: 0.4, zF: 1.28, zR: -1.22, yb: 0.62, belt: 0.86, wide: 0.16,
    top: [[-1.62, 0.62], [-1.72, 0.96], [-1.3, 1.06], [0.5, 1.02], [1.6, 0.82], [1.82, 0.62]],
    glass: null, wing: [-1.55, 1.12], nose: [1.82, 0.62], hood: [1.05, 0.95, 0.15], roof: [-1.15, 0.45, 1.05], open: true },
  titan: { W: 2.1, r: 0.74, tw: 0.58, zF: 1.48, zR: -1.5, yb: 0.98, belt: 1.45, wide: 0.22, ride: 0.35,
    top: [[-2.3, 0.98], [-2.32, 1.66], [-0.36, 1.66], [-0.26, 2.46], [0.96, 2.49], [1.5, 1.8], [2.3, 1.68], [2.36, 1.32], [2.3, 0.98]],
    glass: [[-0.2, 1.72], [-0.14, 2.36], [0.9, 2.38], [1.38, 1.8]], wing: [-2.2, 1.66], nose: [2.33, 1.02], hood: [1.9, 1.7, 0.1], roof: [-0.2, 0.9, 2.48] },
  volt: { W: 1.9, r: 0.37, tw: 0.3, zF: 1.42, zR: -1.38, yb: 0.36, belt: 0.86,
    top: [[-2.15, 0.36], [-2.2, 0.86], [-1.62, 1.02], [-1.0, 1.43], [0.45, 1.48], [1.26, 1.0], [2.1, 0.84], [2.25, 0.6], [2.22, 0.36]],
    glass: [[-0.96, 1.06], [-0.88, 1.38], [0.42, 1.43], [1.14, 1.02]], wing: [-2.05, 0.9], nose: [2.23, 0.38], hood: [1.68, 0.92, 0.15], roof: [-0.95, 0.4, 1.47] },
};

const sharedGeo = new Map();
const G = (k, f) => { if (!sharedGeo.has(k)) sharedGeo.set(k, f()); return sharedGeo.get(k); };

function profileShape(B) {
  const s = new THREE.Shape();
  const top = B.top;
  s.moveTo(top[0][0], top[0][1]);
  for (let i = 1; i < top.length; i++) s.lineTo(top[i][0], top[i][1]);
  // bottom edge from the front back to the rear, with arches over both wheels
  const ra = B.r + 0.07, yb = B.yb;
  const arch = zc => {
    const s0 = Math.max(-1, Math.min(1, (yb - B.r) / ra));
    const t0 = Math.asin(s0);
    for (let k = 0; k <= 10; k++) {
      const t = t0 + (Math.PI - 2 * t0) * k / 10;
      s.lineTo(zc + ra * Math.cos(t), B.r + ra * Math.sin(t));
    }
  };
  if (B.yb < B.r + ra - 0.02) { arch(B.zF); arch(B.zR); }
  s.lineTo(top[0][0], top[0][1]);
  return s;
}

function extrudeSide(shape, width, bevel = 0.06) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(0.05, width - bevel * 2), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 4 });
  g.rotateY(-Math.PI / 2);
  g.translate(width / 2 - bevel, 0, 0);
  g.computeVertexNormals();
  return g;
}
function polyShape(pts) { const s = new THREE.Shape(); s.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) s.lineTo(p[0], p[1]); s.closePath(); return s; }

function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(G(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)), mat);
  m.position.set(x, y, z);
  return m;
}
function cyl(r, len, mat, seg = 10) { return new THREE.Mesh(G(`c${r},${len},${seg}`, () => new THREE.CylinderGeometry(r, r, len, seg)), mat); }
function tube(a, b, r, mat) {
  const A = new THREE.Vector3(...a), Bv = new THREE.Vector3(...b);
  const len = A.distanceTo(Bv);
  const m = cyl(r, len, mat, 8);
  m.position.copy(A).add(Bv).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), Bv.clone().sub(A).normalize());
  return m;
}
// profile height at z (top silhouette)
function topY(B, z) {
  const t = B.top;
  let best = 0;
  for (let i = 0; i + 1 < t.length; i++) {
    const a = t[i], b = t[i + 1];
    if ((z - a[0]) * (z - b[0]) <= 0 && a[0] !== b[0]) best = Math.max(best, a[1] + (b[1] - a[1]) * (z - a[0]) / (b[0] - a[0]));
  }
  return best;
}

export function buildCar(type, color, buildIn, opts = {}) {
  const B = BODIES[type] || BODIES.comet;
  const build = sanitizeBuild(type, buildIn);
  const accent = build.accent || '#f1f1f1';
  const root = new THREE.Group();
  const body = new THREE.Group();     // rolls / pitches
  root.add(body);
  const mats = {
    paint: new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.32 }),
    accent: new THREE.MeshStandardMaterial({ color: accent, metalness: 0.3, roughness: 0.35 }),
    trim: new THREE.MeshStandardMaterial({ color: 0x1b1d22, metalness: 0.2, roughness: 0.6 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x0f1a26, metalness: 0.7, roughness: 0.08 }),
    chrome: new THREE.MeshStandardMaterial({ color: 0xdfe4ea, metalness: 1, roughness: 0.18 }),
    tire: new THREE.MeshStandardMaterial({ color: 0x18191c, roughness: 0.92 }),
    rim: new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.85, roughness: 0.3 }),
    head: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d8, emissiveIntensity: 1.2 }),
    tail: new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a1a, emissiveIntensity: 0.6 }),
    carbon: new THREE.MeshStandardMaterial({ map: TX.carbon(), metalness: 0.4, roughness: 0.35 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x0b0c0f, roughness: 0.8 }),
    ti: new THREE.MeshStandardMaterial({ color: 0x8f7fe0, metalness: 1, roughness: 0.22 }),
  };
  const cast = opts.shadows !== false;
  const add = (m, parent = body) => { m.castShadow = cast; parent.add(m); return m; };
  const ride = (B.ride || 0) + ({ lowered: -0.08, lifted: 0.32, rally: 0.08 }[build.susp] || 0);
  body.position.y = ride;
  const half = B.W / 2;

  // ---- shell + glass
  add(new THREE.Mesh(extrudeSide(profileShape(B), B.W), mats.paint));
  if (B.glass) {
    add(new THREE.Mesh(extrudeSide(polyShape(B.glass), B.W + 0.03, 0.02), mats.glass));
    // windshield / rear glass: polygon pushed slightly outside the roofline, narrower than the body
    const g = B.glass, c = g.reduce((a, p) => [a[0] + p[0] / g.length, a[1] + p[1] / g.length], [0, 0]);
    const proud = g.map(p => [c[0] + (p[0] - c[0]) * 1.06, c[1] + (p[1] - c[1]) * 1.07]);
    add(new THREE.Mesh(extrudeSide(polyShape(proud), B.W - 0.26, 0.02), mats.glass));
  }
  // lights
  const [nz, ny] = B.nose;
  for (const s of [-1, 1]) {
    add(box(0.42, 0.14, 0.06, mats.head, s * (half - 0.33), Math.max(ny + 0.32, topY(B, nz - 0.1) - 0.16), nz - 0.02));
    add(box(0.38, 0.12, 0.06, mats.tail, s * (half - 0.3), Math.max(B.top[0][1] + 0.35, topY(B, B.top[0][0] + 0.1) - 0.2), B.top[0][0] - 0.03));
  }
  add(box(B.W * 0.55, 0.16, 0.05, mats.trim, 0, ny + 0.12, nz + 0.01));   // grille

  // ---- body-specific character
  if (type === 'hornet') {
    add(box(0.6, 0.12, 0.7, mats.paint, 0, B.roof[2] + 0.05, -0.6));
    add(box(1.2, 0.18, 0.12, mats.trim, 0, 1.06, 2.0));
    for (let k = 0; k < 4; k++) add(box(0.18, 0.18, 0.04, mats.head, (k - 1.5) * 0.28, 1.06, 2.07));
    for (const s of [-1, 1]) add(box(0.36, 0.3, 0.02, mats.dark, s * (half - 0.25), 0.3, B.zR - 0.5));
  }
  if (type === 'mudcat') {
    const t = mats.trim, r = 0.045, y0 = 1.0, yt = 1.75, zf = 0.35, zr = -0.9, x = half - 0.15;
    for (const s of [-1, 1]) {
      add(tube([s * x, y0, zf], [s * x * 0.85, yt, zf - 0.25], r, t));
      add(tube([s * x, y0, zr], [s * x * 0.85, yt, zr + 0.1], r, t));
      add(tube([s * x * 0.85, yt, zf - 0.25], [s * x * 0.85, yt, zr + 0.1], r, t));
    }
    add(tube([x * 0.85, yt, zf - 0.25], [-x * 0.85, yt, zf - 0.25], r, t));
    add(tube([x * 0.85, yt, zr + 0.1], [-x * 0.85, yt, zr + 0.1], r, t));
    const helm = new THREE.Mesh(G('helm', () => new THREE.SphereGeometry(0.24, 12, 10)), mats.accent);
    helm.position.set(0.25, 1.35, -0.25); add(helm);
    const spare = new THREE.Mesh(G('spare', () => new THREE.TorusGeometry(0.33, 0.13, 8, 14)), mats.tire);
    spare.position.set(0, 1.12, -1.55); spare.rotation.x = Math.PI / 2.3; add(spare);
    add(box(B.W - 0.3, 0.06, 1.4, mats.dark, 0, 1.0, -0.3));
  }
  if (type === 'titan') {
    add(box(1.5, 0.14, 0.24, mats.trim, 0, B.roof[2] + 0.1, 0.7));
    for (let k = 0; k < 5; k++) add(box(0.2, 0.18, 0.04, mats.head, (k - 2) * 0.3, B.roof[2] + 0.1, 0.83));
    add(box(B.W - 0.2, 0.08, 1.8, mats.dark, 0, 1.64, -1.3));       // bed floor
  }
  if (type === 'volt') {
    add(box(B.W - 0.3, 0.05, 0.04, new THREE.MeshBasicMaterial({ color: 0x55e3ff, toneMapped: false }), 0, 0.82, 2.2));
    add(box(B.W - 0.3, 0.05, 0.04, new THREE.MeshBasicMaterial({ color: 0xff3355, toneMapped: false }), 0, 0.84, -2.18));
  }
  if (type === 'viper') for (const s of [-1, 1]) add(box(0.06, 0.24, 0.7, mats.dark, s * (half + 0.01), 0.62, -0.75));
  if (type === 'pixie') for (const s of [-1, 1]) {
    const hl = new THREE.Mesh(G('pixHL', () => new THREE.CircleGeometry(0.17, 16)), mats.head);
    hl.position.set(s * 0.52, 0.86, 1.43); hl.rotation.x = -0.55; add(hl);
  }
  if (type === 'brute') add(box(1.6, 0.08, 2.4, mats.trim, 0, 2.12, -0.6));

  // ---- engine character
  const hoodBusy = build.hood === 'scoop' || build.hood === 'blower';
  const [hz, hy, hp] = B.hood;
  const onHood = (m, dy = 0) => { m.position.set(m.position.x, hy + dy + m.position.y, hz + m.position.z); m.rotation.x = -hp; return add(m); };
  if (!hoodBusy && build.engine === 'v8') onHood(box(0.5, 0.12, 0.9, mats.paint), 0.04);
  if (!hoodBusy && build.engine === 'v12') { const a = box(0.22, 0.1, 0.9, mats.paint, -0.25); const b = box(0.22, 0.1, 0.9, mats.paint, 0.25); onHood(a, 0.03); onHood(b, 0.03); }
  if (build.engine === 'turbo') add(box(B.W * 0.5, 0.2, 0.04, mats.chrome, 0, ny + 0.12, nz + 0.03));
  if (build.engine === 'diesel') {
    const st = cyl(0.07, 1.4, mats.chrome); st.position.set(-half + 0.1, topY(B, B.roof[0]) + 0.3, B.roof[0] - 0.05); add(st);
  }
  if (build.engine === 'rotary') for (const s of [-1, 1]) {
    const tri = new THREE.Mesh(G('tri', () => new THREE.CircleGeometry(0.1, 3)), new THREE.MeshBasicMaterial({ color: 0xff3030 }));
    tri.position.set(s * (half + 0.02), B.belt, B.zF - B.r - 0.35); tri.rotation.y = s * Math.PI / 2; add(tri);
  }
  if (build.engine === 'ev') {
    const strip = box(0.04, 0.04, 2.0, new THREE.MeshBasicMaterial({ color: 0x3fd6ff, toneMapped: false }));
    for (const s of [-1, 1]) { const m = strip.clone(); m.position.set(s * (half + 0.01), B.yb + 0.08, (B.zF + B.zR) / 2); add(m); }
  }

  // ---- hood
  if (build.hood === 'vented') for (const s of [-1, 1]) for (let k = 0; k < 4; k++) onHood(box(0.32, 0.03, 0.05, mats.dark, s * 0.32, 0, -0.2 + k * 0.12), 0.02);
  if (build.hood === 'scoop') { onHood(box(0.62, 0.2, 0.7, mats.paint), 0.08); onHood(box(0.5, 0.12, 0.04, mats.dark, 0, 0, 0.36), 0.1); }
  if (build.hood === 'carbon') onHood(box(B.W * 0.7, 0.02, 0.9, mats.carbon), 0.015);
  if (build.hood === 'blower') {
    onHood(box(0.55, 0.32, 0.6, mats.chrome), 0.14);
    const hat = cyl(0.17, 0.18, mats.dark, 12); hat.position.set(0, 0.39, 0.05); onHood(hat, 0);
    hat.rotation.x = 0;
  }

  // ---- vents
  if (build.vents === 'fender') for (const s of [-1, 1]) for (let k = 0; k < 3; k++) add(box(0.02, 0.06, 0.32, mats.dark, s * (half + 0.015), B.belt - 0.08 - k * 0.1, B.zF - B.r - 0.3));
  if (build.vents === 'scoops') for (const s of [-1, 1]) add(box(0.12, 0.2, 0.45, mats.dark, s * (half + 0.02), B.belt - 0.15, B.zR + B.r + 0.4));
  if (build.vents === 'louvers' && B.glass) {
    const g = B.glass, a = g[0], b2 = g[1];
    for (let k = 0; k < 5; k++) {
      const t = (k + 0.5) / 5, z = a[0] + (b2[0] - a[0]) * t - 0.04, y = a[1] + (b2[1] - a[1]) * t + 0.03;
      add(box(B.W - 0.4, 0.03, 0.08, mats.trim, 0, y + 0.02, z - 0.06));
    }
  }

  // ---- front aero
  if (build.aero === 'lip') add(box(B.W - 0.15, 0.04, 0.16, mats.dark, 0, ny - 0.04, nz - 0.02));
  if (build.aero === 'split') { add(box(B.W + 0.05, 0.04, 0.4, mats.carbon, 0, ny - 0.06, nz + 0.05)); }
  if (build.aero === 'canard') for (const s of [-1, 1]) for (const k of [0, 1]) {
    const c = box(0.3, 0.03, 0.16, mats.carbon, s * (half - 0.05), ny + 0.08 + k * 0.14, nz - 0.08);
    c.rotation.z = s * 0.25; add(c);
  }

  // ---- rear wing
  const [wz, wy] = B.wing;
  const span = B.W - 0.1;
  if (build.wing === 'duck') { const d = box(B.W - 0.3, 0.08, 0.28, mats.paint, 0, wy + 0.06, wz); d.rotation.x = 0.35; add(d); }
  if (build.wing === 'gt') {
    for (const s of [-1, 1]) add(box(0.05, 0.36, 0.2, mats.trim, s * span * 0.32, wy + 0.18, wz));
    const p = box(span, 0.05, 0.42, mats.carbon, 0, wy + 0.38, wz - 0.05); p.rotation.x = 0.12; add(p);
    for (const s of [-1, 1]) add(box(0.04, 0.24, 0.5, mats.paint, s * span / 2, wy + 0.38, wz - 0.05));
  }
  if (build.wing === 'swan') {
    for (const s of [-1, 1]) { add(box(0.05, 0.62, 0.08, mats.trim, s * span * 0.28, wy + 0.3, wz + 0.05)); add(box(0.05, 0.08, 0.24, mats.trim, s * span * 0.28, wy + 0.62, wz - 0.05)); }
    const p = box(span + 0.2, 0.06, 0.55, mats.carbon, 0, wy + 0.6, wz - 0.12); p.rotation.x = 0.16; add(p);
    for (const s of [-1, 1]) add(box(0.04, 0.34, 0.66, mats.accent, s * (span + 0.2) / 2, wy + 0.6, wz - 0.12));
  }
  if (build.wing === 'stock' && (type === 'comet' || type === 'hornet')) add(box(B.W - 0.3, 0.05, 0.3, mats.paint, 0, wy + 0.02, wz - 0.05));
  if (build.wing === 'stock' && type === 'viper') { const d = box(B.W - 0.2, 0.06, 0.3, mats.paint, 0, wy + 0.05, wz); d.rotation.x = 0.3; add(d); }

  // ---- fenders (flares) - wider stance for the wide-body kit
  let trackW = half - B.tw * 0.35 + (B.wide || 0);
  if (build.fenders === 'wide') trackW += 0.12;
  if (build.fenders !== 'stock') {
    const fl = build.fenders === 'wide' ? 0.2 : 0.11;
    const flareG = G(`flare${B.r}${fl}`, () => new THREE.CylinderGeometry(B.r + 0.12, B.r + 0.12, fl * 2, 12, 1, true, 0, Math.PI).rotateZ(Math.PI / 2));
    mats.paint.side = THREE.DoubleSide;
    for (const zc of [B.zF, B.zR]) for (const s of [-1, 1]) {
      const f = new THREE.Mesh(flareG, mats.paint);
      f.position.set(s * (half + fl * 0.6), B.r, zc);
      add(f);
    }
  }

  // ---- armour
  if (build.armor === 'bull') {
    const t = mats.trim, y0 = Math.max(0.35, ny), z0 = nz + 0.18;
    for (const s of [-1, 1]) add(tube([s * 0.55, y0 - 0.05, z0], [s * 0.45, y0 + 0.65, z0 - 0.05], 0.05, t));
    add(tube([-0.7, y0 + 0.1, z0 + 0.03], [0.7, y0 + 0.1, z0 + 0.03], 0.05, t));
    add(tube([-0.5, y0 + 0.62, z0 - 0.05], [0.5, y0 + 0.62, z0 - 0.05], 0.05, t));
    add(box(0.9, 0.3, 0.04, mats.dark, 0, y0 + 0.36, z0 + 0.02));
  }
  if (build.armor === 'cage' && !B.open) {
    const [z0, z1, ry] = B.roof, x = half - 0.12, t = mats.trim;
    for (const s of [-1, 1]) add(tube([s * x, ry + 0.08, z0], [s * x, ry + 0.08, z1], 0.04, t));
    add(tube([-x, ry + 0.08, z0], [x, ry + 0.08, z1], 0.04, t));
    add(tube([x, ry + 0.08, z0], [-x, ry + 0.08, z1], 0.04, t));
    add(tube([-x, ry + 0.08, z1], [x, ry + 0.08, z1], 0.04, t));
  }
  if (build.armor === 'carbon') {
    const [z0, z1, ry] = B.roof;
    add(box(B.W - 0.5, 0.02, Math.max(0.3, z1 - z0 - 0.2), mats.carbon, 0, ry + 0.01, (z0 + z1) / 2));
    if (build.hood !== 'carbon') onHood(box(B.W * 0.7, 0.02, 0.9, mats.carbon), 0.015);
  }

  // ---- livery
  const liv = build.livery;
  if (liv === 'stripes') {
    const t = B.top;
    for (let i = 0; i + 1 < t.length; i++) {
      const a = t[i], b2 = t[i + 1];
      const dz = b2[0] - a[0], dy = b2[1] - a[1], len = Math.hypot(dz, dy);
      if (len < 0.05 || Math.abs(dy) / len > 0.6 || dz <= 0) continue;
      for (const s of [-1, 1]) {
        const m = box(0.16, 0.012, len, mats.accent, s * 0.2, (a[1] + b2[1]) / 2 + 0.065, (a[0] + b2[0]) / 2);
        m.rotation.x = -Math.atan2(dy, dz);
        add(m);
      }
    }
  }
  const sideDecal = (texture, w, h, z, y) => {
    const mat = new THREE.MeshStandardMaterial({ map: texture, transparent: true, roughness: 0.4, polygonOffset: true, polygonOffsetFactor: -2 });
    for (const s of [-1, 1]) {
      const m = new THREE.Mesh(G(`pl${w},${h}`, () => new THREE.PlaneGeometry(w, h)), mat);
      m.position.set(s * (half + 0.075), y, z); m.rotation.y = s * Math.PI / 2;
      if (s < 0) m.scale.x = -1;
      add(m);
    }
  };
  if (liv === 'flames') sideDecal(TX.flamesDecal(accent), 2.2, 0.55, B.zF - 0.9, B.belt - 0.12);
  if (liv === 'checker') sideDecal(TX.checkerDecal(), (B.zF - B.zR) * 0.9, 0.14, (B.zF + B.zR) / 2, B.belt - 0.05);
  if (liv === 'number') sideDecal(TX.numberDecal((hashString(opts.name || type) % 98) + 1, accent), 0.6, 0.6, (B.zF + B.zR) / 2, B.belt - 0.12);
  if (liv === 'split') {
    for (const s of [-1, 1]) add(box(0.02, 0.2, (B.zF - B.zR) - 2 * B.r - 0.25, mats.accent, s * (half + 0.07), B.yb + 0.16, (B.zF + B.zR) / 2));
    if (!B.open) { const [z0, z1, ry] = B.roof; add(box(B.W - 0.45, 0.02, Math.max(0.3, z1 - z0 - 0.15), mats.accent, 0, ry + 0.012, (z0 + z1) / 2)); }
  }

  // ---- exhaust tips (boost flames come out of these)
  const exh = [];
  const ez = B.top[0][0] - 0.02, ey = B.top[0][1] + 0.1;
  const tips = build.engine === 'ev' ? [] : ({
    stock: [[-0.5, 0.05]], sport: [[-0.18, 0.06], [0.18, 0.06]], straight: [[0.55, 0.1]], quad: [[-0.55, 0.05], [-0.38, 0.05], [0.38, 0.05], [0.55, 0.05]],
    titanium: [[-0.22, 0.06], [0.22, 0.06]], side: [],
  })[build.exhaust] || [[-0.5, 0.05]];
  const tipMat = build.exhaust === 'titanium' ? mats.ti : mats.chrome;
  for (const [x, r0] of tips) {
    const r = build.exhaust === 'straight' ? 0.1 : r0;
    const t = cyl(r, 0.3, tipMat, 10); t.rotation.x = Math.PI / 2; t.position.set(x, ey, ez - 0.06); add(t);
    exh.push(new THREE.Vector3(x, ey + ride, ez - 0.22));
  }
  if (build.exhaust === 'side' && build.engine !== 'ev') for (const s of [-1, 1]) {
    const p = cyl(0.07, (B.zF - B.zR) - 2 * B.r - 0.3, mats.chrome, 10); p.rotation.x = Math.PI / 2;
    p.position.set(s * (half + 0.08), B.yb + 0.05, (B.zF + B.zR) / 2); add(p);
    exh.push(new THREE.Vector3(s * (half + 0.08), B.yb + 0.05 + ride, B.zR + B.r + 0.2));
  }

  // ---- wheels
  const tireMul = { slick: [1, 1.15], knobby: [1.12, 1.2], drift: [1, 1], street: [1, 1] }[build.tires] || [1, 1];
  const R = B.r * tireMul[0] * (build.wheels === 'big' ? 1.03 : 1), TW = B.tw * tireMul[1];
  const tireGeo = G(`tire${R},${TW},${build.tires}`, () => {
    const g = new THREE.CylinderGeometry(R, R, TW, build.tires === 'knobby' ? 8 : 18);
    g.rotateZ(Math.PI / 2);
    return g;
  });
  const rimR = R * (build.wheels === 'big' ? 0.78 : build.wheels === 'dish' ? 0.68 : 0.62);
  const rimMat = build.wheels === 'stock' ? new THREE.MeshStandardMaterial({ color: 0x8a9098, metalness: 0.5, roughness: 0.5 })
    : build.wheels === 'big' ? new THREE.MeshStandardMaterial({ color: 0xd9b14a, metalness: 0.9, roughness: 0.25 })
      : build.wheels === 'beadlock' ? new THREE.MeshStandardMaterial({ color: 0x2a2c31, metalness: 0.6, roughness: 0.4 }) : mats.rim;
  const wheels = [];
  for (const [zc, front] of [[B.zF, true], [B.zR, false]]) for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    pivot.position.set(s * trackW, R + ride * 0.15, zc);
    const spin = new THREE.Group();
    pivot.add(spin);
    const tire = new THREE.Mesh(tireGeo, mats.tire); tire.castShadow = cast; spin.add(tire);
    if (build.tires === 'knobby') tire.material = new THREE.MeshStandardMaterial({ color: 0x1c1d20, roughness: 1, flatShading: true });
    const rim = new THREE.Mesh(G(`rim${rimR},${TW}`, () => new THREE.CylinderGeometry(rimR, rimR, TW + 0.02, 14).rotateZ(Math.PI / 2)), rimMat);
    spin.add(rim);
    if (build.wheels === 'alloy' || build.wheels === 'big') for (let k = 0; k < 5; k++) {
      const sp = box(0.03, rimR * 1.8, 0.07, mats.dark); sp.position.x = s * (TW / 2 + 0.012); sp.rotation.x = k * Math.PI / 5; spin.add(sp);
    }
    if (build.wheels === 'dish') { const lip = new THREE.Mesh(G(`lip${rimR}`, () => new THREE.TorusGeometry(rimR, 0.035, 6, 18).rotateY(Math.PI / 2)), mats.chrome); lip.position.x = s * (TW / 2 + 0.01); spin.add(lip); }
    if (build.wheels === 'beadlock') for (let k = 0; k < 8; k++) {
      const bolt = cyl(0.025, 0.04, mats.chrome, 6); bolt.rotation.z = Math.PI / 2;
      bolt.position.set(s * (TW / 2 + 0.015), Math.cos(k / 8 * 6.283) * rimR * 0.85, Math.sin(k / 8 * 6.283) * rimR * 0.85); spin.add(bolt);
    }
    if (build.tires === 'drift') { const ring = new THREE.Mesh(G(`dring${R}`, () => new THREE.TorusGeometry(R * 0.86, 0.025, 6, 20).rotateY(Math.PI / 2)), mats.accent); ring.position.x = s * (TW / 2 + 0.005); spin.add(ring); }
    const hub = cyl(rimR * 0.25, TW + 0.05, mats.chrome, 8); hub.rotation.z = Math.PI / 2; spin.add(hub);
    if (build.susp === 'lifted' || type === 'titan') root.add(tube([s * trackW * 0.7, R + 0.1, zc], [s * (half - 0.2), R + ride + 0.25, zc], 0.06, mats.chrome));
    if (build.susp === 'rally' && !front) for (const ss of [s]) { const flap = box(0.34, 0.32, 0.02, mats.dark, ss * trackW, 0.28, zc - R - 0.12); root.add(flap); }
    root.add(pivot);
    wheels.push({ pivot, spin, front, side: s });
  }

  // ---- underglow
  let glow = null;
  if (build.glow) {
    glow = new THREE.Mesh(G('glowPlane', () => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)),
      new THREE.MeshBasicMaterial({ map: TX.glowDisc(), color: build.glow, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    glow.scale.set(B.W + 1.6, 1, (B.zF - B.zR) + 2.6);
    glow.position.y = 0.06;
    root.add(glow);
  }

  // ---- boost flames, shield bubble
  const flameMat = new THREE.MeshBasicMaterial({ color: 0x66c8ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const flameGeo = G('flame', () => new THREE.ConeGeometry(0.16, 1, 8, 1, true).rotateX(-Math.PI / 2).translate(0, 0, -0.5));
  const flames = exh.map(p => { const f = new THREE.Mesh(flameGeo, flameMat); f.position.copy(p); f.visible = false; root.add(f); return f; });
  const len = B.top[B.top.length - 1][0] - B.top[0][0];
  const shield = new THREE.Mesh(G('shieldSph', () => new THREE.SphereGeometry(1, 20, 14)),
    new THREE.MeshBasicMaterial({ color: 0x6fd6ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  shield.scale.set(B.W * 0.85, (topY(B, 0) + ride) * 0.85 + 0.4, len * 0.62);
  shield.position.y = (topY(B, 0) + ride) * 0.5;
  shield.visible = false;
  root.add(shield);

  const allMats = new Set();
  root.traverse(o => { if (o.material) allMats.add(o.material); });
  const height = Math.max(...B.top.map(p => p[1])) + ride;
  return {
    root, body, wheels, flames, shield, glow, mats, exhausts: exh, B, height, length: len,
    rearZ: B.top[0][0], wheelR: R, trackW,
    setOpacity(a) {
      for (const m of allMats) {
        if (m === flameMat || m === shield.material || (glow && m === glow.material)) continue;
        m.transparent = a < 1; m.opacity = a; m.depthWrite = a >= 1;
      }
    },
    dispose() {
      root.traverse(o => { if (o.geometry && ![...sharedGeo.values()].includes(o.geometry)) o.geometry.dispose(); });
      for (const m of allMats) m.dispose();
    },
  };
}
