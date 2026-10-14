// Entry point: wires renderer, UI, networking and the frame loop.
import { View } from './render/view.js';
import { HUD } from './ui/hud.js';
import { UI } from './ui/ui.js';
import { Garage } from './ui/garage.js';
import { Studio } from './ui/studio.js';
import { Audio } from './audio.js';
import { Input } from './input.js';
import { Profile, TrackStore } from './profile.js';
import { Game } from './game.js';
import { HostServer } from './server.js';
import { HostNet, ClientNet, randomCode, normalizeCode, probePublicRooms, claimPublicSlot } from './net.js';
import { NET } from './sim/config.js';
import { VERSION, BUILD } from './version.js';
import { Account } from './account.js';
import { PRESETS, buildPreset } from './sim/presets.js';

const $ = id => document.getElementById(id);
const profile = new Profile();
const store = new TrackStore();
const audio = new Audio(profile.settings);
const input = new Input();
let view;
try { view = new View($('gl'), profile.settings); }
catch (err) {
  document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;color:#fff">HOME TURF needs WebGL. Please enable hardware acceleration or try another browser.</div>';
  throw err;
}
const hud = new HUD(profile);

const account = new Account(profile, store);
const app = {
  profile, store, audio, view, input, hud, account,
  server: null, net: null, game: null, isHost: false, myId: null, room: null, attract: null,
  inSession() { return !!(this.game?.session && this.room?.phase === 'session'); },
};
const ui = new UI(app);
app.ui = ui;
$('fps').classList.toggle('hidden', !profile.settings.showFps);

const garage = new Garage({
  profile, view, audio, store, toast: (m, c) => ui.toast(m, c),
  onChange: () => app.sendProfile(),
  currentTrack: () => app.game?.trackData || null,
});
const studio = new Studio({ toast: (m, c) => ui.toast(m, c), profile, store, onBuilt: data => onStudioBuilt(data) });

// ------------------------------------------------------------ bridges
function makeBridge() {
  return {
    onRoom: (room, g) => { app.room = room; ui.onRoom(room, g); document.title = room.code ? `HOME TURF - ${room.code.toUpperCase()}` : 'HOME TURF'; },
    onChat: m => ui.onChat(m),
    onTrack: () => ui.loading(null),
    onTrackProgress: f => ui.loading(f < 1 ? (f > 0 ? `Downloading the track... ${Math.round(f * 100)}%` : 'Downloading the track...') : null),
    onSessionStart: s => ui.onSessionStart(s),
    onKicked: () => { leave(); ui.toast('The host removed you from the room.', 'err'); },
    quickChat: i => ui.quickChat(i),
    cinematicSpectate: false,
  };
}
const mutedAudio = { sfx() {}, frame: (g, dt) => audio.frame(null, dt), sessionStart() {}, sessionEnd() {} };
const stubUI = { onRoom() {}, onChat() {}, onTrack() {}, onSessionStart() {}, onKicked() {}, quickChat() {}, cinematicSpectate: true };

// ------------------------------------------------------------ attract mode
function startAttract() {
  if (app.attract || app.game) return;
  let server = null;
  const game = new Game({ view, hud, audio: mutedAudio, input, profile, ui: stubUI, send: m => server.receive('p0', m), myId: 'p0', isHost: true, offline: true });
  game.attract = true;
  const tods = ['day', 'day', 'sunset', 'night'];
  server = new HostServer({
    net: null, hello: { name: 'Director', car: 'comet' }, onLocal: m => game.onMessage(m), hostSpectates: true,
    saved: { bots: 8, laps: 50, items: true, abilities: true, botLevel: 2, tod: tods[Math.floor(Math.random() * tods.length)], mode: 'race' },
  });
  server.setTrack(buildPreset(PRESETS[Math.floor(Math.random() * PRESETS.length)].key));
  server.startSession('race');
  app.attract = { game, server, switchT: 6 };
  view.mode = 'race';
}
function stopAttract() {
  const a = app.attract;
  if (!a) return;
  a.game.endSession();
  a.server.destroy();
  app.attract = null;
}

