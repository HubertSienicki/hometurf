# HOME TURF

A 3D kart racer for the browser where **the tracks are your own streets**. Pick a neighbourhood on the map, drop a few waypoints, and the Track Studio turns those real roads into a circuit with the real buildings, parks and water around it. Then race your friends: the host's browser is the server. Players connect to it directly (WebRTC), or through a small relay when their network blocks direct links.

## Run it

You need Node 18+. There are no npm dependencies.

```bash
npm run dev
```

Then open <http://localhost:5174>. To try multiplayer on one machine, host in one tab and join with the room code in another.

## Versions and releases

The project is a git repository; every release is a tag (`v1.1.1`, `v1.2.0`, ...).

- **`js/version.js`** holds `VERSION` and the changelog. The main menu shows the version (bottom left) and a **Changelog** button, which gets a dot after an update.
- **`npm run build`** stamps the git commit into the build and writes `dist/version.json`, `CHANGELOG.md` and the `package.json` version.
- **Update notice:** running games poll `version.json` every 5 minutes and when the tab regains focus. When a new deploy is out they offer a reload in the main menu, never mid-race.

To release:
1. Bump `VERSION` and add a changelog entry on top.
2. `npm run build`, then commit and tag: `git tag -a v1.3.0 -m v1.3.0`.
3. `npm run deploy`. It rebuilds from the clean commit and pushes to Netlify.

## Deploy (Netlify)

Live at <https://hometurf-86d26fb3.netlify.app>. This folder is already linked to that site (`.netlify/state.json`).

```bash
npm run deploy
```

That runs `npm run build` and `netlify deploy --prod`. The build copies only the game files (`index.html`, `style.css`, `favicon.svg`, `js/`, `assets/`) into `dist/`. Everything is served with `must-revalidate`, so after a deploy every player gets the same version. Players on different protocol versions can't join each other's rooms.

## Server: relay + accounts

`relay/` is a small Cloudflare Worker deployed at `hometurf-relay.hometurf-relay.workers.dev`. It does two jobs:

- **Accounts** (`relay/accounts.js`): one Durable Object with SQLite storage holds users, sessions, profiles and saved tracks.
- **Relay** (`relay/worker.js`): some networks block direct browser-to-browser links (mobile data, CGNAT and strict routers), and players on those networks time out when joining. The relay forwards their messages, with one Durable Object per room. The host's browser is still the game server.

- **Hosts** register with PeerJS and the relay at once.
- **Guests** try a direct link first. If it isn't open within 3 s or fails, the relay joins the race and the first link to open wins. Settings > Connection > **Always relay** skips the direct attempt.
- **Cost:** the free Cloudflare plan is enough for a group of friends. Only relayed players use it, and idle rooms cost nothing because sockets hibernate.

One-time setup (needs a free Cloudflare account):

```bash
cd relay && npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

`deploy` prints a URL like `https://hometurf-relay.<you>.workers.dev`. Put it in `NET.RELAY` in `js/sim/config.js`, then redeploy the game. With `RELAY` empty, the game uses direct links only.

To test locally, run `npx wrangler dev` in `relay/`, then open the game at `http://localhost:5174/?relay=ws://127.0.0.1:8787`. The `?relay=` override only works on localhost.

Your Netlify team protects new sites by default. This site is set like RICOCHAOS: **production is public**, and preview deploys still need a Netlify login.

## Features

- **Track Studio.** Search an address or use your location, then click waypoints that snap to streets. Routes follow real roads and loop back to the start.
  - **Live checks:** closed loop, no street used twice, no U-turns or hairpins, no overlapping lanes, and a sensible length.
  - **Surprise me** generates a random loop for you.
  - **Build** pulls in the real buildings (with their real heights), parks, water and side streets.
- **Race formats.** Just a race, or a full weekend: practice, qualifying with ghost cars, then a race gridded by qualifying. The host starts every session.
- **Timing.** Every track is cut into 3 sectors. Each sector shows as purple (session best), green (personal best) or yellow (slower), like F1.
- **8 cars with signature abilities**, balanced so the stock cars are within ±0.8% lap time of each other.
- **Garage.**
  - **Parts:** swap the engine, exhaust, hood, vents, wing, front aero, fenders, tyres, wheels, suspension and armour. Every part changes the model and trades stats against **mass**.
  - **Upgrades:** each part has 3 levels. Parts unlock with XP and upgrades cost credits.
  - **Paint and style:** paint, accent colour, liveries and underglow.
  - **Test Bench:** simulates your setup on any track and reports lap and sector times, race pace, 0–100 and top speed versus stock.
