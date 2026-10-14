// Builds the 3D world for a Track: road, curbs, barriers, start gantry,
// features (item boxes, boost pads, ramps), lamps, trees and the city around
// it (OSM buildings / parks / water / side streets, or procedural ones).
import * as THREE from 'three';
import * as TX from './textures.js';
import { PHYS } from '../sim/config.js';
import { mulberry32, hashString, clamp } from '../sim/util.js';

export const THEMES = {
  day: {
    skyTop: 0x2f6fd0, skyHorizon: 0xcde8ff, skyBottom: 0xe8f2fa, fog: 0xc9e2f5, fogNear: 260, fogFar: 1500,
    sun: 0xfff1db, sunI: 2.7, hemiSky: 0xdcecff, hemiGround: 0x7a7562, hemiI: 1.15, sunDir: [0.42, 0.78, 0.3],
    exposure: 1.0, windows: 0, lamps: 0.05, pools: 0, stars: 0, sunVisible: 1,
  },
  sunset: {
    skyTop: 0x262a63, skyHorizon: 0xff9a5e, skyBottom: 0xffc49a, fog: 0xd9997a, fogNear: 220, fogFar: 1250,
    sun: 0xffad72, sunI: 2.1, hemiSky: 0xffc8a2, hemiGround: 0x4b3a48, hemiI: 0.95, sunDir: [-0.72, 0.16, 0.5],
    exposure: 1.05, windows: 0.55, lamps: 0.8, pools: 0.25, stars: 0, sunVisible: 1,
  },
  night: {
    skyTop: 0x050a1c, skyHorizon: 0x22325e, skyBottom: 0x26365f, fog: 0x18234a, fogNear: 300, fogFar: 1500,
    sun: 0xb4c8ff, sunI: 1.05, hemiSky: 0x6478b8, hemiGround: 0x23232e, hemiI: 1.25, sunDir: [0.3, 0.6, -0.5],
    exposure: 1.3, windows: 1.0, lamps: 1.8, pools: 0.7, stars: 1, sunVisible: 0,
  },
};

const PALETTES = [
  [0xe8d6c0, 0xd9c3a5, 0xf0e6d2, 0xc9d6df, 0xe5c7b9, 0xdcd0bd],   // houses
  [0xd8d2c8, 0xc4b8a8, 0xb8c4cc, 0xe0cfc0, 0xa9b3bd, 0xcfbfae],   // apartments
  [0x9fb3c8, 0xb7c7d6, 0x8ea2b8, 0xc9d3dd, 0x7f93a8, 0xa7b7c1],   // offices
  [0xa8a49c, 0x9a9a94, 0xb5aa98, 0x8f9aa3],                       // industrial
  [0xe6dcc8, 0xd8c8b0, 0xcbb89c],                                 // civic
  [0x9b8b7a, 0xa59a8a, 0x8d8d86],                                 // sheds
];
const ROOFS = [[0x7a3b2e, 0x5a5f66, 0x6d4a3a], [0x6f6f72, 0x5e6066], [0x4f5660, 0x5d646d], [0x6b6b6b, 0x777270], [0x6a5c50], [0x5f5a52]];

const V = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3();

