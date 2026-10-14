// Particles (two pooled point clouds: additive glow + normal-blended smoke)
// and one-shot effects (rings, flashes, lightning bolts, grapple lines).
import * as THREE from 'three';
import * as TX from './textures.js';

const VERT = `
attribute float size; attribute float alpha; attribute vec3 color;
varying float vA; varying vec3 vC;
uniform float scale;
void main() {
  vA = alpha; vC = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = size * scale / max(0.5, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = `
uniform sampler2D map; varying float vA; varying vec3 vC;
void main() {
  vec4 t = texture2D(map, gl_PointCoord);
  gl_FragColor = vec4(vC, t.a * vA);
  if (gl_FragColor.a < 0.01) discard;
}`;

class Particles {
  constructor(scene, max, additive) {
    this.max = max; this.next = 0;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max); this.alpha = new Float32Array(max);
    this.vel = new Float32Array(max * 3); this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max); this.grow = new Float32Array(max); this.drag = new Float32Array(max); this.a0 = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    this.attrs = {
      position: new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage),
      color: new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage),
      size: new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage),
      alpha: new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage),
    };
    for (const [k, a] of Object.entries(this.attrs)) g.setAttribute(k, a);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 400 }, map: { value: TX.glowDisc() } },
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
    scene.add(this.points);
    this.active = 0;
  }
  emit(x, y, z, vx, vy, vz, life, size, color, alpha = 1, grav = 0, grow = 0, drag = 0) {
    const i = this.next; this.next = (this.next + 1) % this.max;
    const i3 = i * 3;
    this.pos[i3] = x; this.pos[i3 + 1] = y; this.pos[i3 + 2] = z;
    this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
    this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
    this.life[i] = this.maxLife[i] = life; this.size[i] = size; this.a0[i] = alpha; this.alpha[i] = alpha;
    this.grav[i] = grav; this.grow[i] = grow; this.drag[i] = drag;
  }
  update(dt) {
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { if (this.alpha[i] !== 0) this.alpha[i] = 0; continue; }
      this.life[i] -= dt;
      const i3 = i * 3, d = Math.exp(-this.drag[i] * dt);
      this.vel[i3] *= d; this.vel[i3 + 1] = this.vel[i3 + 1] * d - this.grav[i] * dt; this.vel[i3 + 2] *= d;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      if (this.pos[i3 + 1] < 0.05 && this.grav[i] > 0) { this.pos[i3 + 1] = 0.05; this.vel[i3 + 1] *= -0.3; }
      this.size[i] += this.grow[i] * dt;
      const f = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alpha[i] = this.a0[i] * Math.min(1, f * 2.2) * (f < 1 ? 1 : 0);
    }
    for (const a of Object.values(this.attrs)) a.needsUpdate = true;
  }
}

const C = new THREE.Color();
const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;

export class FX {
  constructor(scene, view, quality = 'high') {
    this.scene = scene; this.view = view;
    const k = quality === 'low' ? 0.4 : 1;
    this.glow = new Particles(scene, Math.floor(5000 * k), true);
    this.smk = new Particles(scene, Math.floor(3000 * k), false);
    this.temps = [];
    this.ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
    this.flashGeo = new THREE.SphereGeometry(1, 14, 10);
  }
  setScale(h) { this.glow.mat.uniforms.scale.value = h * 0.5; this.smk.mat.uniforms.scale.value = h * 0.5; }

  spark(x, y, z, color, speed = 6, life = 0.4, size = 0.25) {
    this.glow.emit(x, y, z, rnd(speed), Math.random() * speed * 0.8, rnd(speed), life * (0.6 + Math.random() * 0.6), size, C.set(color), 1, 14, 0, 1.5);
  }
  sparks(x, y, z, n, color) { for (let i = 0; i < Math.min(40, n); i++) this.spark(x, y, z, color, 7, 0.45, 0.22); }
  glowDot(x, y, z, vx, vy, vz, life, size, color, alpha = 1, grow = 0) { this.glow.emit(x, y, z, vx, vy, vz, life, size, C.set(color), alpha, 0, grow, 1); }
  smoke(x, y, z, vx, vy, vz, size, gray = 0.8, alpha = 0.5, life = 1.2, grow = 2.5) {
    C.setRGB(gray, gray, gray);
    this.smk.emit(x, y, z, vx, vy, vz, life * (0.7 + Math.random() * 0.6), size, C, alpha, -0.4, grow, 1.4);
  }
  explosion(x, y, z, r, color) {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * 6.283, s = (0.5 + Math.random()) * r * 4;
      this.glow.emit(x, y, z, Math.cos(a) * s, Math.random() * r * 5, Math.sin(a) * s, 0.5 + Math.random() * 0.4, r * 0.9, C.set(color), 1, 6, -r, 2.2);
    }
    for (let i = 0; i < 18; i++) this.smoke(x + rnd(r), y + Math.random() * r, z + rnd(r), rnd(3), 2 + Math.random() * 3, rnd(3), r * 1.4, 0.25, 0.6, 1.6, r * 1.5);
    this.flash(x, y, z, r * 1.6, color, 0.25);
  }
  flash(x, y, z, r, color, dur = 0.2) {
    const m = new THREE.Mesh(this.flashGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    m.position.set(x, y, z); m.scale.setScalar(r * 0.4);
    this.scene.add(m);
    this.temps.push({ obj: m, t: 0, dur, upd: (o, f) => { o.scale.setScalar(r * (0.4 + f * 0.8)); o.material.opacity = 0.8 * (1 - f); } });
  }
  poof(x, y, z) { for (let i = 0; i < 10; i++) this.smoke(x, y, z, rnd(3), Math.random() * 2, rnd(3), 1.2, 0.85, 0.6, 0.7, 2); this.sparks(x, y, z, 6, 0xffffff); }
  splat(x, z) {
    for (let i = 0; i < 16; i++) this.smoke(x, 0.3, z, rnd(5), 2 + Math.random() * 4, rnd(5), 0.6, 0.05, 0.9, 0.7, 0.5);
  }
  boxBurst(x, z) {
    for (let i = 0; i < 18; i++) this.glow.emit(x, 1.3, z, rnd(7), Math.random() * 6, rnd(7), 0.6, 0.35, C.setHSL(Math.random(), 0.9, 0.6), 1, 10, 0, 1);
  }
  ring(x, z, r, color) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    m.position.set(x, 0.4, z);
    this.scene.add(m);
    this.temps.push({ obj: m, t: 0, dur: 0.55, upd: (o, f) => { o.scale.setScalar(1 + f * r); o.material.opacity = 0.9 * (1 - f); } });
  }
  blink(x, z) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 6, 18, 1, true), new THREE.MeshBasicMaterial({ color: 0xb06bff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, toneMapped: false }));
    m.position.set(x, 3, z);
    this.scene.add(m);
    this.temps.push({ obj: m, t: 0, dur: 0.45, upd: (o, f) => { o.scale.set(1 - f * 0.8, 1 + f, 1 - f * 0.8); o.material.opacity = 0.7 * (1 - f); }, geo: true });
    for (let i = 0; i < 16; i++) this.glow.emit(x + rnd(1.5), Math.random() * 3, z + rnd(1.5), 0, 3 + Math.random() * 4, 0, 0.5, 0.35, C.set(0xd7a6ff), 1, 0, 0, 0);
  }
  lightning(cars, byId) {
    for (const e of cars.values()) {
      if (e.id === byId) continue;
      const c = e.c, pts = [];
      let x = c.x + rnd(6), z = c.z + rnd(6);
      for (let y = 40; y >= 0; y -= 5) { pts.push(new THREE.Vector3(x, y, z)); x += (c.x - x) * 0.3 + rnd(1.5); z += (c.z - z) * 0.3 + rnd(1.5); }
      pts.push(new THREE.Vector3(c.x, 0.8, c.z));
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xfff6a0, transparent: true, toneMapped: false }));
      this.scene.add(line);
      this.temps.push({ obj: line, t: 0, dur: 0.35, upd: (o, f) => { o.material.opacity = (1 - f) * (Math.random() < 0.5 ? 1 : 0.3); }, geo: true });
      this.flash(c.x, 1, c.z, 3, 0xfff6a0, 0.3);
    }
    this.view.flashSky?.();
  }
  grapple(byId, tId) {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xffd23f, toneMapped: false, transparent: true }));
    line.frustumCulled = false;
    this.scene.add(line);
    this.temps.push({ obj: line, t: 0, dur: 0.7, geo: true, upd: (o, f) => {
      const a = this.view.carPos(byId), b = this.view.carPos(tId);
      if (!a || !b) return;
      const p = o.geometry.attributes.position;
      p.setXYZ(0, a.x, a.y + 1, a.z); p.setXYZ(1, b.x, b.y + 1, b.z); p.needsUpdate = true;
      o.material.opacity = 1 - f * f;
    } });
  }
  confetti(x, z) {
    for (let i = 0; i < 120; i++) this.glow.emit(x + rnd(4), 6 + Math.random() * 6, z + rnd(4), rnd(5), Math.random() * 4, rnd(5), 2.5 + Math.random(), 0.32, C.setHSL(Math.random(), 0.9, 0.6), 1, 4, 0, 1.2);
  }
  abilityBurst(x, z, a) {
    const col = { nitro: 0x4ab8ff, ram: 0xff4a3a, blink: 0xb06bff, emp: 0x5ad8ff, oil3: 0x333333, grapple: 0xffd23f, slam: 0xffe7a8, mirror: 0xd8e6ff }[a] || 0xffffff;
    this.ring(x, z, 4, col);
  }
  update(dt) {
    this.glow.update(dt); this.smk.update(dt);
    for (let i = this.temps.length - 1; i >= 0; i--) {
      const t = this.temps[i];
      t.t += dt;
      const f = Math.min(1, t.t / t.dur);
      t.upd(t.obj, f);
      if (f >= 1) {
        this.scene.remove(t.obj);
        t.obj.material.dispose();
        if (t.geo) t.obj.geometry.dispose();
        this.temps.splice(i, 1);
      }
    }
  }
}
