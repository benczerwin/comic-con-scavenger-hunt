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
  theme: '#ffe066', merch: '#99e9f2', nycc: '#a5d8ff', cosplay: '#ffa8a8', anime: '#fcc2d7',
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

/** Draws an n×n board at (x, y), w wide. cells: [{ item, photo, found, by }] */
async function drawBoard(ctx, { x, y, w, n, cells, highlight, versus, thumbs, getEmblem, playersById }) {
  const mini = w < 700;
  ctx.fillStyle = INK; roundRect(ctx, x, y, w, w, mini ? 14 : 20); ctx.fill();
  const inner = mini ? 6 : 10, gap = mini ? 5 : n >= 6 ? 8 : 10;
  const cell = (w - inner * 2 - gap * (n - 1)) / n;
  for (let i = 0; i < cells.length; i++) {
    const { item, photo, found, by } = cells[i];
    const cx = x + inner + (i % n) * (cell + gap);
    const cy = y + inner + Math.floor(i / n) * (cell + gap);
    const img = photo ? await loadImg(thumbs[photo]?.thumb) : null;
    const r = mini ? 6 : 10;
    ctx.save();
    roundRect(ctx, cx, cy, cell, cell, r); ctx.clip();
    if (img) {
      ctx.drawImage(img, cx, cy, cell, cell);
      if (!mini || cell > 120) {
        const g = ctx.createLinearGradient(0, cy + cell * 0.55, 0, cy + cell);
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.75)');
        ctx.fillStyle = g; ctx.fillRect(cx, cy + cell * 0.55, cell, cell * 0.45);
        ctx.font = `800 ${Math.max(12, cell * 0.095)}px ${BODY}`; ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
        ctx.fillText(wrapLines(ctx, item.text, cell - 12, 1)[0], cx + cell / 2, cy + cell - cell * 0.07);
      }
    } else {
      ctx.fillStyle = CAT_COLORS[item.cat] || '#fff'; ctx.fillRect(cx, cy, cell, cell);
      halftone(ctx, cx, cy, cell, cell, 'rgba(0,0,0,0.12)', mini ? 6 : 9, mini ? 1 : 1.4);
      ctx.globalAlpha = item.tier === 'free' ? 1 : found ? 0.4 : 0.55;
      ctx.font = `${cell * (mini ? 0.42 : 0.34)}px serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = INK;
      ctx.fillText(item.icon, cx + cell / 2, cy + cell * (mini ? 0.42 : 0.36));
      ctx.textBaseline = 'alphabetic';
      if (!mini || item.tier === 'free') {
        const fs = item.tier === 'free' ? cell * 0.15 : Math.max(11, cell * 0.1);
        ctx.font = item.tier === 'free' ? `${fs}px ${DISPLAY}` : `800 ${fs}px ${BODY}`;
        const lines = wrapLines(ctx, item.text, cell - 14, mini ? 1 : 3);
        lines.forEach((l, k) => ctx.fillText(l, cx + cell / 2, cy + cell * (mini ? 0.82 : 0.66) + k * fs * 1.1));
      }
      ctx.globalAlpha = 1;
      if (found) comicText(ctx, '✓', cx + cell / 2, cy + cell * 0.72, cell * 0.7, '#22c55e');
    }
    ctx.restore();
    if ((img || found) && by) {
      const em = await getEmblem(by);
      const es = Math.max(mini ? 16 : 26, cell * 0.24);
      if (em) ctx.drawImage(em, cx + (mini ? 3 : 6), cy + (mini ? 3 : 6), es, es);
      if (versus) {
        ctx.lineWidth = Math.max(5, cell * 0.05);
        ctx.strokeStyle = emblemById(playersById[by]?.emblem).c1;
        roundRect(ctx, cx + ctx.lineWidth / 2, cy + ctx.lineWidth / 2, cell - ctx.lineWidth, cell - ctx.lineWidth, r - 1); ctx.stroke();
      }
    }
    if (highlight.has(i)) {
      ctx.lineWidth = mini ? 4 : 7; ctx.strokeStyle = YELLOW;
      roundRect(ctx, cx - 2, cy - 2, cell + 4, cell + 4, r + 2); ctx.stroke();
    }
  }
}

/**
 * game: game doc. boards: bingo boards (ignored for versus). thumbs: {photoId: {thumb}}.
 * Returns a PNG Blob.
 */
/** featuredId: whose bingo card gets the big spot (defaults to the winner, else the top score). */
export async function renderRecap({ game, boards = [], thumbs, playersById, featuredId }) {
  await Promise.all([
    document.fonts?.load(`100px ${DISPLAY}`), document.fonts?.load(`900 40px ${BODY}`), document.fonts?.load(`700 30px ${BODY}`),
  ].filter(Boolean)).catch(() => {});

  const isBingo = game.mode === 'bingo';
  const isEndless = game.mode === 'endless';
  // Endless has no board: lay the latest finds (up to 49) out as a grid.
  const finds = isEndless ? (game.history || []).filter(G.isFind).slice(-49) : [];
  const n = isEndless ? Math.min(7, Math.max(2, Math.ceil(Math.sqrt(finds.length || 1)))) : game.size;
  const emblemCache = {};
  const getEmblem = async (pid) => (emblemCache[pid] ??= await emblemImg(playersById[pid]?.emblem));
  const boardCells = (b) => b.items.map((item, i) => ({ item, photo: b.marks?.[i]?.photo, found: !!b.marks?.[i], by: b.playerId }));

  // ── who won, which board to feature, stats per player
  let featured, cells, highlight, winnerId = game.winner;
  let others = []; // bingo: [{ b, s }] for every non-featured board
  const rows = [];
  const plural = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
  if (isBingo) {
    const scored = boards.map((b) => ({ b, s: G.scoreBoard(b) })).sort((a, c) => c.s.points - a.s.points);
    if (!winnerId && game.winRule === 'most' && scored.length) {
      const best = scored[0].s.points;
      const leaders = scored.filter((x) => x.s.points === best);
      winnerId = leaders.length === 1 ? leaders[0].b.playerId : 'draw';
    }
    const top = scored.find((x) => x.b.playerId === featuredId) || scored.find((x) => x.b.playerId === winnerId) || scored[0];
    featured = top?.b;
    highlight = top?.s.lineCells || new Set();
    cells = featured ? boardCells(featured) : [];
    others = scored.filter((x) => x !== top);
    for (const { b, s } of scored) {
      rows.push({
        pid: b.playerId,
        stats: `${plural(s.found, 'find')} · ${plural(s.lines, 'line')}${game.winRule === 'most' ? ` · ${s.points} pts` : ''}${b.rerolls ? ` · ${plural(b.rerolls, 'reroll')}` : ''}`,
      });
    }
  } else if (isEndless) {
    const sc = G.endlessScores(game);
    highlight = new Set();
    cells = finds.map((h) => ({ item: h.item, photo: h.photo, found: true, by: h.by }));
    for (const pid of game.players.slice().sort((a, b) => sc[b].points - sc[a].points)) {
      rows.push({ pid, stats: `${plural(sc[pid].points, 'pt')} · ${plural(sc[pid].finds, 'find')}${game.rerolls?.[pid] ? ` · ${plural(game.rerolls[pid], 'reroll')}` : ''}` });
    }
  } else {
    const counts = G.versusCounts(game);
    highlight = new Set(!game.coop && winnerId && winnerId !== 'draw' ? G.versusWinLine(game, winnerId) || [] : []);
    cells = game.items.map((item, i) => ({ item, photo: game.claims?.[i]?.photo, found: !!game.claims?.[i], by: game.claims?.[i]?.by }));
    for (const pid of game.players.slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0))) {
      const r = game.rerolls?.[pid];
      rows.push({ pid, stats: `${plural(counts[pid] || 0, 'square')} ${game.coop ? 'found' : 'claimed'}${r ? ` · ${plural(r, 'reroll')}` : ''}` });
    }
  }
  const totalPhotos = Object.keys(thumbs).length;

  // ── layout
  const boardW = W - PAD * 2;
  const H_TITLE = 250, H_WIN = 210, H_CAPTION = 70, H_BOARD = boardW + 20, H_ROW = 92;
  const H_SCORES = 70 + rows.length * H_ROW + 20;
  const colGap = 28, colW = (boardW - colGap) / 2, H_MINI_HEAD = 70;
  const H_OTHERS = others.length ? 70 + Math.ceil(others.length / 2) * (H_MINI_HEAD + colW + 36) : 0;
  const H_FOOT = 110;
  const H = H_TITLE + H_WIN + H_CAPTION + H_BOARD + 40 + (H_OTHERS ? H_OTHERS + 10 : 0) + H_SCORES + H_FOOT;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = PAPER; ctx.fillRect(0, 0, W, H);
  halftone(ctx, 0, 0, W, H, 'rgba(239,62,54,0.10)', 18, 2.2);

  // title
  comicText(ctx, 'NYCC PHOTO HUNT', W / 2, 140, 118, RED);
  const date = new Date(game.wonAt || game.createdAt).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const modeLine = isEndless ? `Endless · ${plural(game.history.filter(G.isFind).length, 'find')}` : isBingo
    ? `Solo Series · ${n}×${n} · ${G.WIN_RULES[game.winRule]?.label || ''}`
    : `Crossover · ${n}×${n} · ${game.coop ? 'Co-op blackout' : `${game.connect} in a row`}`;
  ctx.font = `900 34px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'center';
  ctx.fillText(`${modeLine} · ${date}`, W / 2, 200);
  let y = H_TITLE;

  // winner burst panel
  panel(ctx, PAD, y, boardW, H_WIN - 30, YELLOW);
  ctx.save();
  roundRect(ctx, PAD, y, boardW, H_WIN - 30, 22); ctx.clip();
  const bx = PAD + boardW / 2, by = y + (H_WIN - 30) / 2;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  for (let a = 0; a < 24; a += 2) {
    const a0 = (a / 24) * Math.PI * 2, a1 = ((a + 1) / 24) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(bx, by);
    ctx.lineTo(bx + Math.cos(a0) * 900, by + Math.sin(a0) * 900);
    ctx.lineTo(bx + Math.cos(a1) * 900, by + Math.sin(a1) * 900);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ctx.lineWidth = 6; ctx.strokeStyle = INK; roundRect(ctx, PAD, y, boardW, H_WIN - 30, 22); ctx.stroke();
  const winner = winnerId && winnerId !== 'draw' ? playersById[winnerId] : null;
  const headline = winnerId === 'team' ? 'TEAM BLACKOUT!' : winnerId === 'draw' ? "IT'S A TIE!" : winner ? `${firstName(winner).toUpperCase()} WINS!` : 'THE HUNT GOES ON…';
  if (winner) {
    const em = await getEmblem(winnerId);
    if (em) ctx.drawImage(em, PAD + 30, by - 65, 130, 130);
    ctx.font = '72px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🏆', PAD + boardW - 85, by + 4);
    ctx.textBaseline = 'alphabetic';
  }
  comicText(ctx, headline, bx + (winner ? 10 : 0), by + 36, headline.length > 14 ? 88 : 104, RED);
  y += H_WIN;

  // featured board
  ctx.font = `900 34px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'left';
  const caption = isBingo
    ? (featured ? `${firstName(playersById[featured.playerId])}'s ${winnerId === featured.playerId ? 'winning ' : ''}card` : 'The card')
    : isEndless ? (finds.length >= 49 ? 'The last 49 finds' : 'Every find') : game.coop ? 'The team board' : 'The battlefield';
  ctx.fillText(caption.toUpperCase(), PAD, y + 40);
  y += H_CAPTION;
  await drawBoard(ctx, { x: PAD, y, w: boardW, n, cells, highlight, versus: !isBingo, thumbs, getEmblem, playersById });
  y += H_BOARD + 40;

  // everyone else's boards (bingo)
  if (others.length) {
    ctx.font = `900 34px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'left';
    ctx.fillText(others.length === 1 ? 'THE OTHER CARD' : 'THE OTHER CARDS', PAD, y + 40);
    y += 70;
    for (let k = 0; k < others.length; k++) {
      const { b, s } = others[k];
      const lone = others.length % 2 === 1 && k === others.length - 1;
      const x = lone ? PAD + (boardW - colW) / 2 : PAD + (k % 2) * (colW + colGap);
      const yy = y + Math.floor(k / 2) * (H_MINI_HEAD + colW + 36);
      const em = await getEmblem(b.playerId);
      if (em) ctx.drawImage(em, x, yy + 6, 52, 52);
      ctx.font = `900 34px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'left';
      ctx.fillText(wrapLines(ctx, playersById[b.playerId]?.name || 'Someone', colW - 70, 1)[0], x + 64, yy + 34);
      ctx.font = `700 24px ${BODY}`; ctx.fillStyle = '#6b6255';
      ctx.fillText(`${plural(s.found, 'find')} · ${plural(s.lines, 'line')}`, x + 64, yy + 62);
      await drawBoard(ctx, { x, y: yy + H_MINI_HEAD, w: colW, n, cells: boardCells(b), highlight: s.lineCells, thumbs, getEmblem, playersById });
    }
    y += Math.ceil(others.length / 2) * (H_MINI_HEAD + colW + 36) + 10;
  }

  // scoreboard
  panel(ctx, PAD, y, boardW, H_SCORES - 20, '#ffffff');
  ctx.font = `900 34px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'left';
  ctx.fillText('FINAL SCORES', PAD + 28, y + 54);
  let ry = y + 76;
  for (let k = 0; k < rows.length; k++) {
    const { pid, stats } = rows[k];
    const p = playersById[pid];
    const em = await getEmblem(pid);
    ctx.font = `44px ${DISPLAY}`; ctx.fillStyle = k === 0 ? RED : INK; ctx.textAlign = 'left';
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

  // footer
  ctx.font = `900 30px ${BODY}`; ctx.fillStyle = INK; ctx.textAlign = 'center';
  ctx.fillText(`📸 ${plural(totalPhotos, 'photo')} snapped · ${plural(game.players.length, 'hunter')} · Game ${game.code}`, W / 2, H - 58);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}