// Collects triangles; quad() orients faces toward `hint` so callers needn't
// care about winding.
class Builder {
  constructor() { this.pos = []; this.nor = []; this.uv = []; this.col = []; }
  tri(a, b, c, uva, uvb, uvc, color, hint) {
    V.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    V2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    V3.crossVectors(V, V2);
    if (hint && V3.x * hint[0] + V3.y * hint[1] + V3.z * hint[2] < 0) { [b, c] = [c, b]; [uvb, uvc] = [uvc, uvb]; V3.negate(); }
    V3.normalize();
    for (const [p, t] of [[a, uva], [b, uvb], [c, uvc]]) {
      this.pos.push(p[0], p[1], p[2]); this.nor.push(V3.x, V3.y, V3.z);
      this.uv.push(t ? t[0] : 0, t ? t[1] : 0);
      if (color) this.col.push(color.r, color.g, color.b);
    }
  }
  quad(a, b, c, d, uvs, color, hint) {      // a-b-c-d around the quad
    this.tri(a, b, c, uvs?.[0], uvs?.[1], uvs?.[2], color, hint);
    this.tri(a, c, d, uvs?.[0], uvs?.[2], uvs?.[3], color, hint);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (this.col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
  get empty() { return this.pos.length === 0; }
}
const UP = [0, 1, 0];

export function buildWorld(track, quality = 'high') {
  const group = new THREE.Group();
  const hw = track.halfW, n = track.n, data = track.data;
  const scen = data.scen || { b: [], r: [], g: [], w: [], t: [] };
  const rng = mulberry32(hashString(String(data.id || 'track')));
  const px = track.px, pz = track.pz, NX = track.nx, NZ = track.nz;
  const P = (i, o, y = 0) => [px[i] + NX[i] * o, y, pz[i] + NZ[i] * o];
  const mats = [];
  const M = m => { mats.push(m); return m; };
  const shadows = quality !== 'low';

  // ---- where other parts of the course come close (crossings, parallels)
  const minGap = Math.ceil((hw * 4 + 30) / track.step);
  const otherDist = (x, z, r, i) => {
    let best = Infinity, bj = -1;
    track.near(x, z, r, j => {
      let di = Math.abs(i - j); di = Math.min(di, n - di);
      if (di < minGap) return;
      const d = Math.hypot(px[j] - x, pz[j] - z);
      if (d < best) { best = d; bj = j; }
    });
    return [best, bj];
  };
  const raised = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const [d, j] = otherDist(px[i], pz[i], hw * 2 + 4, i);
    if (d < hw * 2 + 2 && j < i) raised[i] = 1;
  }
  // barrier / curb skip flags per side (0 = left, 1 = right)
  const skipEdge = [new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0; i < n; i++) for (let s = 0; s < 2; s++) {
    const o = (s === 0 ? 1 : -1) * (hw + 1.35);
    const q = P(i, o);
    const [d, j] = otherDist(q[0], q[2], hw + 4, i);
    if (d < hw + 1.2 || (d < hw + 2.8 && j < i)) skipEdge[s][i] = 1;
  }

  // ---- ground
  const b = track.bounds;
  const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
  const ext = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 3000;
  const dense = scen.b.length / Math.max(1, track.L / 1000) > 140 || data.style === 'downtown' || data.style === 'harbor';
  const groundColor = data.style === 'suburb' ? '#7d9a5c' : dense ? '#8c8a83' : '#86936c';
  const gtex = TX.groundTex(groundColor).clone(); gtex.needsUpdate = true;
  gtex.repeat.set(ext / 40, ext / 40);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(ext, ext), M(new THREE.MeshStandardMaterial({ map: gtex, roughness: 1, metalness: 0 })));
  ground.rotation.x = -Math.PI / 2; ground.position.set(cx, 0, cz);
  ground.receiveShadow = shadows;
  group.add(ground);

