// Flat line icons (24×24, round stroke), shared by the app (as SVG) and the recap images (drawn on canvas).
// Each icon is a list of path strings; { d, fill: true } entries are solid dots.

const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;
const rect = (x, y, w, h, r) =>
  `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;
const dot = (cx, cy, r = 1.6) => ({ d: circle(cx, cy, r), fill: true });

export const ICONS = {
  camera: ['M3 8.5A2.5 2.5 0 0 1 5.5 6h2l1.5-2h6l1.5 2h2A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z', circle(12, 13, 3.5)],
  image: [rect(3, 4, 18, 16, 2.5), dot(9, 9.5, 1.7), 'M3.5 18l5-5 3.5 3.5 2.5-2.5 6 6'],
  dice: [rect(3.5, 3.5, 17, 17, 3.5), dot(8.5, 8.5), dot(15.5, 15.5), dot(12, 12), dot(15.5, 8.5), dot(8.5, 15.5)],
  ban: [circle(12, 12, 9), 'M5.7 5.7l12.6 12.6'],
  pencil: ['M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z', 'M13.5 6.5l4 4'],
  checkCircle: [circle(12, 12, 9), 'M8 12.5l2.7 2.7L16.2 9.5'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'],
  share: ['M12 15V3', 'M7 8l5-5 5 5', 'M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7'],
  trophy: ['M8 4h8v5a4 4 0 0 1-8 0z', 'M8 6H5.5a3 3 0 0 0 3 4.2', 'M16 6h2.5a3 3 0 0 1-3 4.2', 'M12 13v4', 'M8 21h8', 'M9.5 17h5v4h-5z'],
  equal: [circle(12, 12, 9), 'M8 10h8', 'M8 14h8'],
  sparkles: ['M11 3l1.9 5.1L18 10l-5.1 1.9L11 17l-1.9-5.1L4 10l5.1-1.9z', 'M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z'],
  flag: ['M5 21V4', 'M5 4h12l-2.5 4.5L17 13H5'],
  clock: [circle(12, 12, 9), 'M12 7v5l3.5 2'],
  hourglass: ['M6.5 3h11', 'M6.5 21h11', 'M8 3v3.5L12 12l4-5.5V3', 'M8 21v-3.5L12 12l4 5.5V21'],
  search: [circle(11, 11, 7), 'M16.2 16.2L21 21'],
  gem: ['M6.5 4h11L21 9l-9 11L3 9z', 'M3 9h18', 'M9.5 4L12 9l2.5-5', 'M12 9v11'],
  list: ['M9 6h11', 'M9 12h11', 'M9 18h11', dot(4.5, 6, 1.4), dot(4.5, 12, 1.4), dot(4.5, 18, 1.4)],
  phone: [rect(7, 2.5, 10, 19, 2.5), 'M11 18h2'],
  x: ['M6 6l12 12', 'M18 6L6 18'],
  undo: ['M4 4v5h5', 'M4.5 9A8 8 0 1 1 4 13'],
  flip: ['M20 10A8 8 0 0 0 5.6 6.4L4 8', 'M4 3.5V8h4.5', 'M4 14a8 8 0 0 0 14.4 3.6L20 16', 'M20 20.5V16h-4.5'],
  user: [circle(12, 8, 4), 'M4.5 21a7.5 7.5 0 0 1 15 0'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
  pin: ['M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z', circle(12, 9.5, 2.5)],
  target: [circle(12, 12, 9), circle(12, 12, 5), dot(12, 12, 1.5)],
  zap: ['M13 2.5L4.5 14H11l-1 7.5L18.5 10H12z'],
  alert: [circle(12, 12, 9), 'M12 7.5v5.5', dot(12, 16.3, 1.3)],
  collage: ['M7 3h11a3 3 0 0 1 3 3v11', rect(3, 7, 14, 14, 2.5), dot(8, 11.5), 'M3.5 19l4.5-4.5 3 3 2-2 3.5 3.5'],
  save: ['M5 3h11l3 3v13a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z', 'M8 3v5h7V3', rect(8, 13, 8, 8, 1)],
  plus: ['M12 5v14', 'M5 12h14'],
};

/** Inner SVG markup for an icon (stroke/fill come from currentColor). */
export function iconMarkup(name) {
  return (ICONS[name] || []).map((p) => (typeof p === 'string'
    ? `<path d="${p}"/>`
    : `<path d="${p.d}" fill="currentColor" stroke="none"/>`)).join('');
}

/** A standalone SVG string, e.g. for a data: URL. */
export function iconSVG(name, color = '#141414', size = 24) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" color="${color}"`
    + ` stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${iconMarkup(name)}</svg>`;
}

/** Draw an icon on a canvas with its top-left at (x, y). */
export function drawIcon(ctx, name, x, y, size, color = '#141414', weight = 2.2) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.lineWidth = weight; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const p of ICONS[name] || []) {
    const path = new Path2D(typeof p === 'string' ? p : p.d);
    if (typeof p === 'string') ctx.stroke(path); else ctx.fill(path);
  }
  ctx.restore();
}
