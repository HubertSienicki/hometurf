// ALL gameplay tuning lives here: physics, cars, items, abilities, scoring.
// Modules under js/sim/ are pure (no DOM, no three.js) so scripts/sim.mjs can
// run them headless to check car balance.

export const NET = {
  PEER_PREFIX: 'hometurf-v1-',
  PUBLIC_SLOTS: 8,
  PROTO: 5,           // bump on any wire-format change: mismatched tabs get told to refresh
  SNAP_HZ: 20,        // host -> everyone
  STATE_HZ: 30,       // owner -> host
  MAX_CARS: 12,
  CHUNK: 40000,       // track transfer piece size (chars); net.js splits further to fit PeerJS
  INTERP_MS: 110,     // remote cars are drawn this far in the past
  // WebSocket relay (relay/worker.js) for players whose network blocks WebRTC.
  // Empty = direct connections only.
  RELAY: 'https://hometurf-relay.hometurf-relay.workers.dev',
};

export const PHYS = {
  dt: 1 / 60,
  gravity: 26,
  hopV: 3.6,
  brake: 30,
  reverseAccel: 14,
  reverseMax: 9,
  coast: 2.2,                 // engine braking off the throttle (drag comes on top, drivetrain.js)
  boostAccel: 34,
  boostTopMul: 0.3,           // top speed bonus per unit of boost power
  driftMinSpeed: 11,
  driftTiers: [0.7, 1.5, 2.4],                   // seconds of charge for blue / orange / purple
  miniTurbo: [[0.55, 0.85], [0.95, 1.0], [1.45, 1.15]], // [seconds, power] per tier
  carHalfW: 1.0,
  carRadius: 1.15,            // collision circle (two of these must not overlap)
  wallBounce: 0.3,
  curbW: 1.1,                 // curb strip between road edge and barrier
  rampLen: 7, rampH: 1.0,
  padLen: 8, padHalfW: 2.4,
  boxRadius: 2.4,
  draftRange: 24, draftTime: 1.1,
  respawnGhost: 2.0,
};

// Stats are 1..5 and every car's stats sum to 12. The mapping to physics
// lives in physics.js (makeSpec) and was tuned with scripts/sim.mjs so that a
// skilled driver posts similar lap times in every car on a typical street loop.
export const CARS = {
  comet:  { name: 'Comet',  kind: 'Hatchback',     stats: { spd: 3, acc: 3, hnd: 3, wgt: 3 }, ability: 'nitro',
    blurb: 'The all-rounder. No weaknesses, no excuses.' },
  viper:  { name: 'Viper',  kind: 'Supercar',      stats: { spd: 5, acc: 3, hnd: 2, wgt: 2 }, ability: 'emp',
    blurb: 'Ludicrous top speed. Corners are a suggestion.' },
  pixie:  { name: 'Pixie',  kind: 'Bubble Car',    stats: { spd: 2, acc: 5, hnd: 4, wgt: 1 }, ability: 'blink',
    blurb: 'Tiny, twitchy and gone before you blink.' },
  hornet: { name: 'Hornet', kind: 'Rally Hatch',   stats: { spd: 3, acc: 2, hnd: 5, wgt: 2 }, ability: 'grapple',
    blurb: 'Rally-bred. Lives sideways in the tight stuff.' },
  brute:  { name: 'Brute',  kind: 'Panel Van',     stats: { spd: 4, acc: 2, hnd: 1, wgt: 5 }, ability: 'ram',
    blurb: 'Delivers parcels. And pain.' },
  mudcat: { name: 'Mudcat', kind: 'Dune Buggy',    stats: { spd: 3, acc: 4, hnd: 3, wgt: 2 }, ability: 'oil3',
    blurb: 'Light, punchy, leaves a mess behind it.' },
  titan:  { name: 'Titan',  kind: 'Monster Truck', stats: { spd: 3, acc: 1, hnd: 3, wgt: 5 }, ability: 'slam',
    blurb: 'Slow to start. Impossible to stop.' },
  volt:   { name: 'Volt',   kind: 'EV Sedan',      stats: { spd: 2, acc: 4, hnd: 3, wgt: 3 }, ability: 'mirror',
    blurb: 'Silent, smooth, and it bounces your rockets back.' },
};
export const CAR_IDS = Object.keys(CARS);

export const ABILITIES = {
  nitro:   { name: 'Nitro Surge',    desc: 'A long, extra-strong boost.' },
  ram:     { name: 'Ram Mode',       desc: '3.5 s of armour. Anyone you touch spins out.' },
  blink:   { name: 'Blink',          desc: 'Teleport 35 m up the road, straight through hazards.' },
  emp:     { name: 'EMP Pulse',      desc: 'Slows every car within 40 m and fries their items.' },
  oil3:    { name: 'Oil Barrage',    desc: 'Dumps three oil slicks across the road behind you.' },
  grapple: { name: 'Grapple Hook',   desc: 'Hook the car ahead: you slingshot, they get dragged.' },
  slam:    { name: 'Shockwave Slam', desc: 'Leap and slam down, flipping every car within 16 m.' },
  mirror:  { name: 'Mirror Shield',  desc: '5 s bubble that sends projectiles back to their owner.' },
};
export const ABILITY = {
  chargeTime: 34,          // seconds to fill from empty, mid-pack
  posBoost: [0.8, 1.6],    // leader .. last place charge multiplier
  perTier: 0.04,           // bonus charge per mini-turbo tier
  onHit: 0.12,             // bonus charge when you get hit
  nitro: { dur: 2.6, pow: 1.3 },
  ram: { dur: 3.5 },
  blink: { dist: 35 },
  emp: { radius: 40, slow: 2.2 },
  grapple: { range: 95, boost: 1.6, slow: 1.4 },
  slam: { radius: 16 },
  mirror: { dur: 5 },
};

