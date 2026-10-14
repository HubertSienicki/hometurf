// Menus, lobby, results, pause, settings, controls, track picker and chat.
import { CARS, NET, BOT_LEVELS, ABILITIES } from '../sim/config.js';
import { PARTS, SLOTS, stockBuild } from '../sim/parts.js';
import { PRESETS, buildPreset } from '../sim/presets.js';
import { KEY_HELP } from '../input.js';
import { xpFor } from '../profile.js';
import { fmtTime, ordinal, escapeHtml } from '../sim/util.js';

const $ = id => document.getElementById(id);
const QUICK = ['GG!', 'Nice move!', 'Sorry!', 'Watch out behind you!'];
const KIND = { practice: 'Practice', quali: 'Qualifying', race: 'Race' };

export class UI {
  constructor(app) {
    this.app = app;
    this.stack = [];
    this.current = null;
    this.room = null;
    this.rewarded = new Set();
    this.bind();
  }
  get profile() { return this.app.profile; }

  // ------------------------------------------------------------ plumbing
  show(id, push = false) {
    if (push && this.current && this.current !== id) this.stack.push(this.current);
    for (const s of document.querySelectorAll('.screen:not(.overlay)')) s.classList.toggle('on', s.id === id);
    this.current = id;
    document.body.classList.toggle('racing', id == null);
    if (id === 's-menu') this.renderMenu();
    if (id === 's-controls') this.renderControls();
    if (id === 's-settings') this.renderSettingsForm();
    if (id === 's-lobby' && this.room) this.renderLobby(this.room, this.app.game);
  }
  back(fallback = 's-menu') {
    // Settings / controls opened from the pause menu mid-race go straight back to the race.
    if (this.returnToPause) {
      this.returnToPause = false;
      this.show(null);
      if (this.app.inSession()) this.overlay('s-pause', true);
      return;
    }
    const prev = this.stack.pop() || fallback;
    if (prev === 's-lobby' && !this.app.room) return this.show('s-menu');
    if (prev === 's-lobby' && this.app.inSession()) { this.show(null); return; }
    if (prev === null || prev === 'race') { this.show(null); return; }
    this.show(prev);
  }
  overlay(id, on) { $(id).classList.toggle('on', on); }
  toast(msg, cls = '') {
    const t = document.createElement('div');
    t.className = 'toast ' + cls; t.textContent = msg;
    $('toasts').appendChild(t);
    setTimeout(() => t.remove(), 3400);
  }
  loading(text) {
    $('loading').classList.toggle('hidden', !text);
    if (text) $('loading-text').textContent = text;
  }
  modal({ title, body = '', buttons = [{ label: 'OK', value: true, cls: 'primary' }] }) {
    return new Promise(res => {
      const m = $('modal');
      m.innerHTML = `<div class="panel"><h2>${title}</h2><div>${body}</div><div class="row gap end" style="margin-top:16px">${buttons.map((b, i) => `<button class="btn ${b.cls || ''}" data-i="${i}">${b.label}</button>`).join('')}</div></div>`;
      m.classList.remove('hidden');
      m.querySelectorAll('button[data-i]').forEach(b => b.addEventListener('click', () => { m.classList.add('hidden'); res(buttons[+b.dataset.i].value); }));
    });
  }

  bind() {
    const app = this.app;
    document.addEventListener('click', e => {
      const el = e.target.closest('[data-act]');
      if (!el || el.disabled) return;
      if (el.closest('#s-studio')) return;   // studio handles its own buttons
      app.audio.sfx('click');
      this.act(el.dataset.act, el);
    });
    document.addEventListener('mouseover', e => { if (e.target.closest?.('.mbtn')) app.audio.sfx('hover'); });
    $('s-title').addEventListener('click', () => app.start());
    addEventListener('keydown', e => this.key(e));
    $('join-form').addEventListener('submit', e => { e.preventDefault(); app.join($('join-code').value); });
    $('l-chatform').addEventListener('submit', e => { e.preventDefault(); const v = $('l-chatin').value.trim(); if (v) app.chat(v); $('l-chatin').value = ''; });
    $('chatbox').addEventListener('submit', e => { e.preventDefault(); const v = $('chat-in').value.trim(); if (v) app.chat(v); this.closeChat(); });
    $('t-file').addEventListener('change', e => this.importFile(e.target.files[0]));
  }

