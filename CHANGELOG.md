# Changelog

Generated from `js/version.js` by `npm run build`.

## 1.3.0 - Engines and gearboxes (2026-10-14)

- Every car now has a real engine and gearbox: torque curves, 5 to 7 gears, shift cuts and a rev limiter. Acceleration builds smoothly through the gears instead of snapping to top speed.
- Rev counter on the HUD with gear, revs and a redline zone.
- Automatic gearbox (default) drops a gear for corners and holds it through the bend.
- Manual gearbox in Settings: X / Z (or flick the right stick). Shift inside the green band for a PERFECT SHIFT: a near-seamless change and a small power boost.
- Engine sound follows the real revs. Flat out on a straight the engine cruises at about 3/4 of the redline, and the V12 no longer screams like a mosquito: lower pitch, more body and softer highs for every engine.
- Launch control on the grid, revs that hold in the air, and rev-matched downshifts with a crackle on sporty exhausts.
- Engine cards in the garage show the gearbox and redline. The Test Bench uses the new physics.
- Rebalanced: stock cars are within 1% of each other and every part swap is within 0.4%.

## 1.2.0 - Relay connections (2026-10-14)

- Friends who timed out joining can now get in: when a direct link to the host can't be made (mobile data, strict routers, CGNAT), the game switches to a relay server automatically.
- Settings > Connection > "Always relay" for networks that never allow direct links.
- The server browser finds rooms faster.
- Version number and this changelog in the main menu.
- The game tells you when a new version is out, with a one-click reload.
- Version mismatch errors now name both versions.

## 1.1.1 - Night road fix (2026-10-14)

- Fixed a grey patch hiding the road and its lines in the distance (worst at night).

## 1.1.0 - See further (2026-10-14)

- The default camera sits higher and looks further ahead.
- Boost pads and item boxes have light pillars and icons that show through fog, and appear on the minimap.
- Night races are brighter.
- Fixed: opening Settings from the pause menu sent the host back to the lobby.

## 1.0.1 - Multiplayer fixes (2026-10-14)

- Big tracks now reach your friends intact (large messages were silently dropped).
- Guests ask for a missing track again instead of sitting on a blank screen.
- The game keeps running when the browser throttles a background tab.
- Mismatched game versions get a clear "refresh" message.

## 1.0.0 - Live on the web (2026-10-14)

- HOME TURF is online at hometurf-86d26fb3.netlify.app - share a room code and race.

## 0.3.0 - Real sounds, better maps (2026-10-14)

- Real recorded engine, tyre and crash sounds replace the synthesized engine.
- Street data from OpenFreeMap, with junctions healed so routes no longer detour.
- Track Studio map tiles fall back between OSM, Esri and HOT.

## 0.2.0 - Garage (2026-10-14)

- Visual car parts that trade stats against weight.
- Interchangeable engines and part upgrades that unlock as you level up.
- Test Bench: try a build on a simulated lap before racing.
- F1-style purple / green / yellow sector times.

## 0.1.0 - First lap (2026-10-14)

- 3D kart racing in the browser, on circuits built from real streets.
- Host a room from your own browser; friends join with a 5-letter code.
- Track Studio: turn your neighbourhood into a circuit.
- Race weekends with practice, qualifying and race.
- Items, abilities, drifting and mini-turbos.
- Chat, keyboard and controller support.
