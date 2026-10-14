// Inline SVG icons (48x48) for items, abilities and part slots.
const S = (body, vb = 48) => `<svg viewBox="0 0 ${vb} ${vb}" xmlns="http://www.w3.org/2000/svg" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
const O = 'stroke="#10121a" stroke-width="2.5"';

export const ITEM_ICONS = {
  boost: S(`<path d="M14 40 L30 6 L28 22 L36 22 L18 44 L22 28 Z" fill="#ffb02e" ${O}/><path d="M22 28 L24 20" stroke="#fff6" stroke-width="2"/>`),
  boost3: S(`<g transform="translate(-8 4) scale(.7)"><path d="M14 40 L30 6 L28 22 L36 22 L18 44 L22 28 Z" fill="#ffb02e" ${O}/></g><g transform="translate(9 4) scale(.7)"><path d="M14 40 L30 6 L28 22 L36 22 L18 44 L22 28 Z" fill="#ffb02e" ${O}/></g><g transform="translate(1 -4) scale(.7)"><path d="M14 40 L30 6 L28 22 L36 22 L18 44 L22 28 Z" fill="#ffd25e" ${O}/></g>`),
  oil: S(`<path d="M24 5 C30 16 38 22 38 31 A14 14 0 0 1 10 31 C10 22 18 16 24 5Z" fill="#1d1f2a" ${O}/><path d="M17 30 A8 8 0 0 0 22 38" stroke="#8a6bff" stroke-width="3" fill="none"/><circle cx="29" cy="25" r="2.5" fill="#fff8"/>`),
  bouncer: S(`<circle cx="26" cy="26" r="15" fill="#4ade5a" ${O}/><path d="M17 21 Q26 14 35 21 M15 29 Q26 36 37 29" stroke="#1d7a2a" stroke-width="2.5" fill="none"/><path d="M4 18 H10 M2 26 H9 M4 34 H10" stroke="#fff" stroke-width="3"/>`),
  missile: S(`<g transform="rotate(-35 24 24)"><path d="M24 4 C30 10 31 18 30 32 H18 C17 18 18 10 24 4Z" fill="#e8402f" ${O}/><path d="M18 26 L11 36 L18 34Z M30 26 L37 36 L30 34Z" fill="#2b2d38" ${O}/><circle cx="24" cy="16" r="3.2" fill="#fff"/><path d="M20 34 Q24 46 28 34" fill="#ffb02e"/></g>`),
  mine: S(`<rect x="7" y="9" width="32" height="32" rx="7" fill="#ff6a6a" ${O}/><text x="23" y="34" font-size="24" font-weight="900" font-family="Arial" fill="#fff" text-anchor="middle" transform="rotate(180 23 26)">?</text>`),
  shield: S(`<circle cx="24" cy="24" r="17" fill="#64d4ff55" stroke="#64d4ff" stroke-width="3.5"/><path d="M15 18 A11 11 0 0 1 26 12" stroke="#fff" stroke-width="3" fill="none"/>`),
  ink: S(`<path d="M24 8 C27 15 34 10 35 17 C42 18 37 25 41 29 C37 33 33 31 31 38 C26 36 24 43 19 38 C13 40 13 33 9 30 C6 24 13 23 11 17 C15 12 20 16 24 8Z" fill="#ff4fd8" ${O}/><circle cx="20" cy="22" r="3" fill="#fff8"/>`),
  zap: S(`<path d="M27 3 L11 27 H22 L18 45 L37 18 H26 Z" fill="#ffe14a" ${O}/>`),
  star: S(`<path d="M24 4 L29.5 17.5 L44 18.5 L33 28 L36.5 42.5 L24 34.5 L11.5 42.5 L15 28 L4 18.5 L18.5 17.5Z" fill="url(#rg)" ${O}/><defs><linearGradient id="rg" x1="0" x2="1" y1="0" y2="1"><stop offset="0" stop-color="#ffe14a"/><stop offset=".5" stop-color="#ff7a2c"/><stop offset="1" stop-color="#ff3d7f"/></linearGradient></defs>`),
  seeker: S(`<path d="M4 26 L24 18 L44 26 L24 31Z" fill="#9fd0ff" ${O}/><path d="M24 9 L32 24 L24 38 L16 24Z" fill="#2f7cff" ${O}/><circle cx="24" cy="23" r="3" fill="#fff"/>`),
  swap: S(`<path d="M8 18 H34 L28 11 M40 30 H14 L20 37" stroke="#10121a" stroke-width="8" fill="none"/><path d="M8 18 H34 L28 11 M40 30 H14 L20 37" stroke="#b06bff" stroke-width="4.5" fill="none"/>`),
};

export const ABILITY_ICONS = {
  nitro: S(`<path d="M8 12 L22 24 L8 36 M22 12 L36 24 L22 36" stroke="#10121a" stroke-width="9" fill="none"/><path d="M8 12 L22 24 L8 36 M22 12 L36 24 L22 36" stroke="#4ab8ff" stroke-width="5" fill="none"/>`),
  ram: S(`<path d="M6 30 C6 18 14 12 24 12 C34 12 42 18 42 30 L36 36 H12Z" fill="#ff4a3a" ${O}/><path d="M10 18 C4 14 4 8 8 6 M38 18 C44 14 44 8 40 6" stroke="#f2e8d0" stroke-width="4" fill="none"/>`),
  blink: S(`<circle cx="12" cy="24" r="5" fill="#b06bff55" stroke="#b06bff" stroke-width="2.5" stroke-dasharray="3 3"/><circle cx="36" cy="24" r="7" fill="#b06bff" ${O}/><path d="M18 24 H27" stroke="#d7a6ff" stroke-width="3" stroke-dasharray="3 3"/>`),
  emp: S(`<circle cx="24" cy="24" r="6" fill="#5ad8ff" ${O}/><circle cx="24" cy="24" r="13" stroke="#5ad8ff" stroke-width="3" fill="none"/><circle cx="24" cy="24" r="20" stroke="#5ad8ff88" stroke-width="3" fill="none"/>`),
  oil3: S(`${[10, 24, 38].map(x => `<path d="M${x} 12 C${x + 4} 20 ${x + 7} 24 ${x + 7} 29 A7 7 0 0 1 ${x - 7} 29 C${x - 7} 24 ${x - 4} 20 ${x} 12Z" fill="#1d1f2a" stroke="#8a6bff" stroke-width="2"/>`).join('')}`),
  grapple: S(`<path d="M10 40 L30 16" stroke="#ffd23f" stroke-width="3" stroke-dasharray="4 3"/><path d="M30 10 V24 M30 24 C30 32 40 32 40 24 M30 24 C30 32 20 32 20 24" stroke="#10121a" stroke-width="7" fill="none"/><path d="M30 10 V24 M30 24 C30 32 40 32 40 24 M30 24 C30 32 20 32 20 24" stroke="#ffd23f" stroke-width="3.5" fill="none"/>`),
  slam: S(`<path d="M24 4 V26 M16 18 L24 26 L32 18" stroke="#10121a" stroke-width="8" fill="none"/><path d="M24 4 V26 M16 18 L24 26 L32 18" stroke="#ffe7a8" stroke-width="4" fill="none"/><path d="M4 38 Q24 30 44 38" stroke="#ffe7a8" stroke-width="3.5" fill="none"/><path d="M10 44 Q24 38 38 44" stroke="#ffe7a888" stroke-width="3" fill="none"/>`),
  mirror: S(`<path d="M24 5 L40 11 V24 C40 34 32 40 24 44 C16 40 8 34 8 24 V11Z" fill="#d8e6ff" ${O}/><path d="M16 26 L24 18 L32 26 M24 18 V34" stroke="#2f5cff" stroke-width="3.5" fill="none"/>`),
};

export const SLOT_ICONS = {
  engine: S(`<path d="M8 18 H14 V14 H28 V18 H34 L38 22 H42 V32 H38 L34 36 H14 L10 32 H8Z" fill="#9aa3b5" ${O}/><path d="M20 14 V10 M24 14 V10" stroke="#10121a" stroke-width="3"/>`),
  exhaust: S(`<path d="M4 22 H30 L36 18 H42 V32 H36 L30 28 H4Z" fill="#c7ccd6" ${O}/><circle cx="42" cy="25" r="3" fill="#ff7a2c"/>`),
  hood: S(`<path d="M6 34 L12 16 H36 L42 34Z" fill="#9aa3b5" ${O}/><path d="M18 22 H30 V28 H18Z" fill="#10121a"/>`),
  vents: S(`<rect x="8" y="10" width="32" height="28" rx="4" fill="#9aa3b5" ${O}/><path d="M14 18 H34 M14 24 H34 M14 30 H34" stroke="#10121a" stroke-width="3"/>`),
  wing: S(`<path d="M4 16 H44 L40 22 H8Z" fill="#9aa3b5" ${O}/><path d="M14 22 V34 M34 22 V34" stroke="#10121a" stroke-width="4"/><path d="M6 36 H42" stroke="#9aa3b5" stroke-width="4"/>`),
  aero: S(`<path d="M4 28 C10 18 38 18 44 28 L40 32 H8Z" fill="#9aa3b5" ${O}/><path d="M2 34 H46" stroke="#10121a" stroke-width="4"/>`),
  fenders: S(`<path d="M6 34 C6 18 42 18 42 34" stroke="#10121a" stroke-width="9" fill="none"/><path d="M6 34 C6 18 42 18 42 34" stroke="#9aa3b5" stroke-width="5" fill="none"/><circle cx="24" cy="36" r="8" fill="#2a2d38"/>`),
  tires: S(`<circle cx="24" cy="24" r="18" fill="#2a2d38" ${O}/><circle cx="24" cy="24" r="9" fill="#9aa3b5" ${O}/><path d="M24 6 V12 M24 36 V42 M6 24 H12 M36 24 H42" stroke="#555a66" stroke-width="3"/>`),
  wheels: S(`<circle cx="24" cy="24" r="18" fill="#c7ccd6" ${O}/><circle cx="24" cy="24" r="4" fill="#10121a"/>${[0, 72, 144, 216, 288].map(a => `<path d="M24 24 L24 9" transform="rotate(${a} 24 24)" stroke="#10121a" stroke-width="4"/>`).join('')}`),
  susp: S(`<path d="M24 4 V10 M24 38 V44" stroke="#10121a" stroke-width="5"/><path d="M16 10 H32 M16 38 H32" stroke="#10121a" stroke-width="4"/><path d="M18 12 L30 16 L18 20 L30 24 L18 28 L30 32 L18 36" stroke="#ffb02e" stroke-width="3.5" fill="none"/>`),
  armor: S(`<path d="M24 5 L40 11 V24 C40 34 32 40 24 44 C16 40 8 34 8 24 V11Z" fill="#9aa3b5" ${O}/><path d="M16 22 H32 M16 30 H32" stroke="#10121a" stroke-width="3"/>`),
  paint: S(`<path d="M10 38 C4 28 10 10 26 8 C40 6 46 18 40 26 C36 32 28 26 26 32 C24 38 16 44 10 38Z" fill="#ffd23f" ${O}/><circle cx="18" cy="20" r="3.5" fill="#ff3d7f"/><circle cx="28" cy="16" r="3.5" fill="#29d8ff"/><circle cx="35" cy="22" r="3" fill="#3ddc84"/>`),
};