  key(e) {
    const app = this.app;
    if (this.current === 's-title') { if (!e.repeat) app.start(); return; }
    const typingChat = document.activeElement === $('chat-in');
    if (e.code === 'Escape') {
      if (typingChat) { this.closeChat(); return; }
      if (!$('modal').classList.contains('hidden')) return;
      if (['s-settings', 's-controls'].includes(this.current)) { this.back(); return; }
      if (this.app.inSession()) { this.togglePause(); return; }
      if (['s-garage'].includes(this.current)) { this.act('garage-done'); return; }
      if (['s-settings', 's-controls', 's-join', 's-browser', 's-tracks', 's-studio'].includes(this.current)) { this.back(); return; }
    }
    if (this.app.inSession() && !typingChat && document.activeElement?.tagName !== 'INPUT' && (e.code === 'KeyT' || e.code === 'Enter') && !$('s-pause').classList.contains('on')) {
      e.preventDefault();
      this.openChat();
    }
  }
  openChat() { $('chatbox').classList.remove('hidden'); $('chat-in').value = ''; $('chat-in').focus(); }
  closeChat() { $('chat-in').blur(); $('chatbox').classList.add('hidden'); }
  quickChat(i) { if (!document.activeElement || document.activeElement.tagName !== 'INPUT') this.app.chat(QUICK[i - 1]); }

  act(a, el) {
    const app = this.app;
    switch (a) {
      case 'quick': app.quickRace(); break;
      case 'host': this.hostDialog(); break;
      case 'join': this.show('s-join', true); setTimeout(() => $('join-code').focus(), 30); break;
      case 'browser': this.show('s-browser', true); this.refreshBrowser(); break;
      case 'refresh': this.refreshBrowser(); break;
      case 'studio': app.openStudio(); break;
      case 'garage': app.openGarage(); break;
      case 'garage-done': app.closeGarage(); break;
      case 'settings': case 'controls':
        this.returnToPause = $('s-pause').classList.contains('on');
        this.overlay('s-pause', false);
        this.show(a === 'settings' ? 's-settings' : 's-controls', !this.returnToPause);
        break;
      case 'settings-back': case 'controls-back': case 'tracks-back': case 'studio-back': this.back(); break;
      case 'menu': this.show('s-menu'); this.stack = []; break;
      case 'leave': this.confirmLeave(); break;
      case 'copy': this.copyInvite(); break;
      case 'addbot': app.hostSet({ bots: Math.min(NET.MAX_CARS - 1, (this.room?.settings.bots || 0) + 1) }); break;
      case 'rmbot': app.hostSet({ bots: Math.max(0, (this.room?.settings.bots || 0) - 1) }); break;
      case 'tracks': this.openTracks(); break;
      case 'savetrack': app.saveRoomTrack(); break;
      case 'ready': app.toggleReady(); break;
      case 'start': app.startFromLobby(); break;
      case 'resume': this.togglePause(false); break;
      case 'end-session': this.togglePause(false); app.server?.endSession(); break;
      case 'to-lobby': this.togglePause(false); app.server?.backToLobby(); break;
      case 'import': $('t-file').click(); break;
    }
  }

  async confirmLeave() {
    const host = this.app.isHost && this.room && [...this.room.players].some(p => !p.bot && p.id !== 'p0');
    const ok = await this.modal({ title: 'Leave the room?', body: host ? '<p>You are the host - leaving closes the room for everyone.</p>' : '<p>You can rejoin with the room code.</p>', buttons: [{ label: 'Stay', value: false }, { label: 'Leave', value: true, cls: 'danger' }] });
    if (ok) { this.overlay('s-pause', false); this.app.leave(); }
  }