// ------------------------------------------------------------ rooms
function createHostRoom({ net = null, code = null, pub = false }) {
  stopAttract();
  let server = null;
  const game = new Game({ view, hud, audio, input, profile, ui: makeBridge(), send: m => server.receive('p0', m), myId: 'p0', isHost: true, offline: !net });
  server = new HostServer({ net, hello: profile.hello(), onLocal: m => game.onMessage(m), code, saved: { ...profile.d.host, public: pub } });
  Object.assign(app, { server, net, game, isHost: true, myId: 'p0' });
  view.mode = 'lobby';
  return server;
}

async function defaultTrack() {
  const id = profile.d.host.trackId;
  if (id?.startsWith('preset-')) return buildPreset(id.slice(7));
  if (id) { try { const t = await store.get(id); if (t) return t; } catch { /* ignore */ } }
  return buildPreset('downtown');
}

app.quickRace = async () => {
  audio.init();
  const server = createHostRoom({});
  server.setTrack(await defaultTrack());
  server.setSettings({ mode: 'race', bots: Math.max(5, server.settings.bots) });
  ui.enterLobby();
  server.startSession('race');
};

app.host = async ({ pub }) => {
  audio.init();
  ui.loading('Opening your room...');
  let net = null, code = null;
  try {
    if (pub) { net = await claimPublicSlot(); code = net.code; }
    else { net = new HostNet(); code = randomCode(); await net.start(code); }
  } catch (err) {
    ui.loading(null);
    try { net?.destroy(); } catch { /* ignore */ }
    const ok = await ui.modal({ title: "Couldn't reach the matchmaking server", body: `<p>${err.message || err}</p><p>You can still race offline against bots.</p>`, buttons: [{ label: 'Cancel', value: false }, { label: 'Play offline', value: true, cls: 'primary' }] });
    if (!ok) return;
    net = null; code = null;
  }
  ui.loading(null);
  const server = createHostRoom({ net, code, pub });
  server.setTrack(await defaultTrack());
  ui.enterLobby();
  if (net) ui.toast(`Room ${code.toUpperCase()} is open - share the code!`, 'good');
  if (net && !net.peer) ui.toast('Direct connections are blocked here - friends will join through the relay.', '');
};

app.join = async raw => {
  const code = normalizeCode(raw);
  if (!code) { $('join-err').textContent = 'Enter a room code.'; return; }
  audio.init();
  $('join-err').textContent = '';
  ui.loading('Joining room...');
  const net = new ClientNet();
  try {
    const welcome = await net.connect(code, { t: 'hello', proto: NET.PROTO, ver: VERSION, ...profile.hello() }, { mode: profile.settings.net });
    stopAttract();
    const game = new Game({ view, hud, audio, input, profile, ui: makeBridge(), send: (m, rel) => net.send(m, rel), myId: welcome.id, isHost: false });
    net.onMessage = m => game.onMessage(m);
    net.onClose = () => { if (app.net === net) { leave(); ui.modal({ title: 'Disconnected', body: '<p>The host closed the room or the connection dropped.</p>' }); } };
    Object.assign(app, { server: null, net, game, isHost: false, myId: welcome.id });
    view.mode = 'lobby';
    ui.enterLobby();
    game.onMessage(welcome.room);
    history.replaceState(null, '', location.pathname);
    if (net.via === 'relay') ui.toast('Connected through the relay server (a direct link was blocked).', '');
  } catch (err) {
    net.destroy();
    $('join-err').textContent = err.message;
    ui.toast(err.message, 'err');
  } finally { ui.loading(null); }
};

app.listRooms = async () => {
  const rooms = await probePublicRooms();
  return rooms.filter(r => r.proto === NET.PROTO);
};

