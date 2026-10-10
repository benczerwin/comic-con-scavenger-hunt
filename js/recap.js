// Renders a finished game into one shareable comic-poster PNG.
import { emblemSVG, emblemById } from './data/emblems.js';
import * as G from './game.js';

const W = 1080;
const PAD = 48;
const INK = '#141414';
const PAPER = '#fff8e7';
const YELLOW = '#ffd23f';
const RED = '#ef3e36';
const CAT_COLORS = {
  theme: '#ffe066', nycc: '#a5d8ff', cosplay: '#ffa8a8', anime: '#fcc2d7',
  games: '#b2f2bb', hot: '#ffc078', action: '#d0bfff', free: '#ffd23f',
};
const DISPLAY = "'Bangers', Impact, sans-serif";
const BODY = "'Nunito', system-ui, sans-serif";

const loadImg = (src) => new Promise((resolve) => {
  if (!src) return resolve(null);
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = () => resolve(null);
  img.src = src;
});
const emblemImg = (id) => loadImg('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(emblemSVG(id)));

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Comic panel: offset black shadow + thick outline. */
function panel(ctx, x, y, w, h, fill, r = 22) {
  ctx.fillStyle = INK;
  roundRect(ctx, x + 8, y + 8, w, h, r); ctx.fill();
  ctx.fillStyle = fill;
  roundRect(ctx, x, y, w, h, r); ctx.fill();
  ctx.lineWidth = 6; ctx.strokeStyle = INK; ctx.stroke();
}

function halftone(ctx, x, y, w, h, color, step = 14, rad = 2) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = color;
  for (let yy = y; yy < y + h; yy += step) {
    for (let xx = x + ((yy / step) % 2 ? step / 2 : 0); xx < x + w; xx += step) {
      ctx.beginPath(); ctx.arc(xx, yy, rad, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

function wrapLines(ctx, text, maxW, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width <= maxW || !line) line = test;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

function comicText(ctx, text, x, y, size, fill, align = 'center') {
  ctx.font = `${size}px ${DISPLAY}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  ctx.fillStyle = INK;
  ctx.fillText(text, x + size * 0.05, y + size * 0.05);
  ctx.lineWidth = Math.max(3, size * 0.05);
  ctx.strokeStyle = INK;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

const firstName = (p) => (p?.name || 'Someone').split(' ')[0];

/**
 * game: game doc. boards: bingo boards (ignored for versus). thumbs: {photoId: {thumb}}.
 * Returns a PNG Blob.
 */
export async function renderRecap({ game, boards = [], thumbs, playersById }) {
  await Promise.all([
    document.fonts?.load(`100px ${DISPLAY}`), document.fonts?.load(`900 40px ${BODY}`), document.fonts?.load(`700 30px ${BODY}`),
  ].filter(Boolean)).catch(() => {});

  const isBingo = game.mode === 'bingo';
  const n = game.size;

  // ── who won, which board to feature, stats per player
  let featured, cells, highlight, winnerId = game.winner;
  const rows = [];
  if (isBingo) {
    const scored = boards.map((b) => ({ b, s: G.scoreBoard(b) }));
    if (!winnerId && game.winRule === 'most' && scored.length) {
      const best = Math.max(...scored.map((x) => x.s.points));
      const leaders = scored.filter((x) => x.s.points === best);
      winnerId = leaders.length === 1 ? leaders[0].b.playerId : 'draw';
    }
    const top = scored.find((x) => x.b.playerId === winnerId) ||
      scored.slice().sort((a, b) => b.s.points - a.s.points)[0];
    featured = top?.b;
    highlight = top?.s.lineCells || new Set();
    cells = featured ? featured.items.map((item, i) => ({
      item, photo: featured.marks?.[i]?.photo, by: featured.playerId,
    })) : [];
    for (const { b, s } of scored.sort((a, c) => c.s.points - a.s.points)) {
      rows.push({
        pid: b.playerId,
        stats: `${s.found} photo${s.found === 1 ? '' : 's'} · ${s.lines} line${s.lines === 1 ? '' : 's'}${game.winRule === 'most' ? ` · ${s.points} pts` : ''}`,
      });
    }
  } else {
    const counts = G.versusCounts(game);
    highlight = new Set(winnerId && winnerId !== 'draw' ? G.versusWinLine(game, winnerId) || [] : []);
    cells = game.items.map((item, i) => ({ item, photo: game.claims?.[i]?.photo, by: game.claims?.[i]?.by }));
    for (const pid of game.players.slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0))) {
      rows.push({ pid, stats: `${counts[pid] || 0} square${counts[pid] === 1 ? '' : 's'} claimed` });
    }
  }

  // Extra photos not on the featured board (bingo: everyone else's finds).
  const extra = isBingo
    ? boards.filter((b) => b !== featured).flatMap((b) =>
      Object.entries(b.marks || {}).map(([i, m]) => ({ photo: m.photo, by: b.playerId, text: b.items[i]?.text, at: m.at })))
      .filter((x) => thumbs[x.photo]).sort((a, b) => b.at - a.at).slice(0, 10)
    : [];
  const totalPhotos = Object.keys(thumbs).length;

  // ── layout
  const boardW = W - PAD * 2;
  const H_TITLE = 250, H_WIN = 210, H_CAPTION = 70, H_BOARD = boardW + 20, H_ROW = 92;
  const H_SCORES = 70 + rows.length * H_ROW + 20;
  const stripCols = 5, stripCell = (boardW - (stripCols - 1) * 14) / stripCols;
  const H_STRIP = extra.length ? 80 + Math.ceil(extra.length / stripCols) * (stripCell + 14) : 0;
  const H_FOOT = 110;
  const H = H_TITLE + H_WIN + H_CAPTION + H_BOARD + 40 + H_SCORES + (H_STRIP ? H_STRIP + 30 : 0) + H_FOOT;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  halftone(ctx, 0, 0, W, H, 'rgba(239,62,54,0.10)', 18, 2.2);

  // title
  let y = 0;
  comicText(ctx, 'NYCC PHOTO HUNT', W / 2, 140, 118, RED);
  const date = new Date(game.wonAt || game.createdAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const modeLine = isBingo
    ? `Bingo Hunt · ${n}×${n} · ${G.WIN_RULES[game.winRule]?.label || ''}`
    : `Showdown · ${n}×${n} · ${game.connect} in a row`;
  ctx.font = `900 34px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'center';
  ctx.fillText(`${modeLine} · ${date}`, W / 2, 200);
  y = H_TITLE;

  // winner burst panel
  panel(ctx, PAD, y, boardW, H_WIN - 30, YELLOW);
  ctx.save();
  roundRect(ctx, PAD, y, boardW, H_WIN - 30, 22); ctx.clip();
  const cx = PAD + boardW / 2, cy = y + (H_WIN - 30) / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  for (let a = 0; a < 24; a++) {
    if (a % 2) continue;
    const a0 = (a / 24) * Math.PI * 2, a1 = ((a + 1) / 24) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a0) * 900, cy + Math.sin(a0) * 900);
    ctx.lineTo(cx + Math.cos(a1) * 900, cy + Math.sin(a1) * 900);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ctx.lineWidth = 6; ctx.strokeStyle = INK; roundRect(ctx, PAD, y, boardW, H_WIN - 30, 22); ctx.stroke();
  const winner = winnerId && winnerId !== 'draw' ? playersById[winnerId] : null;
  const headline = winnerId === 'draw' ? "IT'S A TIE!" : winner ? `${firstName(winner).toUpperCase()} WINS!` : 'THE HUNT GOES ON…';
  if (winner) {
    const em = await emblemImg(winner.emblem);
    if (em) ctx.drawImage(em, PAD + 30, cy - 65, 130, 130);
    ctx.font = '72px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🏆', PAD + boardW - 85, cy + 4);
    ctx.textBaseline = 'alphabetic';
  }
  comicText(ctx, headline, cx + (winner ? 10 : 0), cy + 36, headline.length > 14 ? 88 : 104, RED);
  y += H_WIN;

  // board caption
  ctx.font = `900 34px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'left';
  const caption = isBingo
    ? `${featured ? `${firstName(playersById[featured.playerId])}'s ${winnerId === featured?.playerId ? 'winning ' : ''}card` : 'The card'}`
    : 'The battlefield';
  ctx.fillText(caption.toUpperCase(), PAD, y + 40);
  y += H_CAPTION;

  // board
  ctx.fillStyle = INK; roundRect(ctx, PAD, y, boardW, boardW, 20); ctx.fill();
  const gap = n >= 6 ? 8 : 10, inner = 10;
  const cell = (boardW - inner * 2 - gap * (n - 1)) / n;
  const emblemCache = {};
  const getEmblem = async (pid) => (emblemCache[pid] ??= await emblemImg(playersById[pid]?.emblem));
  for (let i = 0; i < cells.length; i++) {
    const { item, photo, by } = cells[i];
    const x = PAD + inner + (i % n) * (cell + gap);
    const yy = y + inner + Math.floor(i / n) * (cell + gap);
    const img = photo ? await loadImg(thumbs[photo]?.thumb) : null;
    ctx.save();
    roundRect(ctx, x, yy, cell, cell, 10); ctx.clip();
    if (img) {
      ctx.drawImage(img, x, yy, cell, cell);
      const g = ctx.createLinearGradient(0, yy + cell * 0.55, 0, yy + cell);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.75)');
      ctx.fillStyle = g; ctx.fillRect(x, yy + cell * 0.55, cell, cell * 0.45);
      ctx.font = `800 ${Math.max(12, cell * 0.095)}px ${BODY}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
      ctx.fillText(wrapLines(ctx, item.text, cell - 12, 1)[0], x + cell / 2, yy + cell - cell * 0.07);
    } else {
      ctx.fillStyle = CAT_COLORS[item.cat] || '#fff'; ctx.fillRect(x, yy, cell, cell);
      halftone(ctx, x, yy, cell, cell, 'rgba(0,0,0,0.12)', 9, 1.4);
      ctx.globalAlpha = photo === undefined && item.tier !== 'free' ? 0.55 : 1;
      ctx.font = `${cell * 0.34}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = INK;
      ctx.fillText(item.icon, x + cell / 2, yy + cell * 0.36);
      ctx.textBaseline = 'alphabetic';
      const fs = item.tier === 'free' ? cell * 0.15 : Math.max(11, cell * 0.1);
      ctx.font = item.tier === 'free' ? `${fs}px ${DISPLAY}` : `800 ${fs}px ${BODY}`;
      const lines = wrapLines(ctx, item.text, cell - 14, 3);
      lines.forEach((l, k) => ctx.fillText(l, x + cell / 2, yy + cell * 0.66 + k * fs * 1.1));
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    if (img && by) {
      const em = await getEmblem(by);
      const es = Math.max(26, cell * 0.24);
      if (em) ctx.drawImage(em, x + 6, yy + 6, es, es);
      if (!isBingo) {
        ctx.lineWidth = Math.max(5, cell * 0.05);
        ctx.strokeStyle = emblemById(playersById[by]?.emblem).c1;
        roundRect(ctx, x + ctx.lineWidth / 2, yy + ctx.lineWidth / 2, cell - ctx.lineWidth, cell - ctx.lineWidth, 9); ctx.stroke();
      }
    }
    if (highlight.has(i)) {
      ctx.lineWidth = 7; ctx.strokeStyle = YELLOW;
      roundRect(ctx, x - 2, yy - 2, cell + 4, cell + 4, 12); ctx.stroke();
    }
  }
  y += H_BOARD + 40;

  // scoreboard
  panel(ctx, PAD, y, boardW, H_SCORES - 20, '#ffffff');
  ctx.font = `900 34px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'left';
  ctx.fillText('FINAL SCORES', PAD + 28, y + 54);
  let ry = y + 76;
  for (let k = 0; k < rows.length; k++) {
    const { pid, stats } = rows[k];
    const p = playersById[pid];
    const em = await getEmblem(pid);
    ctx.font = `${44}px ${DISPLAY}`; ctx.fillStyle = k === 0 ? RED : INK; ctx.textAlign = 'left';
    ctx.fillText(`${k + 1}`, PAD + 30, ry + 58);
    if (em) ctx.drawImage(em, PAD + 76, ry + 10, 68, 68);
    ctx.font = `900 40px ${BODY}`; ctx.fillStyle = INK;
    ctx.fillText(`${p?.name || 'Someone'}${pid === winnerId ? ' 🏆' : ''}`, PAD + 164, ry + 56);
    ctx.font = `700 30px ${BODY}`; ctx.fillStyle = '#6b6255'; ctx.textAlign = 'right';
    ctx.fillText(stats, PAD + boardW - 28, ry + 54);
    if (k < rows.length - 1) {
      ctx.strokeStyle = '#e5ddcc'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(PAD + 28, ry + H_ROW); ctx.lineTo(PAD + boardW - 28, ry + H_ROW); ctx.stroke();
    }
    ry += H_ROW;
  }
  y += H_SCORES;

  // photo strip
  if (extra.length) {
    y += 10;
    ctx.font = `900 34px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'left';
    ctx.fillText('MORE FINDS', PAD, y + 40);
    y += 64;
    for (let k = 0; k < extra.length; k++) {
      const x = PAD + (k % stripCols) * (stripCell + 14);
      const yy = y + Math.floor(k / stripCols) * (stripCell + 14);
      const img = await loadImg(thumbs[extra[k].photo]?.thumb);
      ctx.fillStyle = INK; roundRect(ctx, x + 5, yy + 5, stripCell, stripCell, 12); ctx.fill();
      ctx.save(); roundRect(ctx, x, yy, stripCell, stripCell, 12); ctx.clip();
      if (img) ctx.drawImage(img, x, yy, stripCell, stripCell);
      ctx.restore();
      ctx.lineWidth = 4; ctx.strokeStyle = INK; roundRect(ctx, x, yy, stripCell, stripCell, 12); ctx.stroke();
      const em = await getEmblem(extra[k].by);
      if (em) ctx.drawImage(em, x + 6, yy + 6, 40, 40);
    }
    y += Math.ceil(extra.length / stripCols) * (stripCell + 14) + 16;
  }

  // footer
  ctx.font = `900 30px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'center';
  ctx.fillText(`📸 ${totalPhotos} photo${totalPhotos === 1 ? '' : 's'} snapped · ${game.players.length} hunter${game.players.length === 1 ? '' : 's'} · Game ${game.code}`, W / 2, H - 58);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