  async hostDialog() {
    const v = await this.modal({
      title: 'Host a room',
      body: '<p>Your browser becomes the server. Share the room code or invite link with friends - they join straight from their browser.</p><label class="chk"><input type="checkbox" id="m-pub"> List it in the public server browser</label>',
      buttons: [{ label: 'Cancel', value: null }, { label: 'Create room', value: 'go', cls: 'primary' }],
    }).then(r => (r ? { pub: document.getElementById('m-pub')?.checked } : null));
    if (v) this.app.host({ pub: !!v.pub });
  }

  // ------------------------------------------------------------ menu
  renderMenu() {
    const p = this.profile, L = p.level, x0 = xpFor(L), x1 = xpFor(L + 1);
    $('m-profile').innerHTML = `<div class="lv">${L}</div><div><b>${escapeHtml(p.name)}</b><span class="muted small">${CARS[p.car].name} &middot; ${p.credits.toLocaleString()} cr</span><div class="xpbar"><i style="width:${Math.min(100, (p.xp - x0) / (x1 - x0) * 100)}%"></i></div></div>`;
    $('m-profile').onclick = () => this.app.openGarage();
  }

  async refreshBrowser() {
    const list = $('b-list');
    list.innerHTML = '<div class="muted">Looking for public rooms...</div>';
    let rooms = [];
    try { rooms = await this.app.listRooms(); } catch (err) { list.innerHTML = `<div class="err">${escapeHtml(err.message)}</div>`; return; }
    if (!rooms.length) { list.innerHTML = '<div class="muted">No public rooms right now. Host one and tick "public"!</div>'; return; }
    list.innerHTML = rooms.map(r => `<div class="b-room"><div class="grow"><b>${escapeHtml(r.name)}</b><span class="muted small">${escapeHtml(r.track)} &middot; ${r.players} player${r.players === 1 ? '' : 's'} + ${r.bots} bots &middot; ${r.phase === 'lobby' ? 'in lobby' : 'racing (join as spectator)'}</span></div><button class="btn primary small" data-code="${r.code}">Join</button></div>`).join('');
    list.querySelectorAll('[data-code]').forEach(b => b.addEventListener('click', () => this.app.join(b.dataset.code)));
  }

  // ------------------------------------------------------------ lobby
  enterLobby() {
    this.stack = [];
    document.body.classList.toggle('is-host', !!this.app.isHost);
    $('l-chatlog').innerHTML = '';
    this.show('s-lobby');
  }

  onRoom(room, game) {
    this.room = room;
    const ph = room.phase;
    if (ph === 'lobby') {
      this.overlay('s-results', false);
      if (this.current == null) this.show('s-lobby');
    } else if (ph === 'session') {
      this.overlay('s-results', false);
      if (this.current === 's-lobby') this.show(null);
    } else if (ph === 'results') {
      this.showResults(room, game);
    }
    if (this.current === 's-lobby' || ph === 'lobby') this.renderLobby(room, game);
  }

  onSessionStart() {
    this.overlay('s-results', false);
    if (['s-lobby', 's-tracks'].includes(this.current) || this.current == null) { this.stack = ['s-lobby']; this.show(null); }
  }