function leave() {
  const { game, server, net } = app;
  Object.assign(app, { server: null, net: null, game: null, isHost: false, myId: null, room: null });
  try { game?.endSession(); } catch { /* ignore */ }
  try { server ? server.destroy() : net?.destroy(); } catch { /* ignore */ }
  hud.show(false);
  ui.overlay('s-results', false); ui.overlay('s-pause', false);
  ui.closeChat();
  document.title = 'HOME TURF';
  view.mode = 'menu';
  ui.stack = [];
  ui.show('s-menu');
  startAttract();
}
app.leave = leave;

app.chat = text => { if (app.game) app.game.send({ t: 'chat', text }); };
app.sendProfile = () => { if (app.game) app.game.send({ t: 'prof', ...profile.hello() }); };
app.hostSet = patch => {
  if (!app.server) return;
  app.server.setSettings(patch);
  const { public: _p, ...keep } = app.server.settings;
  Object.assign(profile.d.host, keep);
  profile.save();
  if ('public' in patch && app.net) ui.toast(patch.public ? 'Public listing needs a fresh room - re-host to appear in the browser.' : 'Room is private.', '');
};
app.setTrack = data => {
  if (!app.server) return;
  app.server.setTrack(data);
  profile.d.host.trackId = data.id; profile.save();
};
app.saveRoomTrack = async () => {
  const d = app.game?.trackData;
  if (!d) return;
  try { await store.put(d); ui.toast(`Saved "${d.name}" to your tracks`, 'good'); } catch { ui.toast('Could not save (storage unavailable).', 'err'); }
};
app.toggleReady = () => {
  const me = app.room?.players.find(p => p.id === app.myId);
  app.game?.send({ t: 'ready', v: !me?.ready });
};
app.startFromLobby = () => {
  if (app.inSession()) { ui.show(null); return; }   // the lobby must never restart a running session
  const s = app.server;
  if (!s) return;
  const st = s.settings, wk = app.room?.weekend?.stage;
  if (st.mode === 'weekend') s.startSession(wk === 'practice' ? 'quali' : wk === 'quali' ? 'race' : 'practice');
  else s.startSession('race');
};

app.openGarage = () => {
  garage.returnMode = view.mode === 'garage' ? 'menu' : view.mode;
  ui.show('s-garage', true);
  garage.open();
};
app.closeGarage = () => {
  garage.close();
  app.sendProfile();
  ui.back();
};
app.openStudio = () => {
  ui.show('s-studio', true);
  studio.open().catch(err => ui.toast(err.message, 'err'));
};

async function onStudioBuilt(data) {
  if (app.server) {
    app.setTrack(data);
    ui.stack = [];
    ui.show('s-lobby');
    ui.toast(`"${data.name}" is ready - start the race when everyone is in!`, 'good');
    return;
  }
  const go = await ui.modal({ title: 'Track built!', body: `<p><b>${data.name.replace(/</g, '&lt;')}</b> is saved in your tracks. Race on it now?</p>`, buttons: [{ label: 'Later', value: null }, { label: 'Quick race vs bots', value: 'quick' }, { label: 'Host a room', value: 'host', cls: 'primary' }] });
  profile.d.host.trackId = data.id; profile.save();
  ui.stack = [];
  if (go === 'quick') app.quickRace();
  else if (go === 'host') { ui.show('s-menu'); ui.hostDialog(); }
  else ui.show('s-menu');
}

app.start = () => {
  if (ui.current !== 's-title') return;
  audio.init();
  ui.show('s-menu');
  const join = new URLSearchParams(location.search).get('join');
  if (join) { ui.show('s-join', true); $('join-code').value = join.toUpperCase(); app.join(join); }
};

input.onPause = () => { if (app.inSession()) ui.togglePause(); };
input.onPad = () => ui.toast('Controller connected - RT to drive, RB to drift, X for items.', 'good');

