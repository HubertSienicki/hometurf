// The game's version and changelog: the one source for the menu badge, the
// Changelog screen, CHANGELOG.md and dist/version.json (both written by
// `npm run build`). To release: bump VERSION, add an entry on top, build,
// commit, then `git tag vX.Y.Z` (see README).
export const VERSION = '1.4.0';

// Filled in by scripts/build.mjs from git; 'dev' when served from source.
export const BUILD = { commit: 'dev', date: '' };

export const CHANGELOG = [
  {
    v: '1.4.0', date: '2026-10-14', title: 'Accounts and pit stops',
    items: [
      'Accounts: create one with a username and password (no email) and your level, credits, garage, settings and saved tracks are stored online. Sign in on any device to pick up where you left off.',
      'Pit-stop races (race setting, on loops of 1.5 km or more): tyres wear and lose grip, and there is a real pit lane beside the main straight with a 120 km/h limiter, painted boxes and garages.',
      'Stop in a box and the crew changes all four tyres: hit SPACE (or RB) in the green for each wheel. Good timing means a quick stop. Bots pit too when their tyres are gone.',
      'Tyre gauge on the HUD in pit-stop races. Normal races have no tyre wear and the pit lane stays closed.',
      'Fixed: the lobby view flickered (roads, side streets and the ground fighting each other).',
      'Buildings are taller, houses have pitched roofs and tall blocks a parapet, so the city no longer looks cut off.',
    ],
  },
  {
    v: '1.3.1', date: '2026-10-14', title: 'Relay switched on',
    items: ['The relay server is live, so friends whose network blocks direct connections can join rooms.'],
  },
  {
    v: '1.3.0', date: '2026-10-14', title: 'Engines and gearboxes',
    items: [
      'Every car now has a real engine and gearbox: torque curves, 5 to 7 gears, shift cuts and a rev limiter. Acceleration builds smoothly through the gears instead of snapping to top speed.',
      'Rev counter on the HUD with gear, revs and a redline zone.',
      'Automatic gearbox (default) drops a gear for corners and holds it through the bend.',
      'Manual gearbox in Settings: X / Z (or flick the right stick). Shift inside the green band for a PERFECT SHIFT: a near-seamless change and a small power boost.',
      'Engine sound follows the real revs. Flat out on a straight the engine cruises at about 3/4 of the redline, and the V12 no longer screams like a mosquito: lower pitch, more body and softer highs for every engine.',
      'Launch control on the grid, revs that hold in the air, and rev-matched downshifts with a crackle on sporty exhausts.',
      'Engine cards in the garage show the gearbox and redline. The Test Bench uses the new physics.',
      'Rebalanced: stock cars are within 1% of each other and every part swap is within 0.4%.',
    ],
  },
  {
    v: '1.2.0', date: '2026-10-14', title: 'Relay connections',
    items: [
      'Friends who timed out joining can now get in: when a direct link to the host can\'t be made (mobile data, strict routers, CGNAT), the game switches to a relay server automatically.',
      'Settings > Connection > "Always relay" for networks that never allow direct links.',
      'The server browser finds rooms faster.',
      'Version number and this changelog in the main menu.',
      'The game tells you when a new version is out, with a one-click reload.',
      'Version mismatch errors now name both versions.',
    ],
  },
  {
    v: '1.1.1', date: '2026-10-14', title: 'Night road fix',
    items: ['Fixed a grey patch hiding the road and its lines in the distance (worst at night).'],
  },
  {
    v: '1.1.0', date: '2026-10-14', title: 'See further',
    items: [
      'The default camera sits higher and looks further ahead.',
      'Boost pads and item boxes have light pillars and icons that show through fog, and appear on the minimap.',
      'Night races are brighter.',
      'Fixed: opening Settings from the pause menu sent the host back to the lobby.',
    ],
  },
  {
    v: '1.0.1', date: '2026-10-14', title: 'Multiplayer fixes',
    items: [
      'Big tracks now reach your friends intact (large messages were silently dropped).',
      'Guests ask for a missing track again instead of sitting on a blank screen.',
      'The game keeps running when the browser throttles a background tab.',
      'Mismatched game versions get a clear "refresh" message.',
    ],
  },
  {
    v: '1.0.0', date: '2026-10-14', title: 'Live on the web',
    items: ['HOME TURF is online at hometurf-86d26fb3.netlify.app - share a room code and race.'],
  },
  {
    v: '0.3.0', date: '2026-10-14', title: 'Real sounds, better maps',
    items: [
      'Real recorded engine, tyre and crash sounds replace the synthesized engine.',
      'Street data from OpenFreeMap, with junctions healed so routes no longer detour.',
      'Track Studio map tiles fall back between OSM, Esri and HOT.',
    ],
  },
  {
    v: '0.2.0', date: '2026-10-14', title: 'Garage',
    items: [
      'Visual car parts that trade stats against weight.',
      'Interchangeable engines and part upgrades that unlock as you level up.',
      'Test Bench: try a build on a simulated lap before racing.',
      'F1-style purple / green / yellow sector times.',
    ],
  },
  {
    v: '0.1.0', date: '2026-10-14', title: 'First lap',
    items: [
      '3D kart racing in the browser, on circuits built from real streets.',
      'Host a room from your own browser; friends join with a 5-letter code.',
      'Track Studio: turn your neighbourhood into a circuit.',
      'Race weekends with practice, qualifying and race.',
      'Items, abilities, drifting and mini-turbos.',
      'Chat, keyboard and controller support.',
    ],
  },
];