  renderLobby(room, game) {
    const me = this.app.myId, isHost = this.app.isHost;
    document.body.classList.toggle('is-host', !!isHost);
    const code = room.code ? room.code.toUpperCase() : 'OFFLINE';
    $('l-code').innerHTML = `<span>ROOM</span><b>${code}</b>${room.settings.public ? '<span class="tag">PUBLIC</span>' : ''}${room.code ? '<button class="btn small" data-act="copy">Copy invite</button>' : '<span class="tag">SOLO</span>'}`;
    const phaseTxt = room.phase === 'lobby' ? (room.weekend?.stage ? `Weekend: ${KIND[room.weekend.stage]} done` : 'Lobby') : room.phase === 'session' ? `${KIND[room.session?.kind] || ''} in progress` : 'Results';
    $('l-phase').textContent = phaseTxt;
    // players
    const ps = room.players;
    $('l-count').textContent = `${ps.length}/${NET.MAX_CARS}`;
    $('l-plist').innerHTML = ps.map(p => `<li class="${p.id === me ? 'me' : ''}"><span class="sw" style="background:${p.color}"></span><div class="nm">${escapeHtml(p.name)}<div class="car">${CARS[p.car]?.name || ''}${p.bot ? ' &middot; ' + BOT_LEVELS[p.level ?? 1].name : ''}</div></div>
      ${p.id === room.hostId ? '<span class="badge host">host</span>' : ''}${p.bot ? '<span class="badge bot">bot</span>' : p.ready && p.id !== room.hostId ? '<span class="badge ready">ready</span>' : ''}${!p.bot ? `<span class="badge lv">${p.xpLevel || 1}</span>` : ''}${p.spectator ? '<span class="badge">watching</span>' : ''}
      ${isHost && p.id !== room.hostId ? `<button class="kick" data-kick="${p.id}" title="Remove">&times;</button>` : ''}</li>`).join('');
    $('l-plist').querySelectorAll('[data-kick]').forEach(b => b.addEventListener('click', () => this.app.server?.kick(b.dataset.kick)));
    // track
    const t = room.track;
    $('l-trackname').textContent = t ? t.name : 'No track yet';
    $('l-trackmeta').innerHTML = t ? `${(t.len / 1000).toFixed(2)} km &middot; ${t.width} m wide${t.origin ? ` &middot; real streets @ ${t.origin.lat.toFixed(3)}, ${t.origin.lon.toFixed(3)}` : ''}${t.author ? `<br>by ${escapeHtml(t.author)}` : ''}` : '';
    if (t && t.hash !== this.drawnTrack) { this.drawnTrack = t.hash; drawTrack($('l-map'), t.pts); }
    $('l-savetrack').classList.toggle('hidden', !t || !!t.preset);
    // settings
    this.renderRoomSettings(room);
    // standings
    const st = Object.entries(room.standings || {}).sort((a, b) => b[1] - a[1]);
    $('l-standings').classList.toggle('hidden', !st.length);
    if (st.length) $('l-standings').innerHTML = `<h3>Championship</h3><table>${st.map(([id, pts], i) => { const p = ps.find(q => q.id === id); return `<tr><td>${i + 1}</td><td>${p ? escapeHtml(p.name) : '<span class="dim">(left)</span>'}</td><td class="pts" style="text-align:right">${pts}</td></tr>`; }).join('')}</table>`;
    // my car + buttons
    const mine = ps.find(p => p.id === me);
    if (mine) {
      const fitted = SLOTS.filter(s => mine.build && mine.build[s] !== stockBuild(mine.car)[s]).length;
      $('l-mycar').innerHTML = `<span class="sw" style="width:16px;height:16px;border-radius:4px;background:${mine.color}"></span><div><b>${CARS[mine.car].name}</b><div class="muted small">${ABILITIES[CARS[mine.car].ability].name} &middot; ${fitted ? `${fitted} upgraded part${fitted > 1 ? 's' : ''}` : 'stock'}</div></div>`;
      $('l-ready').textContent = mine.ready ? 'Ready!' : 'Ready?';
      $('l-ready').classList.toggle('primary', !!mine.ready);
    }
    const s = room.settings;
    const label = room.phase === 'session' ? 'Back to the race' : room.phase !== 'lobby' ? 'Session running' : s.mode === 'weekend' ? (room.weekend?.stage === 'practice' ? 'Start Qualifying' : room.weekend?.stage === 'quali' ? 'Start Race' : 'Start Practice') : 'Start Race';
    $('l-start').textContent = label;
    $('l-start').disabled = !(room.phase === 'session' || (room.phase === 'lobby' && t));
  }

