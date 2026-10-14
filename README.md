# HOME TURF

A 3D kart racer for the browser where **the tracks are your own streets**. Pick a neighbourhood on the map, drop a few waypoints, and the Track Studio turns those real roads into a circuit with the real buildings, parks and water around it. Then race your friends **peer-to-peer**: the host's browser is the server, so there's no backend.

## Run it

You need Node 18+. There are no npm dependencies.

```bash
npm run dev
```

Then open <http://localhost:5174>. To try multiplayer on one machine, host in one tab and join with the room code in another.

## Deploy (Netlify)

Live at <https://hometurf-86d26fb3.netlify.app>. This folder is already linked to that site (`.netlify/state.json`). To ship an update:

```bash
npm run build
```

```bash
npx netlify-cli deploy --prod --dir dist --no-build
```

`npm run build` copies only the game files (`index.html`, `style.css`, `favicon.svg`, `js/`) into `dist/`. Everything is served with `must-revalidate`, so after a deploy every player gets the same version. Players on different versions can't join each other's rooms.

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
- **Controls.** Keyboard with smoothed steering, or a gamepad with analog throttle and steering. The optional steering assist keeps you off the walls.
- **Real recorded audio** (CC0, see `assets/audio/CREDITS.md`).
  - **Engines:** each car crossfades a real idle recording into a real driving loop. V8 cars use a Maserati V8. The pitch follows a simulated gearbox with shifts, a rev limiter, lift-off backfires and turbo blow-off.
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
  items.js       projectiles/hazards    parts.js    builds, mass coupling, upgrades
js/game.js       client game: owned cars, remote interpolation, items, timing
js/server.js     host room authority: lobby, sessions, results, points
js/net.js        PeerJS host/client (from RICOCHAOS)
js/vtiles.js     vector-tile decoder, street graph, scenery
js/osm.js        Overpass, Nominatim, A* routing
js/render/       three.js world, procedural cars, effects, cameras
js/ui/           menus, lobby, garage, Track Studio, HUD
js/audio.js      mixer, engine voices, effects, music
js/engineWorklet.js   combustion-pulse engine synth (AudioWorklet)
```
