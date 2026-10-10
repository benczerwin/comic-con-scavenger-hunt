// Original hero-badge emblems (shape + glyph + colors), rendered as inline SVG.

const star = (cx, cy, R, r, pts = 5, rot = -90) => {
  const out = [];
  for (let i = 0; i < pts * 2; i++) {
    const rad = ((rot + (i * 180) / pts) * Math.PI) / 180;
    const rr = i % 2 ? r : R;
    out.push(`${(cx + rr * Math.cos(rad)).toFixed(1)},${(cy + rr * Math.sin(rad)).toFixed(1)}`);
  }
  return out.join(' ');
};

const SHAPES = {
  circle: '<circle cx="50" cy="50" r="46"/>',
  shield: '<path d="M50 4 L92 17 V48 C92 74 73 90 50 97 C27 90 8 74 8 48 V17 Z"/>',
  hex: '<path d="M50 3 L91 26.5 V73.5 L50 97 L9 73.5 V26.5 Z"/>',
  diamond: '<path d="M50 2 L94 34 L50 98 L6 34 Z"/>',
  crest: '<path d="M6 10 H94 V54 L50 96 L6 54 Z"/>',
  burst: `<polygon points="${star(50, 50, 48, 38, 14)}"/>`,
};

const W = 'fill="#fff"';
const GLYPHS = {
  bolt: `<path ${W} d="M57 12 L28 55 H47 L40 88 L72 42 H53 Z"/>`,
  star: `<polygon ${W} points="${star(50, 52, 32, 13)}"/>`,
  spider: `<g stroke="#fff" stroke-width="4" fill="none" stroke-linecap="round">
    <path d="M44 46 L30 34 L24 18 M56 46 L70 34 L76 18 M43 52 L24 48 L14 38 M57 52 L76 48 L86 38
             M43 58 L26 64 L18 78 M57 58 L74 64 L82 78 M45 63 L36 76 L34 90 M55 63 L64 76 L66 90"/></g>
    <ellipse ${W} cx="50" cy="44" rx="7" ry="7"/><ellipse ${W} cx="50" cy="60" rx="9" ry="12"/>`,
  moon: `<mask id="moon-cut"><rect width="100" height="100" fill="#fff"/><circle cx="63" cy="40" r="27" fill="#000"/></mask>
    <circle ${W} cx="46" cy="52" r="34" mask="url(#moon-cut)"/>`,
  flame: `<path ${W} d="M50 10 C60 30 76 38 72 62 C69 79 60 88 50 88 C37 88 27 78 29 61 C30 50 37 44 40 34 C44 45 47 50 51 52 C53 40 47 25 50 10 Z"/>`,
  atom: `<g stroke="#fff" stroke-width="4.5" fill="none">
    <ellipse cx="50" cy="50" rx="36" ry="13"/>
    <ellipse cx="50" cy="50" rx="36" ry="13" transform="rotate(60 50 50)"/>
    <ellipse cx="50" cy="50" rx="36" ry="13" transform="rotate(-60 50 50)"/></g>
    <circle ${W} cx="50" cy="50" r="7"/>`,
  target: `<g stroke="#fff" stroke-width="6" fill="none"><circle cx="50" cy="50" r="30"/><circle cx="50" cy="50" r="17"/></g><circle ${W} cx="50" cy="50" r="6"/>`,
  crown: `<path ${W} d="M22 68 L17 32 L35 47 L50 24 L65 47 L83 32 L78 68 Z"/><rect ${W} x="22" y="72" width="56" height="8" rx="2"/>`,
  eye: `<path ${W} d="M12 50 Q50 14 88 50 Q50 86 12 50 Z"/><circle cx="50" cy="50" r="14" fill="currentColor"/><circle ${W} cx="50" cy="50" r="5"/>`,
  claw: `<g stroke="#fff" stroke-width="9" stroke-linecap="round"><path d="M30 18 L22 80"/><path d="M50 14 L44 86"/><path d="M70 18 L66 80"/></g>`,
  wing: `<path ${W} d="M8 44 C20 43 25 37 27 30 C31 39 37 41 41 39 L45 30 L50 37 L55 30 L59 39 C63 41 69 39 73 30 C75 37 80 43 92 44 C81 50 77 59 77 68 C69 60 61 62 57 68 C55 62 53 60 50 66 C47 60 45 62 43 68 C39 62 31 60 23 68 C23 59 19 50 8 44 Z"/>`,
  hammer: `<rect ${W} x="20" y="16" width="60" height="30" rx="4"/><rect ${W} x="44" y="44" width="12" height="42" rx="3"/>`,
  skull: `<path ${W} d="M50 12 C29 12 18 27 18 45 C18 57 25 64 31 67 V80 H69 V67 C75 64 82 57 82 45 C82 27 71 12 50 12 Z"/>
    <circle cx="37" cy="46" r="9" fill="currentColor"/><circle cx="63" cy="46" r="9" fill="currentColor"/>
    <path d="M46 62 L50 55 L54 62 Z" fill="currentColor"/>`,
  heart: `<path ${W} d="M50 84 C20 62 12 48 14 34 C16 21 30 14 41 20 C46 23 49 27 50 30 C51 27 54 23 59 20 C70 14 84 21 86 34 C88 48 80 62 50 84 Z"/>`,
  gem: `<path ${W} d="M30 22 H70 L86 40 L50 86 L14 40 Z"/><path d="M14 40 H86 M38 22 L32 40 L50 86 L68 40 L62 22" stroke="currentColor" stroke-width="3" fill="none"/>`,
  delta: `<path ${W} d="M50 12 L90 84 H10 Z M50 36 L30 72 H70 Z" fill-rule="evenodd"/>`,
  infinity: `<path d="M50 50 C40 36 18 36 18 50 C18 64 40 64 50 50 C60 36 82 36 82 50 C82 64 60 64 50 50 Z" stroke="#fff" stroke-width="9" fill="none"/>`,
  sword: `<path ${W} d="M46 8 H54 V60 H46 Z"/><rect ${W} x="30" y="58" width="40" height="8" rx="3"/><rect ${W} x="45" y="66" width="10" height="18"/><circle ${W} cx="50" cy="88" r="6"/>`,
  paw: `<ellipse ${W} cx="50" cy="64" rx="18" ry="15"/><ellipse ${W} cx="28" cy="44" rx="8" ry="10"/><ellipse ${W} cx="72" cy="44" rx="8" ry="10"/><ellipse ${W} cx="40" cy="28" rx="8" ry="10"/><ellipse ${W} cx="60" cy="28" rx="8" ry="10"/>`,
  shuriken: `<polygon ${W} points="${star(50, 50, 40, 10, 4, -90)}"/><circle cx="50" cy="50" r="6" fill="currentColor"/>`,
  rocket: `<path ${W} d="M50 8 C64 20 68 40 66 62 H34 C32 40 36 20 50 8 Z"/><path ${W} d="M34 52 L20 72 L34 68 Z M66 52 L80 72 L66 68 Z"/><path d="M42 68 L50 90 L58 68 Z" fill="#ffd23f"/><circle cx="50" cy="36" r="7" fill="currentColor"/>`,
  ring: `<circle cx="50" cy="50" r="34" stroke="#fff" stroke-width="7" fill="none"/><circle cx="50" cy="50" r="22" fill="currentColor" stroke="#fff" stroke-width="4"/><polygon ${W} points="${star(50, 51, 17, 7)}"/>`,
  web: `<g stroke="#fff" stroke-width="3" fill="none"><path d="M50 12 V88 M12 50 H88 M23 23 L77 77 M77 23 L23 77"/>
    <path d="M50 24 L68 32 L76 50 L68 68 L50 76 L32 68 L24 50 L32 32 Z"/><path d="M50 38 L58 42 L62 50 L58 58 L50 62 L42 58 L38 50 L42 42 Z"/></g>`,
};