- **Readable at speed.** Item-box rows and boost pads have light pillars and floating icons visible from 300 m away, even through fog. They also appear on the minimap. Three camera heights are available in Settings.
- **Items.** 12 Mario Kart-style items, plus drift mini-turbos, rocket starts, ramps with tricks, slipstream and bots at 3 skill levels.
- **Rooms.** Chat, quick-chat, server browser, invite links, and day, sunset or night racing.
- **Engines and gearboxes** (`js/sim/drivetrain.js`). Each engine has a torque curve, 5 to 7 gears and a redline. Power and drag are solved per car so every car keeps the top speed and 0-90% time its stats ask for, with gear changes included.
  - **Automatic** (default): a sporty box that drops a gear for corners and holds it through the bend.
  - **Manual** (Settings): X / Z or flick the right stick. Shifting inside the green band of the rev counter is a **perfect shift**: a near-seamless change plus +8% power for 0.8 s.
  - **HUD:** a rev counter with gear, revs, the redline and the perfect-shift window.
- **Pit-stop races** (`js/sim/pit.js`). A race setting on loops of 1.5 km or more.
  - **Tyres:** they wear with distance, sliding, drifting and hard braking, and lose grip past 60% (the tyre gauge shows it). Normal races have no wear.
  - **Pit lane:** planned beside a calm straight (usually the start straight) from the track geometry, validated so it never clashes with other parts of the loop or folds on a bend. The host ships the plan with the track so every player drives the same lane.
  - **The stop:** a 120 km/h limiter, three painted boxes and garages. Stop in a box and a quick-time event changes the four wheels. Bots pit when their tyres are gone and there's racing left.
  - **With pit stops off**, the lane is barriered off.
- **Accounts** (`js/account.js`, `relay/accounts.js`). Username and password, no email. Progress, garage, the settings that follow the player, and saved tracks sync to the server. Device-only settings like volume and graphics stay local.
  - **Password handling:** the password is stretched with PBKDF2 in the browser, and the server only stores a salted hash of that key.
  - **Sign-out** brings back the device's own guest profile.
- **Controls.** Keyboard with smoothed steering, or a gamepad with analog throttle and steering. The optional steering assist keeps you off the walls.
- **Real recorded audio** (CC0, see `assets/audio/CREDITS.md`).
  - **Engines:** each car crossfades a real idle recording into a real driving loop. V8 cars use a Maserati V8. The pitch follows the car's real revs and gear, with shifts, the rev limiter, lift-off backfires and turbo blow-off. A sub-octave layer and a gentle EQ keep high revs full rather than thin.
  - **Opponents:** their engines are 3D-positioned with Doppler.
  - **Tyres:** squeal is built from short slices of real tyre recordings.
  - **Crashes:** use real collision recordings.
  - **Fallback:** a synthesized engine (`js/engineWorklet.js`) takes over if the recordings can't load.

## Map data

| What | Source | Key needed |
| --- | --- | --- |
| Map tiles | OpenStreetMap (default), Esri satellite or street map, Humanitarian OSM. Use the layer switcher at the top right. A failing server is swapped out automatically. | No |
| Streets and scenery | [OpenFreeMap](https://openfreemap.org) vector tiles (fast CDN). It falls back to the public Overpass mirrors, which are queried in parallel. | No |
| Search | Nominatim | No |

Map data &copy; OpenStreetMap contributors.

## Balance tools

```bash
npm run sim            # stock cars on every preset track
npm run sim -- sens    # lap-time value of one stat point
npm run sim -- parts   # every part swap on 4 bodies vs stock (add "all" for all 8)
```

All tuning lives in `js/sim/config.js` (physics, cars, items) and `js/sim/parts.js` (parts and mass coupling).

## Layout

```
js/sim/          pure simulation, shared by game, test bench and Node sim
  track.js       route -> smooth centerline, validation, sectors, features
  physics.js     arcade car physics     ai.js       bots
  drivetrain.js  engines, gears, perfect shifts, launch calibration
  pit.js         pit lane planning + validation, pit walls, tyre wear
  items.js       projectiles/hazards    parts.js    builds, mass coupling, upgrades
js/game.js       client game: owned cars, remote interpolation, items, timing
js/server.js     host room authority: lobby, sessions, results, points
js/net.js        host/client links: PeerJS (direct) + WebSocket relay fallback
js/account.js    accounts: sign up / in, profile + track sync
js/version.js    version + changelog (menu badge, CHANGELOG.md, version.json)
js/vtiles.js     vector-tile decoder, street graph, scenery
js/osm.js        Overpass, Nominatim, A* routing
js/render/       three.js world, procedural cars, effects, cameras
js/ui/           menus, lobby, garage, Track Studio, HUD
js/audio.js      mixer, engine voices, effects, music
js/engineWorklet.js   combustion-pulse engine synth (AudioWorklet)
relay/           Cloudflare Worker: room relay (worker.js) + accounts (accounts.js)
```