  // ---- road
  {
    const pos = [], uv = [], idx = [], nor = [];
    for (let i = 0; i <= n; i++) {
      const k = i % n, y = 0.03 + (raised[k] ? 0.012 : 0);
      const L = P(k, hw, y), R = P(k, -hw, y);
      pos.push(...L, ...R); nor.push(0, 1, 0, 0, 1, 0);
      const v = (i === n ? track.L : track.s[k]) / 12;
      uv.push(0, v, 1, v);
    }
    for (let i = 0; i < n; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    const road = new THREE.Mesh(g, M(new THREE.MeshStandardMaterial({ map: TX.asphalt(), roughness: 0.92, metalness: 0.0 })));
    road.receiveShadow = shadows;
    group.add(road);
  }

  // ---- curbs, barriers, sidewalks
  const C = new THREE.Color();
  const red = new THREE.Color(0xd8352f), white = new THREE.Color(0xf2f0ea), grey = new THREE.Color(0xa9a59c);
  const barA = new THREE.Color(0xf4f4f0), barB = new THREE.Color(0xe0442f), barC = new THREE.Color(0x2c63c9);
  const curb = new Builder(), barrier = new Builder(), walk = new Builder();
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const corner = Math.abs(track.k[i]) > 1 / 70;
    for (let s = 0; s < 2; s++) {
      if (skipEdge[s][i] || skipEdge[s][j]) continue;
      const sg = s === 0 ? 1 : -1;
      const out = [NX[i] * sg, 0, NZ[i] * sg];
      // curb
      const cc = corner ? ((Math.floor(track.s[i] / 2) % 2) ? red : white) : grey;
      curb.quad(P(i, sg * hw, 0.05), P(j, sg * hw, 0.05), P(j, sg * (hw + PHYS.curbW), 0.07), P(i, sg * (hw + PHYS.curbW), 0.07), null, cc, UP);
      // barrier block
      const o1 = sg * (hw + PHYS.curbW), o2 = sg * (hw + PHYS.curbW + 0.45), H = 0.9;
      const block = Math.floor(track.s[i] / 4) % 2;
      const bc = block ? (corner ? barB : barC) : barA;
      const inward = [-out[0], 0, -out[2]];
      barrier.quad(P(i, o1, 0), P(j, o1, 0), P(j, o1, H), P(i, o1, H), null, bc, inward);
      barrier.quad(P(i, o1, H), P(j, o1, H), P(j, o2, H), P(i, o2, H), null, C.copy(bc).multiplyScalar(0.85), UP);
      barrier.quad(P(i, o2, 0), P(j, o2, 0), P(j, o2, H), P(i, o2, H), null, C.copy(bc).multiplyScalar(0.7), out);
      // sidewalk
      const w1 = sg * (hw + PHYS.curbW + 0.45), w2 = sg * (hw + 6);
      const v0 = track.s[i] / 4, v1 = (j === 0 ? track.L : track.s[j]) / 4;
      walk.quad(P(i, w1, 0.1), P(j, w1, 0.1), P(j, w2, 0.1), P(i, w2, 0.1), [[0, v0], [0, v1], [1, v1], [1, v0]], null, UP);
    }
  }
  const curbMesh = new THREE.Mesh(curb.geometry(), M(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 })));
  curbMesh.receiveShadow = shadows;
  const barMesh = new THREE.Mesh(barrier.geometry(), M(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 })));
  barMesh.castShadow = barMesh.receiveShadow = shadows;
  const walkMesh = new THREE.Mesh(walk.geometry(), M(new THREE.MeshStandardMaterial({ map: TX.concrete(), roughness: 0.95 })));
  walkMesh.receiveShadow = shadows;
  group.add(curbMesh, barMesh, walkMesh);

  // ---- start line, grid boxes, gantry
  const sp0 = track.pointAt(0);
  {
    const a = track.pointAt(-1.2), c = track.pointAt(1.2), y = 0.05;
    const bld = new Builder();
    bld.quad([a.x + a.nx * hw, y, a.z + a.nz * hw], [a.x - a.nx * hw, y, a.z - a.nz * hw], [c.x - c.nx * hw, y, c.z - c.nz * hw], [c.x + c.nx * hw, y, c.z + c.nz * hw],
      [[0, 0], [1, 0], [1, 1], [0, 1]], null, UP);
    group.add(new THREE.Mesh(bld.geometry(), M(new THREE.MeshStandardMaterial({ map: TX.checker(), roughness: 0.8 }))));
    const gb = new Builder();
    for (let k = 0; k < 12; k++) {
      const sl = track.gridSlot(k);
      const fx = Math.sin(sl.h), fz = Math.cos(sl.h), rx = -fz, rz = fx;
      const line = (ax, az, bx, bz, w) => {
        const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz), ox = -dz / l * w, oz = dx / l * w;
        gb.quad([ax + ox, 0.05, az + oz], [bx + ox, 0.05, bz + oz], [bx - ox, 0.05, bz - oz], [ax - ox, 0.05, az - oz], null, null, UP);
      };
      const fxp = sl.x + fx * 2.6, fzp = sl.z + fz * 2.6;
      line(fxp - rx * 1.4, fzp - rz * 1.4, fxp + rx * 1.4, fzp + rz * 1.4, 0.12);
      line(fxp - rx * 1.4, fzp - rz * 1.4, fxp - rx * 1.4 - fx * 1.6, fzp - rz * 1.4 - fz * 1.6, 0.1);
      line(fxp + rx * 1.4, fzp + rz * 1.4, fxp + rx * 1.4 - fx * 1.6, fzp + rz * 1.4 - fz * 1.6, 0.1);
    }
    group.add(new THREE.Mesh(gb.geometry(), M(new THREE.MeshBasicMaterial({ color: 0xf2f2f2 }))));
  }
  const gantry = new THREE.Group();
  const lights = [];
  {
    gantry.position.set(sp0.x, 0, sp0.z);
    gantry.rotation.y = sp0.h;
    const span = hw + PHYS.curbW + 1.6;
    const steel = M(new THREE.MeshStandardMaterial({ color: 0x2a2e38, roughness: 0.5, metalness: 0.6 }));
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.8, 7.6, 0.8), steel);
      p.position.set(s * span, 3.8, 0); p.castShadow = shadows; gantry.add(p);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(span * 2 + 0.8, 1.5, 1.0), steel);
    beam.position.set(0, 7.6, 0); beam.castShadow = shadows; gantry.add(beam);
    const ban = M(new THREE.MeshBasicMaterial({ map: TX.banner('HOME TURF'), toneMapped: false }));
    for (const s of [-1, 1]) {
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(span * 2, span * 2 / 8), ban);
      pl.position.set(0, 7.6, s * 0.52); pl.rotation.y = s > 0 ? 0 : Math.PI;
      gantry.add(pl);
    }
    for (let k = 0; k < 4; k++) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.1, 0.5), steel);
      pod.position.set((k - 1.5) * 1.6, 6.2, -0.4); gantry.add(pod);
      const lm = M(new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0x000000, emissiveIntensity: 3, roughness: 0.3 }));
      const lamp = new THREE.Mesh(new THREE.CircleGeometry(0.42, 20), lm);
      lamp.position.set((k - 1.5) * 1.6, 6.2, -0.66); lamp.rotation.y = Math.PI;
      gantry.add(lamp); lights.push(lm);
    }
    group.add(gantry);
  }

  // ---- grandstand + flags along the start straight
  const stands = [];
  {
    const side = rng() < 0.5 ? 1 : -1;
    const s0 = -70, s1 = -12;
    const sb = new Builder();
    const ct = TX.crowdTex();
    const steps = 4;
    for (let s = s0; s < s1; s += 2) {
      const a = track.pointAt(s), c = track.pointAt(s + 2);
      for (let k = 0; k < steps; k++) {
        const o1 = side * (hw + 7 + k * 1.6), o2 = side * (hw + 7 + (k + 1) * 1.6), y = 0.6 + k * 1.1;
        const A = [a.x + a.nx * o1, y, a.z + a.nz * o1], B = [c.x + c.nx * o1, y, c.z + c.nz * o1];
        const Cq = [c.x + c.nx * o2, y, c.z + c.nz * o2], D = [a.x + a.nx * o2, y, a.z + a.nz * o2];
        const u0 = (s - s0) / 16, u1 = (s + 2 - s0) / 16;
        sb.quad(A, B, Cq, D, [[u0, k / steps], [u1, k / steps], [u1, (k + 1) / steps], [u0, (k + 1) / steps]], null, UP);
        const A0 = [A[0], y - 1.1, A[2]], B0 = [B[0], y - 1.1, B[2]];
        sb.quad(A0, B0, B, A, [[u0, 0], [u1, 0], [u1, 0.2], [u0, 0.2]], null, [-a.nx * side, 0, -a.nz * side]);
      }
      stands.push([a.x + a.nx * side * (hw + 10), a.z + a.nz * side * (hw + 10)]);
    }
    const sm = new THREE.Mesh(sb.geometry(), M(new THREE.MeshStandardMaterial({ map: ct, roughness: 0.9 })));
    sm.castShadow = sm.receiveShadow = shadows;
    group.add(sm);
    // flags
    const poleG = new THREE.CylinderGeometry(0.06, 0.06, 6, 6); poleG.translate(0, 3, 0);
    const flagG = new THREE.PlaneGeometry(1.4, 0.9); flagG.translate(0.7, 5.4, 0);
    const cnt = 20;
    const poles = new THREE.InstancedMesh(poleG, M(new THREE.MeshStandardMaterial({ color: 0xcfd3da, metalness: 0.5, roughness: 0.4 })), cnt);
    const flags = new THREE.InstancedMesh(flagG, M(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.8 })), cnt);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), pp = new THREE.Vector3();
    const fcols = [0xff3b3b, 0xffd23f, 0x2f8cff, 0x3ddc84, 0xff4fd8, 0xff8a1f];
    for (let k = 0; k < cnt; k++) {
      const s = -60 + (k >> 1) * 11, sd = k % 2 ? -side : -side;
      const p = track.pointAt(s + (k % 2) * 5.5);
      const o = sd * (hw + 4.2);
      pp.set(p.x + p.nx * o, 0, p.z + p.nz * o);
      q.setFromAxisAngle(V.set(0, 1, 0), p.h + Math.PI / 2);
      m4.compose(pp, q, sc);
      poles.setMatrixAt(k, m4); flags.setMatrixAt(k, m4);
      flags.setColorAt(k, C.set(fcols[k % fcols.length]));
    }
    group.add(poles, flags);
  }

  // ---- features: boost pads, ramps, item boxes
  // Light pillars mark pads (orange) and item boxes (rainbow) from far away;
  // they ignore fog so you can plan a line long before you get there.
  const pillarGeo = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0);
  const pillarMat = color => M(new THREE.MeshBasicMaterial({ map: TX.beam(), color, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false, side: THREE.DoubleSide }));
  const pillar = (mat, x, z, r, h) => { const m = new THREE.Mesh(pillarGeo, mat); m.position.set(x, 0.05, z); m.scale.set(r, h, r); m.renderOrder = 4; return m; };
  // screen-size icons floating above rows / pads, fading out as you arrive
  const markers = [];
  const marker = (kind, x, z) => {
    const mat = new THREE.SpriteMaterial({ map: TX.markerIcon(kind), sizeAttenuation: false, fog: false, transparent: true, depthWrite: false });
    M(mat);
    const sp = new THREE.Sprite(mat);
    sp.scale.set(0.045, 0.045, 1);
    sp.position.set(x, kind === 'box' ? 5.5 : 4, z);
    sp.renderOrder = 6;
    sp.userData.kind = kind;
    group.add(sp);
    markers.push(sp);
    return sp;
  };
  const padPillarMat = pillarMat(0xff8a1f);
  const padGlowMat = M(new THREE.MeshBasicMaterial({ map: TX.glowDisc(), color: 0xff7a1a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false }));
  const padTex = TX.chevrons().clone(); padTex.needsUpdate = true; padTex.repeat.set(1, 2);
  const padMat = M(new THREE.MeshBasicMaterial({ map: padTex, toneMapped: false, transparent: true, opacity: 0.95, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  for (const [s0, lat] of track.feats.pads || []) {
    const bld = new Builder(), glow = new Builder();
    const a = track.pointAt(s0), c = track.pointAt(s0 + PHYS.padLen), w = PHYS.padHalfW, y = 0.06;
    bld.quad([a.x + a.nx * (lat + w), y, a.z + a.nz * (lat + w)], [a.x + a.nx * (lat - w), y, a.z + a.nz * (lat - w)],
      [c.x + c.nx * (lat - w), y, c.z + c.nz * (lat - w)], [c.x + c.nx * (lat + w), y, c.z + c.nz * (lat + w)], [[0, 0], [1, 0], [1, 1], [0, 1]], null, UP);
    const a2 = track.pointAt(s0 - 3), c2 = track.pointAt(s0 + PHYS.padLen + 3), w2 = w + 2.2, y2 = 0.05;
    glow.quad([a2.x + a2.nx * (lat + w2), y2, a2.z + a2.nz * (lat + w2)], [a2.x + a2.nx * (lat - w2), y2, a2.z + a2.nz * (lat - w2)],
      [c2.x + c2.nx * (lat - w2), y2, c2.z + c2.nz * (lat - w2)], [c2.x + c2.nx * (lat + w2), y2, c2.z + c2.nz * (lat + w2)], [[0, 0], [1, 0], [1, 1], [0, 1]], null, UP);
    group.add(new THREE.Mesh(glow.geometry(), padGlowMat), new THREE.Mesh(bld.geometry(), padMat));
    for (const sd of [-1, 1]) group.add(pillar(padPillarMat, a.x + a.nx * (lat + sd * (w + 0.2)), a.z + a.nz * (lat + sd * (w + 0.2)), 0.4, 14));
    marker('pad', a.x + a.nx * lat, a.z + a.nz * lat);
  }
  const rampMat = M(new THREE.MeshStandardMaterial({ map: TX.hazard(), roughness: 0.6 }));
  for (const s0 of track.feats.ramps || []) {
    const bld = new Builder();
    const a = track.pointAt(s0), c = track.pointAt(s0 + PHYS.rampLen), w = hw + 0.4, H = PHYS.rampH;
    const A1 = [a.x + a.nx * w, 0.03, a.z + a.nz * w], A2 = [a.x - a.nx * w, 0.03, a.z - a.nz * w];
    const C1 = [c.x + c.nx * w, H, c.z + c.nz * w], C2 = [c.x - c.nx * w, H, c.z - c.nz * w];
    const C1b = [C1[0], 0, C1[2]], C2b = [C2[0], 0, C2[2]];
    bld.quad(A1, A2, C2, C1, [[0, 0], [w / 2, 0], [w / 2, 2], [0, 2]], null, UP);
    bld.quad(C1b, C2b, C2, C1, [[0, 0], [w / 2, 0], [w / 2, 0.3], [0, 0.3]], null, [c.tx, 0, c.tz]);
    bld.tri(A1, C1, C1b, null, null, null, null, [a.nx, 0, a.nz]);
    bld.tri(A2, C2, C2b, null, null, null, null, [-a.nx, 0, -a.nz]);
    const rm = new THREE.Mesh(bld.geometry(), rampMat);
    rm.castShadow = rm.receiveShadow = shadows;
    group.add(rm);
  }
  const boxGeo = new THREE.BoxGeometry(2, 2, 2);
  const boxMat = M(new THREE.MeshStandardMaterial({ map: TX.boxFace(), transparent: true, opacity: 0.9, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.2, metalness: 0.1, depthWrite: false, fog: false }));
  const boxPillarMat = pillarMat(0xffffff);
  boxPillarMat.opacity = 0.7;
  const coreMat = M(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, toneMapped: false }));
  const coreGeo = new THREE.IcosahedronGeometry(0.45, 0);
  const boxes = (track.feats.boxes || []).map(([s, lat], i) => {
    const p = track.pointAt(s);
    const g = new THREE.Group();
    const m = new THREE.Mesh(boxGeo, boxMat); m.castShadow = shadows;
    const core = new THREE.Mesh(coreGeo, coreMat);
    const beam = pillar(boxPillarMat, 0, -1.3, 0.55, 16);
    g.add(m, core, beam);
    g.position.set(p.x + p.nx * lat, 1.25, p.z + p.nz * lat);
    g.userData = { phase: i * 0.7, box: m, core, beam };
    group.add(g);
    return g;
  });
  for (const s of new Set((track.feats.boxes || []).map(b => b[0]))) { const p = track.pointAt(s); marker('box', p.x, p.z); }

  // ---- corner chevron boards on the outside of tight corners
  {
    const signMat = M(new THREE.MeshStandardMaterial({ map: TX.cornerSign(), roughness: 0.6, side: THREE.DoubleSide }));
    const geo = new THREE.PlaneGeometry(1.4, 1.4);
    let i = 0, guard = 0;
    while (i < n && guard++ < n) {
      if (Math.abs(track.k[i]) > 1 / 36) {
        let j = i; while (j < n - 1 && Math.abs(track.k[j + 1]) > 1 / 36) j++;
        const mid = Math.floor((i + j) / 2), turnLeft = track.k[mid] > 0, side = turnLeft ? -1 : 1;
        for (const dk of [-4, 0, 4]) {
          const k = track.wrapI(mid + dk);
          if (skipEdge[side > 0 ? 0 : 1][k]) continue;
          const o = side * (hw + PHYS.curbW + 0.5);
          const m = new THREE.Mesh(geo, signMat);
          m.position.set(px[k] + NX[k] * o, 1.6, pz[k] + NZ[k] * o);
          m.lookAt(px[k], 1.6, pz[k]);
          m.rotateY(side > 0 ? 0.5 : -0.5);
          if (!turnLeft) m.scale.x = -1;
          group.add(m);
        }
        i = j + 12;
      } else i++;
    }
  }

  // ---- street lamps (+ fake light pools on the road at night)
  const lampHeads = M(new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffd9a0, emissiveIntensity: 0 }));
  const poolMat = M(new THREE.MeshBasicMaterial({ map: TX.glowDisc(), color: 0xffcf8a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  {
    const spots = [];
    for (let s = 10, k = 0; s < track.L - 5; s += 34, k++) {
      const p = track.pointAt(s), side = k % 2 ? 1 : -1;
      if (skipEdge[side > 0 ? 0 : 1][p.i]) continue;
      spots.push([p, side]);
    }
    const poleG = new THREE.CylinderGeometry(0.11, 0.14, 7.2, 6); poleG.translate(0, 3.6, 0);
    const armG = new THREE.BoxGeometry(0.12, 0.12, 2.6); armG.translate(0, 7.1, 1.2);
    const headG = new THREE.BoxGeometry(0.5, 0.18, 0.9); headG.translate(0, 7.0, 2.4);
    const poleM = M(new THREE.MeshStandardMaterial({ color: 0x5b6170, metalness: 0.5, roughness: 0.5 }));
    const poles = new THREE.InstancedMesh(poleG, poleM, spots.length);
    const arms = new THREE.InstancedMesh(armG, poleM, spots.length);
    const heads = new THREE.InstancedMesh(headG, lampHeads, spots.length);
    const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(13, 13).rotateX(-Math.PI / 2), poolMat, spots.length);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), pp = new THREE.Vector3();
    spots.forEach(([p, side], k) => {
      const o = side * (hw + 3.4);
      pp.set(p.x + p.nx * o, 0, p.z + p.nz * o);
      // arm points toward the road centre
      q.setFromAxisAngle(V.set(0, 1, 0), Math.atan2(-p.nx * side, -p.nz * side));
      m4.compose(pp, q, sc);
      poles.setMatrixAt(k, m4); arms.setMatrixAt(k, m4); heads.setMatrixAt(k, m4);
      pp.set(p.x + p.nx * (o - side * 2.4), 0.07, p.z + p.nz * (o - side * 2.4));
      m4.compose(pp, new THREE.Quaternion(), sc);
      pools.setMatrixAt(k, m4);
    });
    poles.castShadow = shadows;
    group.add(poles, arms, heads, pools);
  }

  // ---- side streets
  if (scen.r?.length) {
    const bld = new Builder();
    for (const r of scen.r) {
      const w = r[0] / 2;
      for (let i = 1; i + 3 < r.length; i += 2) {
        const ax = r[i], az = r[i + 1], bx = r[i + 2], bz = r[i + 3];
        const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
        if (l < 0.1) continue;
        const ox = -dz / l * w, oz = dx / l * w, y = 0.015;
        bld.quad([ax + ox, y, az + oz], [bx + ox, y, bz + oz], [bx - ox, y, bz - oz], [ax - ox, y, az - oz],
          [[(ax + ox) / 8, (az + oz) / 8], [(bx + ox) / 8, (bz + oz) / 8], [(bx - ox) / 8, (bz - oz) / 8], [(ax - ox) / 8, (az - oz) / 8]], null, UP);
      }
    }
    if (!bld.empty) {
      // Flat map layers are stacked by height only (ground 0 < park < water < side street < road 0.03).
      // No polygonOffset: a slope-scaled offset grows with distance at a low camera and pulled
      // side streets over the race road far ahead, hiding its lines behind a grey patch.
      const m = new THREE.Mesh(bld.geometry(), M(new THREE.MeshStandardMaterial({ map: TX.asphaltPlain(), roughness: 0.95 })));
      m.receiveShadow = shadows;
      group.add(m);
    }
  }

  // ---- parks and water
  const polyMesh = (list, mat, y) => {
    const pos = [], nor = [], uv = [];
    for (const f of list) {
      const pts = [];
      for (let i = 0; i + 1 < f.length; i += 2) pts.push(new THREE.Vector2(f[i], f[i + 1]));
      if (pts.length < 3) continue;
      let tris;
      try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch { continue; }
      for (const t of tris) {
        const a = pts[t[0]], bb = pts[t[1]], c = pts[t[2]];
        const cr = (bb.x - a.x) * (c.y - a.y) - (bb.y - a.y) * (c.x - a.x);
        const order = cr < 0 ? [a, bb, c] : [a, c, bb];
        for (const p of order) { pos.push(p.x, y, p.y); nor.push(0, 1, 0); uv.push(p.x / 20, p.y / 20); }
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = shadows;
    group.add(m);
  };
  polyMesh(scen.g || [], M(new THREE.MeshStandardMaterial({ map: TX.groundTex('#5f9a45'), roughness: 1 })), 0.005);
  const waterMat = M(new THREE.MeshStandardMaterial({ color: 0x2e6f9e, roughness: 0.15, metalness: 0.25 }));
  polyMesh(scen.w || [], waterMat, 0.01);

  // ---- trees
  if (scen.t?.length) {
    const cnt = Math.min(1500, scen.t.length / 2);
    const trunkG = new THREE.CylinderGeometry(0.18, 0.26, 2.4, 5); trunkG.translate(0, 1.2, 0);
    const crownG = new THREE.IcosahedronGeometry(1.9, 0); crownG.translate(0, 3.8, 0);
    const trunks = new THREE.InstancedMesh(trunkG, M(new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 1 })), cnt);
    const crowns = new THREE.InstancedMesh(crownG, M(new THREE.MeshStandardMaterial({ roughness: 0.9, flatShading: true })), cnt);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), pp = new THREE.Vector3();
    const greens = [0x4f8a3a, 0x3f7a35, 0x5c9a40, 0x6a9f3c, 0x3c6e3f];
    let k = 0;
    const tmp = {};
    for (let i = 0; i + 1 < scen.t.length && k < cnt; i += 2) {
      const x = scen.t[i], z = scen.t[i + 1];
      if (track.projectGlobal(x, z, tmp).d < hw + 3) continue;
      const s = 0.8 + rng() * 0.7;
      pp.set(x, 0, z); q.setFromAxisAngle(V.set(0, 1, 0), rng() * 6.28); sc.set(s, s * (0.9 + rng() * 0.3), s);
      m4.compose(pp, q, sc);
      trunks.setMatrixAt(k, m4); crowns.setMatrixAt(k, m4);
      crowns.setColorAt(k, C.set(greens[Math.floor(rng() * greens.length)]));
      k++;
    }
    trunks.count = crowns.count = k;
    crowns.castShadow = shadows;
    group.add(trunks, crowns);
  }

  // ---- buildings: one merged mesh for walls (windows) and one for roofs
  const facadeMat = M(new THREE.MeshStandardMaterial({ map: TX.facade(), vertexColors: true, roughness: 0.75, metalness: 0.05, emissiveMap: TX.facadeLit(), emissive: 0xffffff, emissiveIntensity: 0 }));
  const roofMat = M(new THREE.MeshStandardMaterial({ map: TX.roofTex(), vertexColors: true, roughness: 0.9 }));
  {
    const walls = new Builder(), roofs = new Builder();
    const tmp = {};
    const inStand = (x, z) => stands.some(([sx, sz]) => Math.hypot(sx - x, sz - z) < 9);
    let count = 0;
    for (const rec of scen.b || []) {
      if (count > 4000) break;
      const h = rec[0], type = rec[1] | 0;
      const pts = [];
      for (let i = 2; i + 1 < rec.length; i += 2) pts.push([rec[i], rec[i + 1]]);
      if (pts.length < 3) continue;
      if (pts.some(([x, z]) => track.projectGlobal(x, z, tmp).d < hw + 3.5 || inStand(x, z))) continue;
      count++;
      const pal = PALETTES[type] || PALETTES[1];
      const col = C.set(pal[Math.floor(rng() * pal.length)]).clone();
      col.offsetHSL(0, 0, (rng() - 0.5) * 0.06);
      let area = 0;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], c = pts[(i + 1) % pts.length]; area += a[0] * c[1] - c[0] * a[1]; }
      const sgn = area > 0 ? 1 : -1;
      let u = rng() * 8;
      const vTop = h / 12;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], c = pts[(i + 1) % pts.length];
        const dx = c[0] - a[0], dz = c[1] - a[1], len = Math.hypot(dx, dz);
        if (len < 0.05) continue;
        const outN = [sgn * dz / len, 0, -sgn * dx / len];
        const u1 = u + len / 8;
        walls.quad([a[0], 0, a[1]], [c[0], 0, c[1]], [c[0], h, c[1]], [a[0], h, a[1]], [[u, 0], [u1, 0], [u1, vTop], [u, vTop]], col, outN);
        u = u1;
      }
      const v2 = pts.map(p => new THREE.Vector2(p[0], p[1]));
      let tris = [];
      try { tris = THREE.ShapeUtils.triangulateShape(v2, []); } catch { tris = []; }
      const rc = C.set(ROOFS[type]?.[Math.floor(rng() * ROOFS[type].length)] ?? 0x666666).clone();
      for (const t of tris) {
        const A = pts[t[0]], B = pts[t[1]], Cc = pts[t[2]];
        roofs.tri([A[0], h, A[1]], [B[0], h, B[1]], [Cc[0], h, Cc[1]], [A[0] / 10, A[1] / 10], [B[0] / 10, B[1] / 10], [Cc[0] / 10, Cc[1] / 10], rc, UP);
      }
    }
    if (!walls.empty) {
      const wm = new THREE.Mesh(walls.geometry(), facadeMat);
      wm.castShadow = shadows; wm.receiveShadow = shadows;
      group.add(wm);
    }
    if (!roofs.empty) group.add(new THREE.Mesh(roofs.geometry(), roofMat));
  }

  // ------------------------------------------------------------ api
  const boxT = { t: 0 };
  return {
    group, boxes, lights,
    center: { x: cx, z: cz }, radius: Math.max(b.maxX - b.minX, b.maxZ - b.minZ) / 2,
    applyTheme(th) {
      facadeMat.emissiveIntensity = th.windows;
      lampHeads.emissiveIntensity = th.lamps;
      poolMat.opacity = th.pools;
      boxMat.emissiveIntensity = th.windows > 0.5 ? 0.7 : 0.35;
    },
    update(dt, cam) {
      boxT.t += dt;
      if (cam) for (const sp of markers) {
        const d = Math.hypot(sp.position.x - cam.position.x, sp.position.z - cam.position.z);
        sp.material.opacity = Math.min(1, Math.max(0, (d - 18) / 25)) * Math.min(1, Math.max(0, (340 - d) / 80));
        sp.visible = (sp.userData.kind !== 'box' || this.boxesOn !== false) && sp.material.opacity > 0.01;
      }
      padTex.offset.y -= dt * 1.6;
      boxMat.color.setHSL((boxT.t * 0.12) % 1, 0.85, 0.62);
      boxMat.emissive.setHSL((boxT.t * 0.12 + 0.5) % 1, 0.9, 0.5);
      boxPillarMat.color.setHSL((boxT.t * 0.12) % 1, 0.9, 0.6);
      for (const g of boxes) {
        if (!g.visible) continue;
        const ph = g.userData.phase + boxT.t;
        g.userData.box.rotation.set(ph * 0.7, ph * 1.1, 0);
        g.userData.core.rotation.set(-ph * 1.5, ph, 0);
        g.position.y = 1.25 + Math.sin(ph * 2.2) * 0.18;
        g.userData.beam.position.y = -g.position.y + 0.05;
      }
    },
    setLights(state) {   // array of 4 colours or null
      lights.forEach((m, i) => {
        const c = state ? state[i] : null;
        m.emissive.set(c ?? 0x000000);
        m.color.set(c ? c : 0x220000);
      });
    },
    dispose() {
      group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      for (const m of mats) m.dispose();
      padTex.dispose(); gtex.dispose();
    },
  };
}