// ------------------------------------------------------------ loop
let last = performance.now(), fpsN = 0, fpsT = 0;
function tick(now, render) {
  const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
  last = now;
  app.server?.update();
  const a = app.attract;
  if (a) {
    a.server.update();
    a.switchT -= dt;
    if (a.switchT <= 0 && a.game.cars.size) {
      a.switchT = 9 + Math.random() * 5;
      const ids = [...a.game.cars.keys()];
      a.game.spectate = ids[Math.floor(Math.random() * ids.length)];
    }
  }
  const g = app.game || a?.game;
  if (g) { g.update(dt); if (render) g.render(dt); }
  else if (render) { view.render(dt); audio.frame(null, dt); }
  if (render && profile.settings.showFps) {
    fpsN++; fpsT += dt;
    if (fpsT > 0.5) { $('fps').textContent = `${Math.round(fpsN / fpsT)} fps`; fpsN = 0; fpsT = 0; }
  }
}
// Schedule first, then run: one bad frame must never stop the loop.
let lastErr = 0, lastRaf = 0;
function frame(now) {
  lastRaf = performance.now();
  requestAnimationFrame(frame);
  try { tick(now, true); }
  catch (err) { if (performance.now() - lastErr > 2000) { lastErr = performance.now(); console.error('frame error', err); } }
}
requestAnimationFrame(frame);
// Background / covered tabs stop rAF (sometimes while still claiming to be
// visible). A worker keeps the room simulating and talking to the network
// whenever frames stall, so hosts and guests never time out.
const ticker = new Worker(URL.createObjectURL(new Blob(['setInterval(() => postMessage(0), 33)'], { type: 'text/javascript' })));
ticker.onmessage = () => {
  if ((app.server || app.game) && performance.now() - lastRaf > 150) {
    try { tick(performance.now(), false); } catch (err) { console.error(err); }
  }
};

addEventListener('beforeunload', e => {
  if (app.isHost && app.room?.players.some(p => !p.bot && p.id !== 'p0')) { e.preventDefault(); e.returnValue = ''; }
});

// dev live reload (only on the local dev server)
if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
  try {
    const es = new EventSource('/__livereload');
    es.addEventListener('reload', () => { if (app.game || app.server) ui.toast('Code updated - reload the page when you are done racing.', ''); else location.reload(); });
    es.addEventListener('css', () => { for (const l of document.querySelectorAll('link[rel=stylesheet]')) if (l.href.includes('style.css')) l.href = l.href.replace(/(\?.*)?$/, `?v=${Date.now()}`); });
  } catch { /* no dev server */ }
}

// New deploys: version.json is written by every build. Poll it (and on tab
// focus) and offer a reload in the menu, never mid-race.
if (BUILD.commit !== 'dev') {
  let lastCheck = -Infinity;
  const check = async () => {
    if (app.update || performance.now() - lastCheck < 60e3) return;
    lastCheck = performance.now();
    try {
      const v = await (await fetch('version.json', { cache: 'no-store' })).json();
      if (!v?.date || v.date === BUILD.date) return;
      app.update = v;
      if (!app.inSession()) ui.toast(`HOME TURF v${v.version} is out - reload from the main menu to update.`, 'good');
      if (ui.current === 's-menu') ui.renderMenu();
    } catch { /* offline */ }
  };
  setInterval(check, 5 * 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setTimeout(check, 20e3);
}
// First start after an update: point at what changed.
if (profile.d.seenVersion && profile.d.seenVersion !== VERSION) setTimeout(() => ui.toast(`Updated to v${VERSION} - see the Changelog in the main menu.`, 'good'), 1500);

// Accounts: pull the latest copy at start-up; refresh what shows the profile when it changes.
account.onChange = () => { if (ui.current === 's-menu') ui.renderMenu(); if (ui.current === 's-account') ui.renderAccount(); };
account.onProfile = () => { app.sendProfile(); $('fps').classList.toggle('hidden', !profile.settings.showFps); if (ui.current === 's-menu') ui.renderMenu(); };
if (account.signedIn) account.sync().catch(err => console.warn('[account]', err.message));

ui.show('s-title');
startAttract();
app.studio = studio; app.garage = garage;
window.HOMETURF = app;   // handy for debugging in the console
