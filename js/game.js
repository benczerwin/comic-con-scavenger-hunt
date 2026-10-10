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

/** Up to n distinct random items of the same tier as `item` (for picking a swap). */
export function rerollOptions(item, { exclude = [], pool = ITEMS, n = 3 }) {
  const skip = new Set([...exclude, item.text]);
  return shuffle(pool.filter((it) => it.tier === item.tier && !skip.has(it.text))).slice(0, n).map(strip);
}

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
    if (g.mode === 'endless') {
      for (const h of g.history || []) if (isFind(h)) tally(S(h.by), h.item, h.photo);
      for (const [pid, n] of Object.entries(g.rerolls || {})) S(pid).rerolls += n;
    } else if (g.mode !== 'bingo') {
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

// ── Endless: one challenge at a time, players take turns.
export const ENDLESS_POINTS = { e: 1, m: 2, h: 3 };
/** Endless history also logs items that left the board without being found (rerolled, swapped out, skipped). */
export const isFind = (h) => !h.skipped && !h.rerolled && !h.expired && !h.blocked;
/** An active item is swapped out automatically once this many other items get found while it's up. */
export const ENDLESS_EXPIRE_AFTER = 2;

/** { pid: { points, finds, photos, skips } } for every player in an endless game. */
export function endlessScores(game) {
  const out = Object.fromEntries((game.players || []).map((pid) => [pid, { points: 0, finds: 0, photos: 0, skips: 0 }]));
  for (const h of game.history || []) {
    if (!isFind(h)) { if (h.skipped && out[h.by]) out[h.by].skips++; continue; }
    const s = (out[h.by] ??= { points: 0, finds: 0, photos: 0, skips: 0 });
    s.finds++;
    s.points += ENDLESS_POINTS[h.item?.tier] || 1;
    if (h.photo) s.photos++;
  }
  return out;
}

/** Whose turn comes after pid (turn order = join order). */
export const nextPlayer = (game, pid) => {
  const ps = game.players || [];
  return ps[(ps.indexOf(pid) + 1) % ps.length] || ps[0];
};

/** Random item for an endless turn. tier: 'any' | 'e' | 'm' | 'h'. Avoids repeats until the pool runs dry. */
export function drawEndless(pool, { tier = 'any', exclude = [] }) {
  const fits = pool.filter((it) => tier === 'any' || it.tier === tier);
  const skip = new Set(exclude);
  const fresh = fits.filter((it) => !skip.has(it.text));
  const from = fresh.length ? fresh : fits;
  return from.length ? strip(from[Math.floor(Math.random() * from.length)]) : null;
}

/** Endless games keep 1–3 active slots: { id, item, tier, mix, at } or { id, pick: { by } } (waiting
 *  for someone to choose the next item). Upgrades games made before slots existed (current/pick). */
export function endlessState(g) {
  if (g.active) return { active: g.active, slots: g.slots || g.active.length || 1, turnMode: g.turnMode || 'any', turn: g.turn || null };
  const active = g.current ? [{ id: 's0', item: g.current.item, tier: g.current.tier, mix: g.current.mix, at: g.current.at }]
    : g.pick ? [{ id: 's0', pick: { by: g.pick.by } }] : [];
  return { active, slots: 1, turnMode: 'turns', turn: g.current?.for || g.pick?.for || g.players?.[0] || null };
}

/** Writes slot state back in the current shape and drops the old single-item fields. */
export function withEndlessState(g, st) {
  const out = { ...g, active: st.active, slots: st.slots, turnMode: st.turnMode, turn: st.turn };
  delete out.current; delete out.pick;
  return out;
}
