// Three.js renderer: sky + lighting themes, the track world, car models and
// their effects, item meshes, chase / cinematic / garage cameras.
import * as THREE from 'three';
import { buildWorld, THEMES } from './world.js';
import { buildCar } from './cars.js';
import { FX } from './fx.js';
import * as TX from './textures.js';
import { F } from '../game.js';
import { clamp, damp, dampAngle, lerp, wrapAngle } from '../sim/util.js';

const SKY_VERT = `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`;
const SKY_FRAG = `
uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunCol; uniform float sunVis; uniform float flash;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 c = h > 0.0 ? mix(horizon, top, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(horizon, bottom, clamp(-h * 4.0, 0.0, 1.0));
  float s = max(dot(d, normalize(sunDir)), 0.0);
  c += sunCol * (pow(s, 900.0) * 3.0 + pow(s, 12.0) * 0.25) * sunVis;
  c += vec3(flash);
  gl_FragColor = vec4(c, 1.0);
}`;

const TIER_COL = [0xffffff, 0x3fa9ff, 0xffa23a, 0xc066ff];
const CAMS = {
  low:    { dist: 6.6, distK: 0.045, h: 2.6, look: 4, lookK: 0.06, lookY: 1.1 },
  normal: { dist: 7.6, distK: 0.04, h: 3.7, look: 10, lookK: 0.3, lookY: 0.5 },
  far:    { dist: 9.6, distK: 0.04, h: 5.0, look: 12, lookK: 0.35, lookY: 0.3 },
};

