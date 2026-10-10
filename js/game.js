import { ITEMS, FREE_ITEM } from './data/items.js';

export const SIZES = [3, 4, 5, 6, 7];

export const DIFFICULTY = {
  chill: { label: 'Chill', e: 0.6, m: 0.3, h: 0.1, blurb: 'Mostly easy spots' },
  balanced: { label: 'Balanced', e: 0.45, m: 0.35, h: 0.2, blurb: 'A good mix' },
  hardcore: { label: 'Hardcore', e: 0.25, m: 0.4, h: 0.35, blurb: 'Hunt the rare ones' },
};

export const WIN_RULES = {
  line: { label: 'First line', blurb: 'First full row, column or diagonal wins' },
  blackout: { label: 'Blackout', blurb: 'First to fill the whole board wins' },
  most: { label: 'Most points', blurb: 'Timer runs out → most points wins' },
};

export const backupsFor = (size) => (size <= 4 ? 1 : size === 5 ? 2 : 3);
export const defaultConnect = (size) => (size <= 4 ? size : 4);

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const makeCode = (len = 4) =>
  Array.from({ length: len }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const strip = ({ tier, icon, text, cat }) => ({ tier, icon, text, cat });

/** Rerolls allowed: one per square (per card in bingo, shared on a showdown board). */
export const rerollLimit = (game) => game.size * game.size;
export const totalRerolls = (game) => Object.values(game.rerolls || {}).reduce((a, b) => a + b, 0);

/** A random item of the same tier as `item`, skipping anything in `exclude` (texts). Null if none left. */
export function rerollItem(item, { exclude = [], pool = ITEMS }) {
  const skip = new Set([...exclude, item.text]);
  const options = pool.filter((it) => it.tier === item.tier && !skip.has(it.text));
  return options.length ? strip(options[Math.floor(Math.random() * options.length)]) : null;
}

/** Build a card: n*n squares (center FREE if requested & odd) + backups. */
export function generateCard({ size, difficulty = 'balanced', freeCenter = false, exclude = [], pool = ITEMS }) {
  const mix = DIFFICULTY[difficulty] || DIFFICULTY.balanced;
  const hasFree = freeCenter && size % 2 === 1;
  const total = size * size - (hasFree ? 1 : 0);
  const nBackups = backupsFor(size);

  const skip = new Set(exclude);
  const pools = { e: [], m: [], h: [] };
  for (const it of shuffle(pool)) if (!skip.has(it.text)) pools[it.tier].push(it);

  const want = { h: Math.round(total * mix.h), m: Math.round(total * mix.m) };
  want.e = total - want.h - want.m;

  const picked = [];
  for (const t of ['e', 'm', 'h']) picked.push(...pools[t].splice(0, want[t]));
  // Top up from any tier if a pool ran short.
  const rest = shuffle([...pools.e, ...pools.m, ...pools.h]);
  while (picked.length < total && rest.length) {
    const it = rest.pop();
    pools[it.tier].splice(pools[it.tier].indexOf(it), 1);
    picked.push(it);
  }

  const squares = shuffle(picked).map(strip);
  if (hasFree) squares.splice(Math.floor((size * size) / 2), 0, { ...FREE_ITEM });

  // Backups lean easier so they're actually useful swaps.
  const backupPool = [...shuffle(pools.e), ...shuffle(pools.m), ...shuffle(pools.h)];
  const backups = backupPool.slice(0, nBackups).map(strip);

  return { items: squares, backups };
}

/** Items games draw from: built-ins minus disabled ones, plus custom items. bank = settings/itemBank doc. */
export function buildPool(bank) {
  const off = new Set(bank?.disabled || []);
  return [...ITEMS, ...(bank?.custom || [])].filter((it) => !off.has(it.text));
}

/** Every straight run of length k (rows, cols, both diagonals) in an n×n grid. */
export function allLines(n, k = n) {
  const out = [];
  const dirs = [[0, 1], [1, 0], [1, 1], [1, -1]];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      for (const [dr, dc] of dirs) {
        const er = r + dr * (k - 1), ec = c + dc * (k - 1);
        if (er < 0 || er >= n || ec < 0 || ec >= n) continue;
        out.push(Array.from({ length: k }, (_, i) => (r + dr * i) * n + (c + dc * i)));
      }
    }
  }
  return out;
}

export function completedLines(n, k, isOn) {
  return allLines(n, k).filter((line) => line.every(isOn));
}

/** Score a bingo board. marks: { [idx]: {...} } */
export function scoreBoard(board) {
  const n = board.size;
  const isOn = (i) => board.items[i]?.tier === 'free' || !!board.marks?.[i];
  const lines = completedLines(n, n, isOn);
  const found = Object.keys(board.marks || {}).length;
  const blackout = board.items.every((_, i) => isOn(i));
  const lineCells = new Set(lines.flat());
  return {
    found,
    lines: lines.length,
    blackout,
    lineCells,
    points: found + lines.length * 3 + (blackout ? 10 : 0),
  };
}

/** Versus: does player pid have a run of `connect` claimed squares? */
export function versusWinLine(game, pid) {
  const isMine = (i) => game.claims?.[i]?.by === pid;
  return completedLines(game.size, game.connect, isMine)[0] || null;
}

export function versusCounts(game) {
  const counts = {};
  for (const c of Object.values(game.claims || {})) counts[c.by] = (counts[c.by] || 0) + 1;
  return counts;
}

export const fmtDuration = (ms) => {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};

/** Lifetime stats per player across every game. games: all game docs; boards: all bingo boards. */
export function playerStats(games, boards) {
  const byCode = Object.fromEntries(games.map((g) => [g.code, g]));
  const stats = {};
  const S = (pid) => (stats[pid] ??= {
    games: 0, finished: 0, wins: 0, teamWins: 0, found: 0, photos: 0, lines: 0, blackouts: 0, rerolls: 0,
    tiers: { e: 0, m: 0, h: 0 }, cats: {}, recent: [],
  });
  const tally = (s, item, photo) => {
    if (!item || item.tier === 'free') return;
    s.found++;
    if (photo) s.photos++;
    if (s.tiers[item.tier] !== undefined) s.tiers[item.tier]++;
    s.cats[item.cat] = (s.cats[item.cat] || 0) + 1;
  };

  for (const g of games) {
    for (const pid of g.players || []) {
      const s = S(pid);
      s.games++;
      if (g.winner) s.finished++;
      if (g.winner === pid) s.wins++;
      if (g.winner === 'team') s.teamWins++;
      s.recent.push(g);
    }
    if (g.mode !== 'bingo') {
      for (const [i, c] of Object.entries(g.claims || {})) tally(S(c.by), g.items?.[i], c.photo);
      for (const [pid, n] of Object.entries(g.rerolls || {})) S(pid).rerolls += n;
    }
  }
  for (const b of boards) {
    if (!byCode[b.gameId]) continue; // board of a deleted game
    const s = S(b.playerId);
    for (const [i, m] of Object.entries(b.marks || {})) tally(s, b.items?.[i], m.photo);
    const sc = scoreBoard(b);
    s.lines += sc.lines;
    if (sc.blackout) s.blackouts++;
    s.rerolls += b.rerolls || 0;
  }
  for (const s of Object.values(stats)) {
    s.recent.sort((a, b) => b.createdAt - a.createdAt);
    s.topCat = Object.entries(s.cats).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  }
  return stats;
}