  renderRoomSettings(room) {
    const s = room.settings, host = this.app.isHost, dis = host ? '' : 'disabled';
    const seg = (key, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-set="${key}" data-v="${v}" class="${String(s[key]) === String(v) ? 'on' : ''}" ${dis}>${l}</button>`).join('')}</div>`;
    const step = (key, min, max, fmt = v => v) => `<div class="stepper"><button data-step="${key}" data-d="-1" ${dis || (s[key] <= min ? 'disabled' : '')}>-</button><b>${fmt(s[key])}</b><button data-step="${key}" data-d="1" ${dis || (s[key] >= max ? 'disabled' : '')}>+</button></div>`;
    const onoff = key => seg(key, [[true, 'On'], [false, 'Off']]);
    const rows = [
      ['Format', seg('mode', [['race', 'Just race'], ['weekend', 'Race weekend']])],
      ['Laps', step('laps', 1, 20)],
      ...(s.mode === 'weekend' ? [['Practice', step('practiceMin', 1, 15, v => `${v}m`)], ['Qualifying', step('qualiMin', 1, 15, v => `${v}m`)]] : []),
      ['Items', onoff('items')], ['Car abilities', onoff('abilities')],
      ['Bots', step('bots', 0, NET.MAX_CARS - 1)], ['Bot skill', seg('botLevel', BOT_LEVELS.map((b, i) => [i, b.name]))],
      ['Time of day', seg('tod', [['day', 'Day'], ['sunset', 'Sunset'], ['night', 'Night']])],
      ['Car contact', onoff('collisions')], ['Catch-up help', onoff('catchup')],
      ['Part upgrades', seg('upgrades', [[true, 'Count'], [false, 'Equalized']])],
      ...(this.app.net ? [['Public room', onoff('public')]] : []),
    ];
    $('l-settings').innerHTML = `<h3>Race settings${host ? '' : ' <span class="muted small">(host decides)</span>'}</h3>` + rows.map(([l, c]) => `<div class="setting"><span>${l}</span>${c}</div>`).join('');
    if (!host) return;
    $('l-settings').querySelectorAll('[data-set]').forEach(b => b.addEventListener('click', () => {
      let v = b.dataset.v;
      if (v === 'true') v = true; else if (v === 'false') v = false; else if (/^\d+$/.test(v)) v = +v;
      this.app.audio.sfx('click');
      this.app.hostSet({ [b.dataset.set]: v });
    }));
    $('l-settings').querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => {
      this.app.audio.sfx('click');
      this.app.hostSet({ [b.dataset.step]: s[b.dataset.step] + +b.dataset.d });
    }));
  }

  onChat(m) {
    const log = $('l-chatlog');
    const div = document.createElement('div');
    div.className = m.sys ? 'cm sys' : 'cm';
    div.innerHTML = m.sys ? escapeHtml(m.text) : `<b style="color:${m.color}">${escapeHtml(m.name)}:</b> ${escapeHtml(m.text)}`;
    log.appendChild(div);
    while (log.children.length > 120) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
    if (!m.sys && m.id !== this.app.myId) this.app.audio.sfx('chat');
  }

  copyInvite() {
    const code = this.room?.code;
    if (!code) return;
    const url = `${location.origin}${location.pathname}?join=${code}`;
    navigator.clipboard?.writeText(url).then(() => this.toast('Invite link copied!', 'good'), () => this.toast(url));
  }

  // ------------------------------------------------------------ results
  showResults(room, game) {
    const r = room.results;
    if (!r) return;
    const me = this.app.myId, isHost = this.app.isHost;
    const race = r.kind === 'race';
    $('r-kicker').textContent = room.track?.name || '';
    $('r-title').textContent = `${KIND[r.kind]} results`;
    const best = r.bestSecs || [];
    const rows = r.rows.map(row => {
      const time = race ? (row.fin ? (row.pos === 1 ? fmtTime(row.total) : `+${((row.gap) / 1000).toFixed(3)}`) : `DNF${row.laps ? ` (${row.laps} laps)` : ''}`) : (row.best != null ? (row.pos === 1 ? fmtTime(row.best) : `+${(row.gap / 1000).toFixed(3)}`) : 'no time');
      const fl = r.fastest?.id === row.id;
      const secs = !race && row.bestSecs ? row.bestSecs.map((t, k) => `<span class="${t != null && t === best[k] ? 'purple' : ''}">${t != null ? (t / 1000).toFixed(3) : '-'}</span>`).join(' / ') : '';
      return `<tr class="${row.id === me ? 'me' : ''}"><td class="pos">${row.pos}</td><td><span class="sw" style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${row.color};margin-right:8px"></span>${escapeHtml(row.name)}${row.bot ? ' <span class="badge bot">bot</span>' : ''}</td><td class="muted">${CARS[row.car]?.name || ''}</td><td class="t">${time}</td><td class="t ${fl ? 'purple' : ''}">${row.best != null ? fmtTime(row.best) : '-'}</td>${race ? `<td class="pts">${row.pts ? '+' + row.pts : ''}</td>` : `<td class="t small">${secs}</td>`}</tr>`;
    }).join('');
    $('r-table').innerHTML = `<table class="res"><tr><th>Pos</th><th>Driver</th><th>Car</th><th>${race ? 'Time' : 'Gap'}</th><th>Best lap</th><th>${race ? 'Pts' : 'Best sectors'}</th></tr>${rows}</table>`;
    const aw = [];
    if (r.fastest) { const p = r.rows.find(x => x.id === r.fastest.id); aw.push(`<div class="aw"><b>Fastest lap</b>${escapeHtml(p?.name || '?')} &middot; ${fmtTime(r.fastest.ms)}</div>`); }
    if (r.topHitter) { const p = r.rows.find(x => x.id === r.topHitter.id); aw.push(`<div class="aw"><b>Most hits</b>${escapeHtml(p?.name || '?')} &middot; ${r.topHitter.n}</div>`); }
    $('r-awards').innerHTML = aw.join('');
    // rewards (once per session)
    const key = `${room.session?.id}`;
    if (!this.rewarded.has(key) && game && !game.attract) {
      this.rewarded.add(key);
      const meCar = game.cars.get(me);
      const laps = meCar ? meCar.lapN || 0 : 0;
      const rw = this.profile.reward(r, me, laps, meCar?.hitsLanded || 0);
      this.lastReward = rw;
      if (rw?.levelUp) setTimeout(() => this.app.audio.sfx('unlock'), 600);
      this.app.sendProfile();
    }
    const rw = this.lastReward;
    $('r-reward').innerHTML = rw ? `<span class="rw xp">+${rw.xp} XP</span><span class="rw">+${rw.cr} cr</span>${rw.levelUp ? `<span class="rw lvup">LEVEL ${rw.levelUp}!</span>` : ''}${rw.unlocks.length ? `<div class="unl">Unlocked: ${rw.unlocks.map(escapeHtml).join(', ')} - check the Garage.</div>` : ''}` : '';
    const s = room.settings, acts = [];
    if (isHost) {
      if (s.mode === 'weekend' && r.kind === 'practice') acts.push(['Start Qualifying', () => this.app.server.startSession('quali'), 'primary'], ['Skip to Race', () => this.app.server.startSession('race'), '']);
      else if (s.mode === 'weekend' && r.kind === 'quali') acts.push(['Start Race', () => this.app.server.startSession('race'), 'primary']);
      else acts.push(['Race again', () => this.app.server.startSession('race'), 'primary']);
      acts.push(['Back to lobby', () => this.app.server.backToLobby(), '']);
    }
    $('r-actions').innerHTML = isHost ? '' : '<span class="muted">Waiting for the host...</span>';
    for (const [label, fn, cls] of acts) {
      const b = document.createElement('button');
      b.className = `btn big ${cls}`; b.textContent = label; b.onclick = () => { this.app.audio.sfx('click'); fn(); };
      $('r-actions').appendChild(b);
    }
    this.overlay('s-pause', false);
    this.overlay('s-results', true);
  }

  togglePause(force) {
    const on = force ?? !$('s-pause').classList.contains('on');
    this.overlay('s-pause', on);
  }

  // ------------------------------------------------------------ track picker
  async openTracks() {
    this.show('s-tracks', true);
    const presets = $('t-presets');
    presets.innerHTML = PRESETS.map(p => `<div class="t-card" data-preset="${p.key}"><canvas width="230" height="130"></canvas><b>${p.name}</b><span class="muted small">${escapeHtml(p.blurb)}</span></div>`).join('');
    presets.querySelectorAll('.t-card').forEach(c => {
      const d = buildPreset(c.dataset.preset);
      drawTrack(c.querySelector('canvas'), d.pts);
      c.addEventListener('click', () => { this.app.setTrack(d); this.back(); });
    });
    const mine = $('t-mine');
    let list = [];
    try { list = await this.app.store.list(); } catch { list = []; }
    if (!list.length) mine.innerHTML = '<div class="t-empty">No tracks yet. Hit <b>+ Build from the map</b> to turn real streets into a circuit.</div>';
    else {
      mine.innerHTML = list.map(t => `<div class="t-card" data-id="${t.id}"><canvas width="230" height="130"></canvas><b>${escapeHtml(t.name)}</b><div class="row"><span class="muted small">${(t.len / 1000).toFixed(2)} km</span><span class="row gap"><button class="btn small ghost" data-exp="${t.id}">Export</button><button class="btn small danger" data-del="${t.id}">Delete</button></span></div></div>`).join('');
      mine.querySelectorAll('.t-card').forEach((c, i) => {
        drawTrack(c.querySelector('canvas'), list[i].pts);
        c.addEventListener('click', async e => {
          if (e.target.closest('[data-del]')) {
            e.stopPropagation();
            if (await this.modal({ title: 'Delete track?', body: `<p>${escapeHtml(list[i].name)} will be removed from this browser.</p>`, buttons: [{ label: 'Keep', value: false }, { label: 'Delete', value: true, cls: 'danger' }] })) { await this.app.store.del(list[i].id); this.openTracks(); this.stack.pop(); }
            return;
          }
          if (e.target.closest('[data-exp]')) { e.stopPropagation(); this.exportTrack(list[i].id); return; }
          const d = await this.app.store.get(list[i].id);
          if (d) { this.app.setTrack(d); this.back(); }
        });
      });
    }
  }
  async exportTrack(id) {
    const d = await this.app.store.get(id);
    if (!d) return;
    const blob = new Blob([JSON.stringify(d)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${d.name.replace(/[^\w\- ]+/g, '').trim() || 'track'}.hometurf.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async importFile(file) {
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      if (!Array.isArray(d.pts) || !d.width || !d.name) throw new Error('Not a HOME TURF track file.');
      d.id = d.id || Math.random().toString(36).slice(2);
      await this.app.store.put(d);
      this.toast(`Imported ${d.name}`, 'good');
      this.stack.pop();
      this.openTracks();
    } catch (err) { this.toast(err.message, 'err'); }
    $('t-file').value = '';
  }

  // ------------------------------------------------------------ settings / controls
  renderSettingsForm() {
    const s = this.profile.settings, f = $('set-form');
    const seg = (key, opts) => `<div class="seg">${opts.map(([v, l]) => `<button data-pref="${key}" data-v="${v}" class="${String(s[key]) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const range = key => `<input type="range" min="0" max="1" step="0.05" value="${s[key]}" data-range="${key}">`;
    f.innerHTML = `
      <label>Driver name</label><input id="set-name" maxlength="18" value="${escapeHtml(this.profile.name)}">
      <label>Master volume</label>${range('volume')}
      <label>Sound effects</label>${range('sfx')}
      <label>Music</label>${range('music')}
      <label>Graphics</label>${seg('quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']])}
      <label>Steering assist <span class="small dim">(nudges you away from walls)</span></label>${seg('assist', [[true, 'On'], [false, 'Off']])}
      <label>Camera</label>${seg('cam', [['low', 'Low'], ['normal', 'Normal'], ['far', 'High & far']])}
      <label>Speed units</label>${seg('units', [['kmh', 'km/h'], ['mph', 'mph']])}
      <label>Show FPS</label>${seg('showFps', [[true, 'On'], [false, 'Off']])}
      <label>Sandbox: unlock every part <span class="small dim">(for testing builds)</span></label>${seg('sandbox', [[true, 'On'], [false, 'Off']])}
      <p class="full muted small">Graphics changes apply after a page reload.</p>`;
    $('set-name').addEventListener('change', e => { this.profile.name = e.target.value; this.app.sendProfile(); });
    f.querySelectorAll('[data-range]').forEach(r => r.addEventListener('input', () => { s[r.dataset.range] = +r.value; this.profile.save(); this.app.audio.applyVolumes(); }));
    f.querySelectorAll('[data-pref]').forEach(b => b.addEventListener('click', () => {
      let v = b.dataset.v; if (v === 'true') v = true; else if (v === 'false') v = false;
      s[b.dataset.pref] = v; this.profile.save();
      if (b.dataset.pref === 'showFps') $('fps').classList.toggle('hidden', !v);
      if (b.dataset.pref === 'sandbox') this.app.sendProfile();
      this.renderSettingsForm();
    }));
  }
  renderControls() {
    $('keys').innerHTML = `<tr><th>Action</th><th>Keyboard</th><th>Gamepad</th></tr>` + KEY_HELP.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td></tr>`).join('');
    $('tips').innerHTML = [
      '<div><b>Drift for boosts.</b> Hold drift while turning: sparks go blue, orange, then purple. Let go for a mini-turbo.</div>',
      '<div><b>Rocket start.</b> Press accelerate just as the last red light comes on. Too early and you bog down.</div>',
      '<div><b>Ramps:</b> tap drift in the air for a trick - land it for a boost.</div>',
      '<div><b>Slipstream:</b> sit right behind another car for a free boost.</div>',
      '<div><b>Abilities</b> charge faster the further back you are, and every mini-turbo tops them up.</div>',
      '<div><b>Qualifying sectors:</b> <span style="color:#d79bff">purple</span> = fastest of anyone, <span style="color:#6ff0a0">green</span> = your personal best, <span style="color:#ffd23f">yellow</span> = slower.</div>',
    ].join('');
  }
}

// Draw a flat [x,z,...] centerline into a canvas (north up).
export function drawTrack(cv, flat) {
  const g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  if (!flat || flat.length < 6) return;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < flat.length; i += 2) { minX = Math.min(minX, flat[i]); maxX = Math.max(maxX, flat[i]); minZ = Math.min(minZ, flat[i + 1]); maxZ = Math.max(maxZ, flat[i + 1]); }
  const pad = 16, sc = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxZ - minZ || 1));
  const ox = (W - (maxX - minX) * sc) / 2, oz = (H - (maxZ - minZ) * sc) / 2;
  const X = x => ox + (x - minX) * sc, Z = z => oz + (z - minZ) * sc;
  g.lineJoin = g.lineCap = 'round';
  const path = () => { g.beginPath(); for (let i = 0; i < flat.length; i += 2) i ? g.lineTo(X(flat[i]), Z(flat[i + 1])) : g.moveTo(X(flat[i]), Z(flat[i + 1])); g.closePath(); };
  path(); g.strokeStyle = '#0a0c14'; g.lineWidth = 9; g.stroke();
  path(); g.strokeStyle = '#ff6b2c'; g.lineWidth = 4.5; g.stroke();
  g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(X(flat[0]), Z(flat[1]), 5, 0, 7); g.fill();
  g.strokeStyle = '#0a0c14'; g.lineWidth = 2; g.stroke();
}