export class View {
  constructor(canvas, settings) {
    this.settings = settings;
    const q = this.quality = settings.quality || 'high';
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: q !== 'low', powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, q === 'high' ? 2 : q === 'medium' ? 1.5 : 1));
    this.renderer.shadowMap.enabled = q !== 'low';
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(68, 1, 0.3, 4000);
    this.camera.position.set(0, 60, 120);

    // sky
    this.skyU = {
      top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, bottom: { value: new THREE.Color() },
      sunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) }, sunCol: { value: new THREE.Color() }, sunVis: { value: 1 }, flash: { value: 0 },
    };
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), new THREE.ShaderMaterial({ uniforms: this.skyU, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: THREE.BackSide, depthWrite: false }));
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
    const sp = [];
    for (let i = 0; i < 1400; i++) {
      const u = Math.random() * 2 - 1, a = Math.random() * 6.283, r = Math.sqrt(1 - u * u);
      if (u < 0.05) continue;
      sp.push(Math.cos(a) * r * 1400, u * 1400, Math.sin(a) * r * 1400);
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 2, sizeAttenuation: false, transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
    this.stars.frustumCulled = false;
    this.scene.add(this.stars);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.5);
    this.sun.castShadow = q !== 'low';
    const sm = q === 'high' ? 2048 : 1024;
    this.sun.shadow.mapSize.set(sm, sm);
    const sc = this.sun.shadow.camera;
    sc.left = -70; sc.right = 70; sc.top = 70; sc.bottom = -70; sc.near = 10; sc.far = 400;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.headlight = new THREE.SpotLight(0xfff1d6, 0, 120, 0.6, 0.5, 1.2);
    this.scene.add(this.headlight, this.headlight.target);
    this.scene.fog = new THREE.Fog(0xcccccc, 200, 1500);

    this.carGroup = new THREE.Group(); this.itemGroup = new THREE.Group();
    this.scene.add(this.carGroup, this.itemGroup);
    this.fx = new FX(this.scene, this, q);
    this.world = null; this.track = null;
    this.cars = new Map();
    this.items = new Map();
    this.camState = { h: 0, pos: new THREE.Vector3(0, 40, 80), look: new THREE.Vector3(), fov: 68, shake: 0, mode: 'free', t: 0, cine: 0, cineT: 0 };
    this.themeName = 'day';
    this.setTheme('day');
    this.mode = 'menu';
    this.flashT = 0;
    this.garage = null;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.fx.setScale(h * this.renderer.getPixelRatio());
    if (this.garage) { this.garage.cam.aspect = w / h; this.garage.cam.updateProjectionMatrix(); }
  }

  setTheme(name) {
    const th = THEMES[name] || THEMES.day;
    this.themeName = name; this.theme = th;
    this.skyU.top.value.set(th.skyTop); this.skyU.horizon.value.set(th.skyHorizon); this.skyU.bottom.value.set(th.skyBottom);
    this.skyU.sunDir.value.set(...th.sunDir).normalize(); this.skyU.sunCol.value.set(th.sun); this.skyU.sunVis.value = th.sunVisible;
    this.scene.fog.color.set(th.fog); this.scene.fog.near = th.fogNear; this.scene.fog.far = th.fogFar;
    this.hemi.color.set(th.hemiSky); this.hemi.groundColor.set(th.hemiGround); this.hemi.intensity = th.hemiI;
    this.sun.color.set(th.sun); this.sun.intensity = th.sunI;
    this.renderer.toneMappingExposure = th.exposure;
    this.stars.visible = !!th.stars;
    this.headlight.intensity = name === 'night' ? 420 : name === 'sunset' ? 120 : 0;
    this.world?.applyTheme(th);
    for (const cv of this.cars.values()) cv.model.mats.head.emissiveIntensity = name === 'day' ? 1.2 : 3.5;
  }
  flashSky() { this.flashT = 0.35; }

  loadTrack(track, tod) {
    if (this.world) { this.scene.remove(this.world.group); this.world.dispose(); }
    this.track = track;
    this.world = buildWorld(track, this.quality);
    this.scene.add(this.world.group);
    this.setTheme(tod || this.themeName);
    this.world.setLights(null);
    const c = this.world.center;
    this.camState.pos.set(c.x + this.world.radius, 120, c.z + this.world.radius);
  }

  // ------------------------------------------------------------ cars
  addCar(id, info, isMe) {
    this.removeCar(id);
    const model = buildCar(info.car, info.color, info.build, { name: info.name, shadows: this.quality !== 'low' });
    this.carGroup.add(model.root);
    let tag = null;
    if (!isMe) {
      tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: TX.nameTag(info.name, info.color), depthTest: true, transparent: true, sizeAttenuation: false }));
      tag.scale.set(0.16, 0.04, 1);
      tag.renderOrder = 5;
      this.scene.add(tag);
    }
    model.mats.head.emissiveIntensity = this.themeName === 'day' ? 1.2 : 3.5;
    this.cars.set(id, { model, tag, isMe, wheelA: 0, roll: 0, pitch: 0, lastV: 0, spinA: 0, flip: 0, info, fxT: 0, hue: 0, ghost: 1 });
  }
  removeCar(id) {
    const cv = this.cars.get(id);
    if (!cv) return;
    this.carGroup.remove(cv.model.root);
    cv.model.dispose();
    if (cv.tag) { this.scene.remove(cv.tag); cv.tag.material.map.dispose(); cv.tag.material.dispose(); }
    this.cars.delete(id);
  }
  carPos(id) { const cv = this.cars.get(id); return cv ? cv.model.root.position : null; }

  poseCar(id, x, y, z, h, e, dt) {
    const cv = this.cars.get(id);
    if (!cv) return;
    const m = cv.model, c = e.c, root = m.root;
    const f = e.flags || 0;
    const boosting = c.boostT > 0, drifting = c.drift !== 0;
    root.position.set(x, y, z);
    // spin-outs and flips (visual only)
    let yawExtra = 0;
    const stunned = c.stunT > 0;
    if (stunned && c.stunKind === 'spin') { cv.spinA += dt * 13; yawExtra = cv.spinA; }
    else cv.spinA = 0;
    if (stunned && (c.stunKind === 'tumble' || c.stunKind === 'slam')) cv.flip = Math.min(cv.flip + dt * 7, Math.PI * 2);
    else cv.flip = 0;
    const trick = c.trickT > 0 ? (1 - (e.owned ? c.trickT / 0.55 : 0.5)) : 0;
    root.rotation.set(0, h + yawExtra + (drifting ? c.drift * -0.12 : 0), 0);
    // body roll / pitch from motion
    const speed = c.vf || 0;
    const acc = (speed - cv.lastV) / Math.max(dt, 1e-3);
    cv.lastV = speed;
    const yawRate = e.owned ? c.yaw : (e.steerVis || 0) * speed * 0.05;
    cv.roll = damp(cv.roll, clamp(yawRate * Math.abs(speed) * 0.0045 * (drifting ? 1.6 : 1), -0.12, 0.12), 8, dt);
    cv.pitch = damp(cv.pitch, clamp(-acc * 0.004, -0.06, 0.06), 6, dt);
    m.body.rotation.set(cv.pitch + cv.flip, 0, cv.roll + trick * Math.PI * 2, 'YXZ');
    // wheels
    cv.wheelA += speed * dt / m.wheelR;
    const steer = clamp((e.owned ? e.steerVis : e.steerVis) || 0, -1, 1);
    for (const w of m.wheels) {
      w.spin.rotation.x = cv.wheelA;
      if (w.front) w.pivot.rotation.y = -steer * 0.45;
    }
    // lights, flames, shields
    m.mats.tail.emissiveIntensity = (f & F.BRAKE) ? 3 : 0.7;
    const tier = c.driftTier || 0;
    for (const fl of m.flames) {
      fl.visible = boosting;
      if (boosting) { fl.scale.set(1, 1, 0.8 + Math.random() * 0.9 + (c.boostPow || 1) * 0.3); fl.material.color.set(c.invT > 0 ? 0xffd04a : 0x66c8ff); }
    }
    const sh = c.shieldT > 0 || c.mirrorT > 0;
    m.shield.visible = sh;
    if (sh) {
      m.shield.material.color.set(c.mirrorT > 0 ? 0xe8f0ff : 0x6fd6ff);
      m.shield.material.opacity = 0.18 + Math.sin(performance.now() / 120) * 0.06;
    }
    // rocket mode rainbow, ram glow
    if (c.invT > 0) { cv.hue = (cv.hue + dt * 1.5) % 1; m.mats.paint.emissive.setHSL(cv.hue, 1, 0.45); m.mats.paint.emissiveIntensity = 1; }
    else if (c.ramT > 0) { m.mats.paint.emissive.set(0xff2a1a); m.mats.paint.emissiveIntensity = 0.5 + Math.sin(performance.now() / 90) * 0.35; }
    else if (c.slowT > 0) { m.mats.paint.emissive.set(0x2a9dff); m.mats.paint.emissiveIntensity = 0.25 + Math.random() * 0.3; }
    else m.mats.paint.emissiveIntensity = 0;
    // ghost (respawn flicker / qualifying ghosts)
    const ghostSess = this.ghostOthers && !cv.isMe;
    const want = ghostSess ? 0.38 : c.ghostT > 0 ? (Math.floor(performance.now() / 90) % 2 ? 0.35 : 0.85) : 1;
    if (want !== cv.ghost) { cv.ghost = want; m.setOpacity(want); }
    // name tag
    if (cv.tag) { cv.tag.position.set(x, y + m.height + 1.1, z); cv.tag.visible = !this.hideTags; }
    // particles
    cv.fxT -= dt;
    if (cv.fxT <= 0 && this.mode !== 'garage') {
      cv.fxT = 1 / 40;
      const sx = Math.sin(root.rotation.y), sz = Math.cos(root.rotation.y), rx = -sz, rz = sx;
      const rear = m.rearZ + 0.4;
      if (drifting) {
        for (const s of [-1, 1]) {
          const px = x + sx * rear + rx * s * m.trackW, pz = z + sz * rear + rz * s * m.trackW;
          if (tier > 0) for (let k = 0; k < 2; k++) this.fx.spark(px, 0.25, pz, TIER_COL[tier], 4, 0.25, 0.28);
          if (Math.random() < 0.5) this.fx.smoke(px, 0.3, pz, -sx * 2, 0.5, -sz * 2, 0.9, 0.85, 0.28, 0.8, 2.4);
        }
      } else if (stunned || ((f & F.BRAKE) && Math.abs(speed) > 15)) {
        this.fx.smoke(x, 0.3, z, 0, 0.8, 0, 1, 0.85, 0.35, 0.8, 2.5);
      }
      if (boosting) for (const p of m.exhausts) {
        const wx = x + p.x * sz + p.z * sx, wz = z - p.x * sx + p.z * sz;
        this.fx.glowDot(wx, y + p.y, wz, -sx * 6, 0.5, -sz * 6, 0.18, 0.55, c.invT > 0 ? 0xffc040 : 0x7fd4ff, 0.9);
      }
      if (c.invT > 0) this.fx.glowDot(x + (Math.random() - 0.5) * 2, y + 0.5 + Math.random() * 1.5, z + (Math.random() - 0.5) * 2, 0, 1, 0, 0.5, 0.35, new THREE.Color().setHSL(Math.random(), 1, 0.6).getHex(), 1);
      if (f & F.WALL) this.fx.spark(x, 0.5, z, 0xffc070, 5, 0.3, 0.2);
      if (stunned && Math.random() < 0.4) this.fx.spark(x, 1.5, z, 0xffff80, 2, 0.5, 0.2);
    }
  }

  // ------------------------------------------------------------ items
  sessionStart(boxes, itemsOn, ghost = false) {
    this.mode = 'race';
    if (this.world) this.world.boxesOn = itemsOn;
    this.ghostOthers = ghost;
    if (this.world) for (const g of this.world.boxes) g.visible = itemsOn;
    this.itemsOn = itemsOn;
    for (const m of this.items.values()) this.itemGroup.remove(m);
    this.items.clear();
  }
  sessionEnd() {
    for (const m of this.items.values()) this.itemGroup.remove(m);
    this.items.clear();
    if (this.world) { this.world.setLights(null); for (const g of this.world.boxes) g.visible = true; }
    this.mode = 'lobby';
    this.ghostOthers = false;
  }
  boxShow(i, vis) { const g = this.world?.boxes[i]; if (g) g.visible = vis && this.itemsOn !== false; }

  makeItemMesh(o) {
    const g = new THREE.Group();
    const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.3, ...extra });
    switch (o.kind) {
      case 'oil': {
        const m = new THREE.Mesh(new THREE.CircleGeometry(1.9, 20).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0b0b10, roughness: 0.05, metalness: 0.9 }));
        m.position.y = 0.06; g.add(m);
        const sheen = new THREE.Mesh(new THREE.CircleGeometry(1.2, 16).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x7a3cff, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false }));
        sheen.position.set(0.3, 0.07, -0.2); g.add(sheen);
        break;
      }
      case 'mine': {
        const m = new THREE.Mesh(new THREE.BoxGeometry(1.7, 1.7, 1.7), new THREE.MeshStandardMaterial({ map: TX.mineFace(), transparent: true, opacity: 0.88, color: 0xff7a7a, emissive: 0xff2020, emissiveIntensity: 0.35, depthWrite: false }));
        g.add(m); g.userData.spin = m;
        break;
      }
      case 'bouncer': {
        const m = new THREE.Mesh(new THREE.IcosahedronGeometry(0.75, 1), std(0x48e05a, { emissive: 0x1fbf3a, emissiveIntensity: 0.8, flatShading: true }));
        g.add(m); g.userData.spin = m;
        break;
      }
      case 'missile': {
        const body = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 1.5, 10).rotateX(Math.PI / 2), std(0xe23c32));
        const nose = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.5, 10).rotateX(Math.PI / 2), std(0xf2f2f2));
        nose.position.z = 1.0;
        g.add(body, nose);
        for (let k = 0; k < 4; k++) { const fin = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.4, 0.35), std(0x222222)); fin.position.z = -0.6; fin.rotation.z = k * Math.PI / 2; fin.translateY(0.25); g.add(fin); }
        break;
      }
      case 'seeker': {
        const body = new THREE.Mesh(new THREE.OctahedronGeometry(0.8, 0), std(0x2f7cff, { emissive: 0x1a4fff, emissiveIntensity: 0.9, flatShading: true }));
        body.scale.set(1, 0.6, 1.6);
        const wing = new THREE.Mesh(new THREE.BoxGeometry(3, 0.08, 0.6), std(0x9fd0ff));
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.06, 6, 24).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x8fd8ff, toneMapped: false }));
        g.add(body, wing, ring); g.userData.spin = ring;
        break;
      }
    }
    g.traverse(o2 => { o2.castShadow = this.quality !== 'low'; });
    return g;
  }

  syncItems(world, dt) {
    for (const [id, m] of this.items) if (!world.objs.has(id)) { this.itemGroup.remove(m); this.items.delete(id); }
    for (const o of world.objs.values()) {
      let m = this.items.get(o.id);
      if (!m) { m = this.makeItemMesh(o); this.items.set(o.id, m); this.itemGroup.add(m); }
      m.position.set(o.x, o.kind === 'oil' ? 0 : o.y, o.z);
      if (o.kind === 'mine') m.position.y = 1.25 + Math.sin(performance.now() / 300) * 0.15;
      if (o.h != null) m.rotation.y = o.h;
      const sp = m.userData.spin;
      if (sp) { sp.rotation.y += dt * 3; sp.rotation.x += dt * 2; }
      if (o.kind === 'missile' && Math.random() < 0.8) this.fx.smoke(o.x, o.y, o.z, 0, 0.5, 0, 0.7, 0.9, 0.5, 0.6, 1.5);
      if (o.kind === 'seeker') { this.fx.glowDot(o.x, o.y, o.z, 0, 0, 0, 0.35, 0.8, 0x6fb0ff, 0.8); }
      if (o.kind === 'bouncer' && Math.random() < 0.5) this.fx.glowDot(o.x, o.y, o.z, 0, 0, 0, 0.25, 0.6, 0x7dff7a, 0.6);
    }
  }

  startLights(goT) {
    if (!this.world) return;
    if (goT < -3.2 || goT > 2.5) { if (this._lt !== 'off') { this.world.setLights(null); this._lt = 'off'; } return; }
    const R = 0xff2222, G2 = 0x22ff55;
    let st;
    if (goT >= 0) st = [G2, G2, G2, G2];
    else { const n = Math.min(3, Math.max(0, Math.floor(goT + 4))); st = [0, 1, 2].map(i => (i < n ? R : null)).concat([null]); }
    const key = st.join(',');
    if (key !== this._lt) { this.world.setLights(st); this._lt = key; }
  }

  shake(a) { this.camState.shake = Math.min(1, this.camState.shake + a); }

  // ------------------------------------------------------------ cameras
  // Chase camera; before the start it sweeps in from a high orbit.
  follow(e, o = {}) {
    if (!e) return;
    const cs = this.camState, cv = this.cars.get(e.id);
    if (!cv) return;
    const dt = this.dt || 1 / 60;
    const root = cv.model.root, c = e.c;
    const tx = root.position.x, ty = root.position.y, tz = root.position.z;
    if (o.cinematic) return this.cinematic(e, cv, dt);
    // heading the camera trails: the car's nose blended with its velocity direction
    const sp = Math.hypot(c.vx, c.vz);
    const velH = sp > 3 ? Math.atan2(c.vx, c.vz) : c.h;
    let want = c.stunT > 0 ? cs.h : c.drift ? c.h + wrapAngle(velH - c.h) * 0.55 : c.h;
    if (o.look) want += Math.PI;
    cs.h = dampAngle(cs.h, want, o.look ? 30 : 5.5, dt);
    // camera presets: low (old chase cam), normal, far - normal looks well down the road
    const cam = CAMS[this.settings.cam] || CAMS.normal;
    const dist = cam.dist + clamp(sp, 0, 50) * cam.distK;
    const hgt = cam.h + cv.model.height * 0.35;
    let px = tx - Math.sin(cs.h) * dist, pz = tz - Math.cos(cs.h) * dist, py = ty * 0.7 + hgt;
    const intro = o.goT != null && o.goT < -0.6 && o.goT > -6;
    if (intro) {
      const f = clamp((o.goT + 6) / 5.2, 0, 1), ease = f * f * (3 - 2 * f);
      const ang = c.h + Math.PI * 0.85 * (1 - ease);
      const r = lerp(28, dist, ease);
      px = tx - Math.sin(ang) * r; pz = tz - Math.cos(ang) * r; py = lerp(18, hgt, ease);
      cs.pos.set(px, py, pz);
    } else {
      cs.pos.x = damp(cs.pos.x, px, 12, dt); cs.pos.z = damp(cs.pos.z, pz, 12, dt); cs.pos.y = damp(cs.pos.y, py, 6, dt);
    }
    const look = cam.look + clamp(sp, 0, 45) * cam.lookK;
    cs.look.set(tx + Math.sin(cs.h) * look, ty + cam.lookY, tz + Math.cos(cs.h) * look);
    const boost = c.boostT > 0 ? 1 : 0;
    cs.fov = damp(cs.fov, 66 + clamp(sp, 0, 45) * 0.32 + boost * 7, 4, dt);
    this.applyCam(cs);
    // shadows + headlights follow the action
    this.followLights(tx, tz, c.h, ty);
  }

  // Attract mode / spectator TV director.
  cinematic(e, cv, dt) {
    const cs = this.camState, root = cv.model.root, c = e.c;
    cs.cineT -= dt;
    if (cs.cineT <= 0 || cs.cineId !== e.id) {
      cs.cineT = 5 + Math.random() * 3; cs.cine = (cs.cine + 1 + Math.floor(Math.random() * 2)) % 3; cs.cineId = e.id;
      if (cs.cine === 1 && this.track) {
        const pr = this.track.pointAt(c.lastS + 45 + Math.random() * 30);
        const side = Math.random() < 0.5 ? 1 : -1, off = this.track.halfW + 6;
        cs.fixed = new THREE.Vector3(pr.x + pr.nx * side * off, 2.2 + Math.random() * 3, pr.z + pr.nz * side * off);
      }
    }
    const t = root.position;
    if (cs.cine === 0) {        // low chase
      cs.h = dampAngle(cs.h, c.h, 3, dt);
      cs.pos.set(t.x - Math.sin(cs.h) * 7.5, t.y + 2.2, t.z - Math.cos(cs.h) * 7.5);
      cs.look.set(t.x, t.y + 1, t.z);
    } else if (cs.cine === 1 && cs.fixed) {   // trackside camera
      cs.pos.copy(cs.fixed);
      cs.look.lerp(new THREE.Vector3(t.x, t.y + 0.8, t.z), 1 - Math.exp(-dt * 10));
    } else {                    // helicopter orbit
      cs.t += dt * 0.25;
      cs.pos.set(t.x + Math.sin(cs.t) * 26, t.y + 14, t.z + Math.cos(cs.t) * 26);
      cs.look.set(t.x, t.y, t.z);
    }
    cs.fov = 55;
    this.applyCam(cs, true);
    this.followLights(t.x, t.z, c.h, t.y);
  }

  // Slow orbit above the track (lobby / no session).
  orbit(dt) {
    if (!this.world) return;
    const cs = this.camState, c = this.world.center, r = this.world.radius;
    cs.t += dt * 0.05;
    cs.pos.set(c.x + Math.sin(cs.t) * (r + 120), 90 + r * 0.25, c.z + Math.cos(cs.t) * (r + 120));
    cs.look.set(c.x, 0, c.z);
    cs.fov = 55;
    this.applyCam(cs, true);
    // Shadows only near the middle: a map-sized shadow box is too coarse and shimmers as we orbit.
    this.followLights(c.x, c.z, 0, 0, 160);
  }

  applyCam(cs, noShake) {
    const cam = this.camera;
    cam.position.copy(cs.pos);
    if (!noShake && cs.shake > 0) {
      const s = cs.shake * cs.shake * 0.6;
      cam.position.x += (Math.random() - 0.5) * s; cam.position.y += (Math.random() - 0.5) * s; cam.position.z += (Math.random() - 0.5) * s;
    }
    cs.shake = Math.max(0, cs.shake - (this.dt || 0.016) * 2.2);
    cam.lookAt(cs.look);
    if (Math.abs(cam.fov - cs.fov) > 0.05) { cam.fov = cs.fov; cam.updateProjectionMatrix(); }
  }

  followLights(x, z, h, y = 0, box = 70) {
    const d = this.skyU.sunDir.value;
    this.sun.position.set(x + d.x * 200, d.y * 200, z + d.z * 200);
    this.sun.target.position.set(x, 0, z);
    const sc = this.sun.shadow.camera;
    if (sc.right !== box) { sc.left = -box; sc.right = box; sc.top = box; sc.bottom = -box; sc.updateProjectionMatrix(); }
    if (this.headlight.intensity > 0) {
      this.headlight.position.set(x + Math.sin(h) * 1.5, y + 1.4, z + Math.cos(h) * 1.5);
      this.headlight.target.position.set(x + Math.sin(h) * 45, 0, z + Math.cos(h) * 45);
    }
  }

  // ------------------------------------------------------------ garage turntable
  showGarage(type, color, build, name) {
    if (!this.garage) {
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x0d1020);
      scene.fog = new THREE.Fog(0x0d1020, 14, 40);
      const cam = new THREE.PerspectiveCamera(36, innerWidth / innerHeight, 0.1, 100);
      scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x1a1420, 1.1));
      const key = new THREE.DirectionalLight(0xffffff, 3); key.position.set(5, 8, 6); key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      const rim = new THREE.DirectionalLight(0xff8a4a, 2.2); rim.position.set(-6, 3, -6);
      const rim2 = new THREE.DirectionalLight(0x4ab8ff, 1.6); rim2.position.set(6, 2, -5);
      scene.add(key, rim, rim2);
      const plat = new THREE.Mesh(new THREE.CylinderGeometry(4.2, 4.4, 0.25, 64), new THREE.MeshStandardMaterial({ color: 0x1d2236, metalness: 0.6, roughness: 0.35 }));
      plat.position.y = -0.125; plat.receiveShadow = true;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(4.3, 0.04, 8, 96).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xff6b2c, toneMapped: false }));
      ring.position.y = 0.02;
      const floor = new THREE.Mesh(new THREE.CircleGeometry(40, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0b0e1a, roughness: 0.9 }));
      floor.position.y = -0.25; floor.receiveShadow = true;
      scene.add(plat, ring, floor);
      this.garage = { scene, cam, car: null, ang: 0.6, drag: false, holder: new THREE.Group() };
      scene.add(this.garage.holder);
      const cv = this.renderer.domElement;
      let lx = 0;
      const down = ev => { if (this.mode !== 'garage') return; this.garage.drag = true; lx = ev.clientX; };
      const move = ev => { if (this.garage.drag) { this.garage.ang -= (ev.clientX - lx) * 0.01; lx = ev.clientX; } };
      cv.addEventListener('pointerdown', down); addEventListener('pointermove', move); addEventListener('pointerup', () => { this.garage.drag = false; });
    }
    const gr = this.garage;
    if (gr.car) { gr.holder.remove(gr.car.root); gr.car.dispose(); }
    gr.car = buildCar(type, color, build, { name, shadows: true });
    gr.car.mats.head.emissiveIntensity = 2;
    gr.holder.add(gr.car.root);
    this.mode = 'garage';
  }
  hideGarage(mode = 'menu') { if (this.mode === 'garage') this.mode = mode; }

  render(dt) {
    this.dt = dt;
    if (this.mode === 'garage' && this.garage) {
      const gr = this.garage;
      if (!gr.drag) gr.ang += dt * 0.25;
      const r = 9.5;
      gr.cam.position.set(Math.sin(gr.ang) * r, 3.1, Math.cos(gr.ang) * r);
      gr.cam.lookAt(0, 0.7, 0);
      gr.car.wheels.forEach(w => { if (w.front) w.pivot.rotation.y = Math.sin(performance.now() / 1400) * 0.25; });
      this.renderer.render(gr.scene, gr.cam);
      return;
    }
    const orbiting = this.mode === 'lobby' || this.mode === 'menu';
    if (orbiting) this.orbit(dt);
    // The orbit camera is hundreds of metres out: a far-off near plane buys the depth
    // precision that keeps millimetre-thin map layers from flickering.
    const near = orbiting && this.world ? 8 : 0.3;
    if (this.camera.near !== near) { this.camera.near = near; this.camera.updateProjectionMatrix(); }
    this.world?.update(dt, this.camera);
    this.fx.update(dt);
    if (this.flashT > 0) { this.flashT -= dt; this.skyU.flash.value = Math.max(0, this.flashT) * 1.5; }
    this.sky.position.copy(this.camera.position);
    this.stars.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}