export const EMBLEMS = [
  { id: 'thunder', name: 'Thunderstrike', shape: 'circle', glyph: 'bolt', c1: '#e63946', c2: '#9d0208' },
  { id: 'sentinel', name: 'Star Sentinel', shape: 'circle', glyph: 'ring', c1: '#1d4ed8', c2: '#0b2a6f' },
  { id: 'weaver', name: 'Web Weaver', shape: 'circle', glyph: 'spider', c1: '#dc2626', c2: '#1e3a8a' },
  { id: 'nightwing', name: 'Night Raider', shape: 'shield', glyph: 'wing', c1: '#334155', c2: '#0f172a' },
  { id: 'lunar', name: 'Lunar Rogue', shape: 'hex', glyph: 'moon', c1: '#6d28d9', c2: '#2e1065' },
  { id: 'inferno', name: 'Inferno', shape: 'burst', glyph: 'flame', c1: '#f97316', c2: '#b91c1c' },
  { id: 'quantum', name: 'Quantum', shape: 'circle', glyph: 'atom', c1: '#06b6d4', c2: '#0e4f74' },
  { id: 'bullseye', name: 'Dead Eye', shape: 'diamond', glyph: 'target', c1: '#ef4444', c2: '#7f1d1d' },
  { id: 'royal', name: 'Royal Flush', shape: 'crest', glyph: 'crown', c1: '#eab308', c2: '#a16207' },
  { id: 'oracle', name: 'All-Seeing', shape: 'hex', glyph: 'eye', c1: '#10b981', c2: '#065f46' },
  { id: 'berserker', name: 'Berserker', shape: 'shield', glyph: 'claw', c1: '#f59e0b', c2: '#1f2937' },
  { id: 'storm', name: 'Storm Hammer', shape: 'circle', glyph: 'hammer', c1: '#64748b', c2: '#1e293b' },
  { id: 'bonehead', name: 'Bonehead', shape: 'burst', glyph: 'skull', c1: '#111827', c2: '#4b5563' },
  { id: 'heart', name: 'Heartbreaker', shape: 'diamond', glyph: 'heart', c1: '#ec4899', c2: '#9d174d' },
  { id: 'gem', name: 'Gem Keeper', shape: 'hex', glyph: 'gem', c1: '#8b5cf6', c2: '#4c1d95' },
  { id: 'delta', name: 'Delta Force', shape: 'shield', glyph: 'delta', c1: '#22c55e', c2: '#14532d' },
  { id: 'infinity', name: 'Infinite', shape: 'circle', glyph: 'infinity', c1: '#0ea5e9', c2: '#7c3aed' },
  { id: 'blade', name: 'Blademaster', shape: 'crest', glyph: 'sword', c1: '#94a3b8', c2: '#334155' },
  { id: 'wildpaw', name: 'Wild Paw', shape: 'burst', glyph: 'paw', c1: '#f97316', c2: '#7c2d12' },
  { id: 'shadow', name: 'Shadow Star', shape: 'diamond', glyph: 'shuriken', c1: '#1f2937', c2: '#7f1d1d' },
  { id: 'cosmic', name: 'Cosmic Rocket', shape: 'circle', glyph: 'rocket', c1: '#2563eb', c2: '#db2777' },
  { id: 'nova', name: 'Nova', shape: 'burst', glyph: 'star', c1: '#facc15', c2: '#ea580c' },
  { id: 'spinner', name: 'Spinner', shape: 'hex', glyph: 'web', c1: '#be123c', c2: '#111827' },
  { id: 'volt', name: 'Volt', shape: 'shield', glyph: 'bolt', c1: '#a3e635', c2: '#166534' },
];

export const emblemById = (id) => EMBLEMS.find((e) => e.id === id) || EMBLEMS[0];

export function emblemSVG(id) {
  const e = emblemById(id);
  const shape = SHAPES[e.shape] || SHAPES.circle;
  const gid = `g-${e.id}`;
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style="color:${e.c2}">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${e.c1}"/><stop offset="1" stop-color="${e.c2}"/></linearGradient></defs>
    <g fill="url(#${gid})" stroke="#111" stroke-width="4" stroke-linejoin="round">${shape}</g>
    <g transform="translate(50 50) scale(0.62) translate(-50 -50)">${GLYPHS[e.glyph] || ''}</g>
  </svg>`;
}
