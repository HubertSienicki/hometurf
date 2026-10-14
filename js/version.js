// The game's version and changelog: the one source for the menu badge, the
// Changelog screen, CHANGELOG.md and dist/version.json (both written by
// `npm run build`). To release: bump VERSION, add an entry on top, build,
// commit, then `git tag vX.Y.Z` (see README).
export const VERSION = '1.2.0';

// Filled in by scripts/build.mjs from git; 'dev' when served from source.
export const BUILD = { commit: 'dev', date: '' };

export const CHANGELOG = [
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
