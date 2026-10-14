// Keyboard + gamepad. Keyboard steering is ramped so tapping feels precise
// and holding feels smooth; gamepads get analog steering/throttle/brake.
const BIND = {
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  drift: ['Space', 'ShiftLeft', 'ShiftRight'], item: ['KeyE', 'KeyK'], ability: ['KeyQ', 'KeyL'], look: ['KeyC'], respawn: ['KeyR'],
  quick1: ['Digit1'], quick2: ['Digit2'], quick3: ['Digit3'], quick4: ['Digit4'],
  shiftUp: ['KeyX', 'PageUp'], shiftDown: ['KeyZ', 'PageDown'],
};
export const KEY_HELP = [
  ['Accelerate / brake & reverse', 'W / S  or  ↑ / ↓', 'RT / LT  (or A / B)'],
  ['Steer', 'A / D  or  ← / →', 'Left stick / D-pad'],
  ['Hop & drift (hold through corners)', 'Space or Shift', 'RB / LB'],
  ['Use item (hold brake to fire backwards)', 'E or K', 'X'],
  ['Car ability (when the meter is full)', 'Q or L', 'Y'],
  ['Shift up / down (manual gearbox, see Settings)', 'X / Z', 'Right stick → / ←'],
  ['Look behind', 'C', 'Right stick click'],
  ['Respawn on the road', 'R', 'D-pad down'],
  ['Standings', 'Tab (hold)', 'Back / View'],
  ['Chat  /  quick chat', 'T or Enter  /  1-4', '-'],
  ['Menu', 'Esc', 'Start'],
];
const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable); };

export class Input {
  constructor() {
    this.keys = new Set();
    this.edges = new Set();
    this.enabled = true;
    this.steerK = 0;
    this.padIdx = null; this.padPrev = []; this.usingPad = false; this.rsPrev = 0;
    this.out = { throttle: 0, brake: 0, steer: 0, drift: false, driftP: false, itemP: false, abilityP: false, look: false, respawnP: false, quick: 0, specNext: false, specPrev: false, tab: false, usingPad: false, shiftUp: false, shiftDown: false };
    addEventListener('keydown', e => {
      if (typing()) return;
      if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!e.repeat) this.edges.add(e.code);
      this.keys.add(e.code);
      this.usingPad = false;
    });
    addEventListener('keyup', e => { this.keys.delete(e.code); });
    addEventListener('blur', () => this.keys.clear());
    addEventListener('gamepadconnected', e => { this.padIdx = e.gamepad.index; this.onPad?.(e.gamepad); });
    addEventListener('gamepaddisconnected', e => { if (this.padIdx === e.gamepad.index) this.padIdx = null; });
  }
  down(a) { return BIND[a].some(k => this.keys.has(k)); }
  pressed(a) { return BIND[a].some(k => this.edges.has(k)); }

  pad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    let gp = this.padIdx != null ? pads[this.padIdx] : null;
    if (!gp) for (const p of pads) if (p && p.connected) { gp = p; this.padIdx = p.index; break; }
    if (!gp) return null;
    const b = i => !!gp.buttons[i]?.pressed, v = i => gp.buttons[i]?.value || 0;
    const edge = i => b(i) && !this.padPrev[i];
    const dz = x => { const a = Math.abs(x); return a < 0.12 ? 0 : Math.sign(x) * Math.pow((a - 0.12) / 0.88, 1.35); };
    let steer = dz(gp.axes[0] || 0);
    if (b(14)) steer = -1; if (b(15)) steer = 1;
    // right stick flicks change gear (manual gearbox)
    const rx = gp.axes[2] || 0, rs = rx > 0.6 ? 1 : rx < -0.6 ? -1 : Math.abs(rx) < 0.3 ? 0 : this.rsPrev;
    const flick = rs !== this.rsPrev ? rs : 0;
    this.rsPrev = rs;
    const st = {
      shiftUp: flick > 0, shiftDown: flick < 0,
      throttle: Math.max(v(7), b(0) ? 1 : 0), brake: Math.max(v(6), b(1) ? 1 : 0), steer,
      drift: b(4) || b(5), driftP: edge(4) || edge(5), itemP: edge(2), abilityP: edge(3),
      look: b(11) || (gp.axes[3] || 0) > 0.7, respawnP: edge(13), tab: b(8), pauseP: edge(9),
      specNext: edge(15), specPrev: edge(14),
    };
    const active = gp.buttons.some(x => x.pressed) || Math.abs(gp.axes[0] || 0) > 0.3;
    if (active) this.usingPad = true;
    this.padPrev = gp.buttons.map(x => x.pressed);
    this.padState = st;
    return st;
  }

  sample(dt) {
    const o = this.out, on = this.enabled && !typing();
    const p = this.pad();
    const kL = on && this.down('left'), kR = on && this.down('right');
    const target = (kR ? 1 : 0) - (kL ? 1 : 0);
    const rate = target === 0 || Math.sign(target) !== Math.sign(this.steerK) ? 11 : 6.5;
    this.steerK += Math.max(-rate * dt, Math.min(rate * dt, target - this.steerK));
    o.throttle = on && this.down('up') ? 1 : 0;
    o.brake = on && this.down('down') ? 1 : 0;
    o.steer = this.steerK;
    o.drift = on && this.down('drift');
    o.driftP = on && this.pressed('drift');
    o.itemP = on && this.pressed('item');
    o.abilityP = on && this.pressed('ability');
    o.look = on && this.down('look');
    o.respawnP = on && this.pressed('respawn');
    o.quick = !on ? 0 : this.pressed('quick1') ? 1 : this.pressed('quick2') ? 2 : this.pressed('quick3') ? 3 : this.pressed('quick4') ? 4 : 0;
    o.specNext = on && (this.edges.has('ArrowRight') || this.edges.has('KeyD'));
    o.specPrev = on && (this.edges.has('ArrowLeft') || this.edges.has('KeyA'));
    o.tab = on && this.keys.has('Tab');
    o.shiftUp = on && this.pressed('shiftUp');
    o.shiftDown = on && this.pressed('shiftDown');
    if (p && on) {
      o.throttle = Math.max(o.throttle, p.throttle); o.brake = Math.max(o.brake, p.brake);
      if (Math.abs(p.steer) > Math.abs(o.steer)) o.steer = p.steer;
      o.drift ||= p.drift; o.driftP ||= p.driftP; o.itemP ||= p.itemP; o.abilityP ||= p.abilityP;
      o.look ||= p.look; o.respawnP ||= p.respawnP; o.tab ||= p.tab;
      o.specNext ||= p.specNext; o.specPrev ||= p.specPrev;
      o.shiftUp ||= p.shiftUp; o.shiftDown ||= p.shiftDown;
      if (p.pauseP) this.onPause?.();
    }
    o.usingPad = this.usingPad;
    this.edges.clear();
    return o;
  }
}