export const ITEMS = {
  boost:   { name: 'Nitro',         desc: 'Quick speed boost.' },
  boost3:  { name: 'Triple Nitro',  desc: 'Three boosts.', uses: 3 },
  oil:     { name: 'Oil Slick',     desc: 'Dropped behind you. Spins out whoever hits it.' },
  bouncer: { name: 'Bouncer',       desc: 'Fired forward (hold brake for backwards). Bounces off walls.' },
  missile: { name: 'Homing Rocket', desc: 'Locks on to the car ahead of you.' },
  mine:    { name: 'Fake Box',      desc: 'Looks like an item box. Is not an item box.' },
  shield:  { name: 'Bubble Shield', desc: 'Blocks the next hit for 10 s.' },
  ink:     { name: 'Paint Bomb',    desc: 'Splatters the screens of everyone ahead of you.' },
  zap:     { name: 'Lightning',     desc: 'Zaps every opponent: brief spin, slowdown, items lost.' },
  star:    { name: 'Rocket Mode',   desc: 'Invincible and fast. Ram everyone.' },
  seeker:  { name: 'Leader Seeker', desc: 'Flies up the track and blows up whoever is in 1st.' },
  swap:    { name: 'Warp Swap',     desc: 'Swap places with the car directly ahead.' },
};
export const ITEM_IDS = Object.keys(ITEMS);

// Weights per position bucket: [leader, front, middle, back, last].
export const ITEM_ODDS = {
  boost:   [3, 7, 10, 9, 6],
  boost3:  [0, 1, 4, 8, 9],
  oil:     [12, 8, 4, 1, 0],
  bouncer: [10, 10, 7, 4, 2],
  missile: [0, 4, 8, 8, 6],
  mine:    [7, 5, 3, 1, 0],
  shield:  [6, 4, 3, 2, 1],
  ink:     [0, 1, 3, 4, 4],
  zap:     [0, 0, 1, 2, 4],
  star:    [0, 0, 2, 5, 7],
  seeker:  [0, 0, 1, 3, 4],
  swap:    [0, 0, 1, 3, 4],
};

export const ITEM_TUNE = {
  roulette: 1.3,
  boost: { dur: 1.35, pow: 1.1 },
  oil: { radius: 1.9, spin: 1.15, life: 90 },
  mine: { radius: 2.3, blast: 4, life: 90 },
  bouncer: { speed: 46, radius: 1.1, life: 7, bounces: 6 },
  missile: { speed: 54, radius: 1.5, life: 10, turn: 7 },
  seeker: { speed: 78, life: 30, blast: 9, alt: 6 },
  shield: { dur: 10 },
  ink: { dur: 4.2 },
  zap: { spin: 0.6, slow: 2.6 },
  star: { dur: 6.5 },
  stun: { spin: 1.15, tumble: 1.45, slam: 0.95 },
  boxRespawn: 2.6,
};

// Speedometer / bench readouts are scaled for feel (the world is 1:1 metres).
export const SPEEDO = 1.5;

export const POINTS = [15, 12, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

export const PAINT = ['#ff3b3b', '#ff8a1f', '#ffd23f', '#3ddc84', '#16c4c4', '#2f8cff', '#7a5cff', '#ff4fd8', '#f1f1f1', '#2a2d36'];

export const BOT_NAMES = ['Turbo Tina', 'Gearbox Greg', 'Skid Marx', 'Lola Lugnut', 'Nitro Nico', 'Penny Piston', 'Dusty Brakes',
  'Rev Rachel', 'Captain Clutch', 'Mo Mentum', 'Sally Slipstream', 'Biff Bumper', 'Axel Grease', 'Drift Dmitri', 'Ivy Ignition',
  'Rusty Hubcap', 'Polly Pothole', 'Speedbump Sam'];

export const BOT_LEVELS = [
  { name: 'Easy', top: 0.86, drift: false, react: 3.0, gain: 1.7, line: 0.25, items: 0.5 },
  { name: 'Normal', top: 0.94, drift: true, react: 1.5, gain: 2.1, line: 0.45, items: 0.8 },
  { name: 'Hard', top: 1.0, drift: true, react: 0.5, gain: 2.4, line: 0.55, items: 1.0 },
];

export const DEFAULT_SETTINGS = {
  mode: 'race',          // 'race' | 'weekend'
  laps: 3,
  practiceMin: 3,
  qualiMin: 3,
  items: true,
  abilities: true,
  bots: 5,
  botLevel: 1,
  tod: 'day',            // 'day' | 'sunset' | 'night'
  collisions: true,
  catchup: true,
  upgrades: true,         // false = everyone's parts count as level 1
  pitstops: false,        // pit-stop races: tyres wear and the pit lane opens (tracks long enough to have one)
  tyreWear: 'normal',     // 'normal' | 'high', pit-stop races only
  public: false,
};

export const TRACK_LIMITS = { minLen: 600, maxLen: 7000, widths: { narrow: 12, normal: 14, wide: 18 } };
