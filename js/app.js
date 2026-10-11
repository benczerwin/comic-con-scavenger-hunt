import { html, render, useState, useEffect, useMemo, useRef, createContext, useContext } from '../vendor/htm-preact.js';
import * as store from './store.js';
import { EMBLEMS, emblemById, emblemSVG } from './data/emblems.js';
import { CATEGORY_LABELS, ITEMS, itemKind, catLabel, normalizeItem } from './data/items.js';
import * as G from './game.js';
import { iconMarkup, iconSVG, itemIconName, PICKABLE_ICONS } from './icons.js';
import { processPhoto } from './photo.js';
import { renderRecap, renderCollage } from './recap.js';

// ───────────────────────── helpers & hooks ─────────────────────────

const ME_KEY = 'nycc-hunt:me';
const loadMe = () => { try { return localStorage.getItem(ME_KEY); } catch { return null; } };
const saveMe = (id) => { try { localStorage.setItem(ME_KEY, id); } catch {} };

const go = (path) => { location.hash = path; };
const gameUrl = (code) => `${location.origin}${location.pathname}#/g/${code}`;

// Where you came from, so a game opened from another screen (e.g. a player's stats) can go back there,
// landing at the same scroll spot.
let lastHash = location.hash, prevHash = '', restoreNext = false;
const scrollSpots = {};
const goBack = (hash) => { restoreNext = true; location.hash = hash; };

function useHash() {
  const parse = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => {
      scrollSpots[lastHash] = window.scrollY;
      prevHash = lastHash; lastHash = location.hash;
      const y = restoreNext ? scrollSpots[location.hash] || 0 : 0;
      restoreNext = false;
      setRoute(parse());
      window.scrollTo(0, y);
      if (y) [60, 300].forEach((t) => setTimeout(() => window.scrollTo(0, y), t)); // after data fills the page
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** Subscribe to a store watcher; returns undefined until the first result. */
function useWatch(subscribe, deps) {
  const [val, setVal] = useState(undefined);
  useEffect(() => { setVal(undefined); return subscribe(setVal); }, deps);
  return val;
}

function useNow(active) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

let pushToast = () => {};
/** A flat line icon from icons.js, sized to the text around it unless size is given. */
const Ico = ({ n, size }) => html`<svg class="ico" viewBox="0 0 24 24" style=${size ? `width:${size}px;height:${size}px` : undefined} fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" dangerouslySetInnerHTML=${{ __html: iconMarkup(n) }} />`;
const ic = (n, size) => html`<${Ico} n=${n} size=${size} />`;
/** An item's picture: its flat icon (an older custom item with an emoji we can't match gets the camera). */
const itemIcon = (icon) => ic(itemIconName(icon) || 'camera');

const toast = (msg, kind = 'info') => pushToast({ msg, kind, id: Math.random() });

// Anything that fails without its own error handling still tells the player, instead of looking like a dead tap.
const friendlyError = (e) => {
  const m = String(e?.message || e || '');
  if (/offline|unavailable|network|failed to fetch/i.test(m)) return 'No connection right now. Try again.';
  return m.length < 120 && m ? m : 'Something went wrong. Try again.';
};
addEventListener('unhandledrejection', (e) => toast(friendlyError(e.reason), 'error'));

/** "Saving…" pill while a save takes longer than half a second. */
function SyncIndicator() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    let t;
    const off = store.onPending((n) => {
      clearTimeout(t);
      if (n > 0) t = setTimeout(() => setShow(true), 500);
      else setShow(false);
    });
    return () => { off(); clearTimeout(t); };
  }, []);
  return show ? html`<div class="sync-pill"><span class="spinner tiny"></span>Saving…</div>` : null;
}

/** After a save times out: one tap reloads the page, which always clears a stuck connection. */
function StuckBanner() {
  const [show, setShow] = useState(false);
  useEffect(() => store.onStuck(() => setShow(true)), []);
  if (!show) return null;
  return html`<div class="stuck-banner" role="alert">
    <span>Connection got stuck. Reloading fixes it.</span>
    <button class="btn small primary" onClick=${() => location.reload()}>Reload</button>
    <button class="x" aria-label="Dismiss" onClick=${() => setShow(false)}>×</button>
  </div>`;
}

function Toasts() {
  const [items, setItems] = useState([]);
  pushToast = (t) => {
    setItems((xs) => [...xs, t]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3200);
  };
  return html`<div class="toasts">${items.map((t) => html`<div class="toast ${t.kind}" key=${t.id}>${t.kind === 'good' ? ic('check') : t.kind === 'error' ? ic('alert') : ''} ${t.msg}</div>`)}</div>`;
}

const svgCache = {};
function Emblem({ id, size = 40, ring }) {
  const svg = (svgCache[id] ??= emblemSVG(id));
  return html`<span class="emblem" style=${`width:${size}px;height:${size}px;${ring ? `--ring:${emblemById(id).c1}` : ''}`}
    data-ring=${ring ? '1' : null} dangerouslySetInnerHTML=${{ __html: svg }} />`;
}

const playerColor = (p) => emblemById(p?.emblem).c1;
const firstName = (p) => (p?.name || 'Someone').split(' ')[0];

// ───────────────────────── game creation ─────────────────────────

// Current item pool (built-ins minus disabled + custom). Kept in sync with settings/itemBank by <App>.
let itemPool = ITEMS;
/** The items a game draws from: everything on, or only characters/shows/movies. */
// Modes are stored as 'bingo' / 'versus' / 'endless' but shown as Solo Series (own boards) /
// Crossover (one shared board) / Endless (one item at a time, taking turns).
const modeTag = (g) => (g.mode === 'bingo' ? 'SOLO' : g.mode === 'endless' ? 'ENDLESS' : g.coop ? 'CO-OP' : 'X-OVER');

// What a game draws from: g.cats = the categories picked (all when unset) and g.tiers = the star levels.
// Older games stored a "mix" (all / char / obj) instead of categories; those still work.
const ALL_CATS = Object.keys(CATEGORY_LABELS);
const legacyMix = (g) => g.mix || (g.charsOnly ? 'char' : 'all');
const poolFor = (g) => {
  const cats = g.cats?.length ? new Set(g.cats) : null;
  const m = legacyMix(g);
  const tiers = g.tiers?.length ? new Set(g.tiers) : null;
  // it.group lets older games that picked the previous categories keep working
  return itemPool.filter((it) => (cats ? cats.has(it.cat) || cats.has(it.group) : m === 'all' || itemKind(it) === m)
    && (!tiers || tiers.has(it.tier)) && (!g.mineOnly || isMine(it)));
};
const someCats = (cats) => (cats?.length && cats.length < ALL_CATS.length ? cats : undefined); // store only a real subset
const ALL_TIERS = ['e', 'm', 'h'];
const backupCount = (g) => g.backupCount ?? G.backupsFor(g.size);
// Difficulty only means something when more than one star level is in play.
// Star display is a per-device preference.
let hideStars = (() => { try { return localStorage.getItem('nycc-hide-stars') === '1'; } catch { return false; } })();
const setHideStars = (on) => {
  hideStars = on;
  try { localStorage.setItem('nycc-hide-stars', on ? '1' : ''); } catch {}
  dispatchEvent(new Event('nycc:prefs'));
};

const diffTag = (g) => (hideStars || g.tiers?.length === 1 ? '' : ` · ${G.DIFFICULTY[g.difficulty]?.label}`);
const tiersTag = (g) => (!hideStars && g.tiers?.length && g.tiers.length < 3 ? ` · ${g.tiers.map((t) => TIER_STARS[t]).join(' ')} only` : '');
const catsLabel = (cats) => (cats.length <= 2 ? cats.map((c) => catLabel(c)).join(' + ') : `${cats.length} categories`);
const mixTag = (g) => (g.mineOnly ? ' · My list' : '') + (someCats(g.cats) ? ` · ${catsLabel(g.cats)}`
  : !g.cats && legacyMix(g) !== 'all' ? ` · ${legacyMix(g) === 'char' ? 'Characters' : 'Fandom gear'}` : '');
const BANK_ID = 'itemBank';
/** Turns an item off in the shared item list so no new board, backup or reroll uses it. */
function blockItem(text) {
  return store.transact('settings', BANK_ID, (b) => ({
    ...(b || {}), custom: b?.custom || [], disabled: [...new Set([...(b?.disabled || []), text])], updatedAt: Date.now(),
  })).then(() => toast(`Blocked "${text}". Turn it back on in Edit hunt items.`)).catch((e) => toast(`Couldn't block: ${e.message}`, 'error'));
}

async function uniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = G.makeCode();
    if (!(await store.getOne('games', code))) return code;
  }
  return G.makeCode(5);
}

function makeBoard(game, pid) {
  const card = game.card || G.generateCard({ size: game.size, difficulty: game.difficulty, freeCenter: game.freeCenter, pool: poolFor(game), backups: backupCount(game) });
  return {
    gameId: game.code, playerId: pid, size: game.size,
    items: card.items, backups: card.backups, marks: {}, createdAt: Date.now(),
  };
}

const HAND_SIZE = 9; // default; each empty-board game can pick its own
const handSize = (g) => g.handSize || HAND_SIZE;
/** Items already in play in an empty-board game (on the board, in any hand, or waiting to be placed). */
const placeUsed = (g) => [
  ...(g.items || []).filter(Boolean), ...Object.values(g.hands || {}).flat(), ...Object.values(g.pending || {}).map((p) => p.item),
].map((it) => it.text);
/** n fresh random items for a hand, honoring the game's categories and stars. */
function drawHand(g, n, extraExclude = []) {
  const skip = new Set([...placeUsed(g), ...extraExclude]);
  const pool = poolFor(g).filter((it) => !skip.has(it.text));
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  return out.map(({ tier, icon, text, cat }) => ({ tier, icon, text, cat }));
}

function versusBackups(game) {
  return G.generateCard({ size: game.size, difficulty: game.difficulty, exclude: game.items.map((i) => i.text), pool: poolFor(game), backups: backupCount(game) }).backups;
}

/** End a game early. Co-op just stops; otherwise whoever's ahead wins (points in Endless and timed Solo, else most found). */
async function endGameEarly(game) {
  if (!confirm(game.coop ? 'End the game now?' : 'End the game now? Whoever is ahead wins.')) return;
  let bingoScores = null;
  if (game.mode === 'bingo') {
    const boards = await store.getWhere('boards', 'gameId', '==', game.code);
    bingoScores = Object.fromEntries(boards.map((b) => {
      const s = G.scoreBoard(b);
      return [b.playerId, game.winRule === 'most' ? s.points : s.found];
    }));
  }
  const res = await store.transact('games', game.code, (g) => {
    if (!g || g.winner) return undefined;
    if (g.coop) g.winner = 'ended';
    else {
      let sc = bingoScores;
      if (g.mode === 'endless') sc = Object.fromEntries(Object.entries(G.endlessScores(g)).map(([k, v]) => [k, v.points]));
      else if (!sc) {
        sc = Object.fromEntries(g.players.map((pid) => [pid, 0]));
        for (const c of Object.values(g.claims || {})) if (c?.by && c.by in sc) sc[c.by]++;
      }
      const best = Math.max(0, ...Object.values(sc));
      const leaders = Object.keys(sc).filter((k) => sc[k] === best);
      g.winner = leaders.length === 1 ? leaders[0] : 'draw';
    }
    g.endedEarly = true;
    g.wonAt = Date.now();
    return g;
  });
  if (res && !res.ok) toast("Couldn't end the game. Try again.", 'error');
}

async function createGame(settings, createdBy) {
  const code = await uniqueCode();
  const base = {
    code, mode: settings.mode, size: settings.size, difficulty: settings.difficulty,
    players: settings.players, ...(someCats(settings.cats) ? { cats: settings.cats } : {}), ...(settings.mineOnly ? { mineOnly: true } : {}),
    ...(!settings.cats && settings.mix && settings.mix !== 'all' ? { mix: settings.mix } : {}), // rematch of an older game
    ...(settings.tiers?.length && settings.tiers.length < 3 ? { tiers: settings.tiers } : {}),
    ...(settings.backupCount !== undefined && settings.mode !== 'endless' ? { backupCount: settings.backupCount } : {}),
    ...(settings.noSwaps ? { noSwaps: true } : {}), ...(settings.rerollLimit ? { rerollLimit: settings.rerollLimit } : {}), createdBy, createdAt: Date.now(), winner: null,
  };
  const fail = (e) => toast(`Sync problem: ${e.message}`, 'error');
  if (settings.mode === 'endless') {
    const tier = settings.tier || 'any';
    const slots = settings.slots || 1;
    const active = [];
    for (let k = 0; k < slots; k++) {
      const item = G.drawEndless(poolFor(settings), { tier, exclude: active.map((a) => a.item.text) });
      if (!item) throw new Error('No items turned on in those categories.');
      active.push({ id: G.uid(), item, tier, cats: base.cats || null, at: Date.now() });
    }
    const turnMode = settings.turnMode || 'any';
    const game = {
      ...base, size: null, history: [], rerolls: {}, lastPick: { tier, cats: base.cats || null },
      active, slots, turnMode, turn: turnMode === 'turns' ? settings.players[0] : null,
    };
    store.put('games', code, game).catch(fail);
    return code;
  }
  if (settings.mode === 'bingo') {
    const game = {
      ...base,
      winRule: settings.winRule,
      minutes: settings.minutes,
      endsAt: settings.winRule === 'most' ? Date.now() + settings.minutes * 60_000 : null,
      freeCenter: settings.freeCenter,
      sameCard: settings.sameCard,
      card: settings.sameCard
        ? G.generateCard({ size: settings.size, difficulty: settings.difficulty, freeCenter: settings.freeCenter, pool: poolFor(settings), backups: backupCount(settings) })
        : null,
    };
    store.put('games', code, game).catch(fail);
    for (const pid of game.players) store.put('boards', `${code}_${pid}`, makeBoard(game, pid)).catch(fail);
  } else if (settings.place) {
    // Empty board: everyone gets a hand of items; snap one, then place it on any empty square.
    const game = { ...base, coop: !!settings.coop, connect: settings.connect, place: true, handSize: settings.handSize || HAND_SIZE,
      items: Array(settings.size * settings.size).fill(null), claims: {}, hands: {}, pending: {} };
    for (const pid of game.players) game.hands[pid] = drawHand(game, handSize(game));
    store.put('games', code, game).catch(fail);
  } else {
    const card = G.generateCard({ size: settings.size, difficulty: settings.difficulty, pool: poolFor(settings), backups: backupCount(settings) });
    const game = { ...base, coop: !!settings.coop, connect: settings.connect, items: card.items, claims: {}, backups: {} };
    for (const pid of game.players) game.backups[pid] = versusBackups(game);
    store.put('games', code, game).catch(fail);
  }
  return code;
}

/** Deletes a game plus its boards and photos. */
async function deleteGame(code) {
  const [boards, thumbs] = await Promise.all([
    store.getWhere('boards', 'gameId', '==', code),
    store.getWhere('thumbs', 'gameId', '==', code),
  ]);
  await store.remove('games', code);
  await Promise.all([
    ...boards.map((b) => store.remove('boards', b.id)),
    ...thumbs.flatMap((t) => [store.remove('thumbs', t.id), store.remove('photos', t.id)]),
  ]);
}

async function confirmDelete(code) {
  if (!confirm(`Delete game ${code} and all its photos for everyone? This can't be undone.`)) return false;
  try {
    await deleteGame(code);
    toast(`Deleted game ${code}`);
    return true;
  } catch (e) {
    toast(`Couldn't delete: ${e.message}`, 'error');
    return false;
  }
}

const settingsFrom = (g) => ({
  handSize: g.handSize, mineOnly: !!g.mineOnly,
  mode: g.mode, size: g.size, difficulty: g.difficulty, players: g.players,
  winRule: g.winRule, minutes: g.minutes || 60, freeCenter: g.freeCenter, sameCard: g.sameCard, connect: g.connect, coop: !!g.coop, cats: g.cats, mix: g.cats ? undefined : g.mix, tier: g.lastPick?.tier, tiers: g.tiers,
  backupCount: g.mode === 'endless' ? undefined : backupCount(g), noSwaps: !!g.noSwaps, rerollLimit: g.rerollLimit, place: !!g.place,
  slots: g.mode === 'endless' ? G.endlessState(g).slots : undefined, turnMode: g.mode === 'endless' ? G.endlessState(g).turnMode : undefined,
});

// ───────────────────────── screens ─────────────────────────

function ProfileScreen({ players, me, onPick, onSwitch }) {
  const [name, setName] = useState(me?.name || '');
  const [emblem, setEmblem] = useState(me?.emblem || EMBLEMS[Math.floor(Math.random() * EMBLEMS.length)].id);
  const others = (players || []).filter((p) => p.id !== me?.id);
  const taken = new Set(others.map((p) => p.emblem));
  const [sheet, setSheet] = useState(false);

  const save = () => {
    const n = name.trim();
    if (!n) return toast('Give yourself a hero name!', 'error');
    const id = me?.id || G.uid();
    store.put('players', id, { name: n.slice(0, 24), emblem, createdAt: me?.createdAt || Date.now() })
      .catch((e) => toast(`Sync problem: ${e.message}`, 'error'));
    onPick(id);
  };

  const removePlayer = async (p) => {
    const mine = p.id === me?.id;
    if (!confirm(`Remove ${mine ? 'yourself' : p.name}? Their past games stay, but they'll show as "Someone".`)) return;
    try {
      await store.remove('players', p.id);
      toast(`Removed ${p.name}`);
      if (mine) onSwitch();
    } catch (e) { toast(`Couldn't remove: ${e.message}`, 'error'); }
  };

  return html`
    <main class="screen">
      ${(me || players?.length > 0) && html`<nav class="topbar">
        ${me ? html`<a class="back" href="#/">‹ Home</a>` : html`<span></span>`}
        ${players?.length > 0 && html`<button class="round-btn small" onClick=${() => setSheet(true)} aria-label="All players" title="All players">${PEOPLE_ICON}</button>`}
      </nav>`}
      <h1 class="title">${me ? 'Edit your hero' : 'Who goes there?'}</h1>
      ${!me && others.length > 0 && html`
        <section class="panel">
          <h2>Already made a player? Tap yourself</h2>
          <div class="player-pick">
            ${others.map((p) => html`
              <button class="chip big" onClick=${() => onPick(p.id)}>
                <${Emblem} id=${p.emblem} size=${36} /> ${p.name}
              </button>`)}
          </div>
        </section>`}
      <section class="panel">
        <h2>${me ? 'Your name' : 'New player'}</h2>
        <input class="text" placeholder="Hero name (e.g. Ben)" value=${name} maxlength="24"
          onInput=${(e) => setName(e.target.value)} />
        <h2>Pick your emblem</h2>
        <div class="emblem-grid">
          ${EMBLEMS.map((e) => html`
            <button class="emblem-opt ${emblem === e.id ? 'sel' : ''}" onClick=${() => setEmblem(e.id)} title=${e.name}>
              <${Emblem} id=${e.id} size=${54} />
              <span>${e.name}</span>
              ${taken.has(e.id) && html`<i class="taken">taken</i>`}
            </button>`)}
        </div>
        <div class="row end">
          ${me && html`<button class="btn ghost" onClick=${() => go('/')}>Cancel</button>`}
          <button class="btn primary" onClick=${save}>${me ? 'Save' : "Let's hunt!"}</button>
        </div>
      </section>
      ${sheet && html`<${PlayersSheet} players=${players} me=${me} onRemove=${removePlayer}
        onSwitch=${() => { setSheet(false); onSwitch(); }} onClose=${() => setSheet(false)} />`}
    </main>`;
}

function PlayersSheet({ players, me, onRemove, onSwitch, onClose }) {
  useScrollLock();
  const sheet = useSwipeDown(onClose);
  return html`
    <div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" ref=${sheet}>
        <button class="x" onClick=${onClose} aria-label="Close">×</button>
        <h2 class="recap-title">All players</h2>
        <div class="players-list">
          ${(players || []).map((p) => html`
            <div class="item-row" key=${p.id}>
              <${Emblem} id=${p.emblem} size=${34} />
              <span class="grow">${p.name}${p.id === me?.id ? ' (you)' : ''}</span>
              <button class="icon-btn round" aria-label="Remove ${p.name}" onClick=${() => onRemove(p)}>${TRASH_SVG}</button>
            </div>`)}
        </div>
        ${me && html`<button class="btn ghost" onClick=${onSwitch}>Switch player on this phone</button>`}
      </div>
    </div>`;
}

function Home({ me, playersById }) {
  const games = useWatch((cb) => store.watchWhere('games', 'players', 'array-contains', me.id, cb), [me.id]);
  const [joinOpen, setJoinOpen] = useState(false);
  const sorted = (games || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  // Filters stick between visits (per device). A saved date or player that no longer has games falls back to all.
  const [daysSaved, setDays] = usePrefList('nycc-home:days');
  const [whoSaved, setWho] = usePrefList('nycc-home:players');
  const [status, setStatus] = usePref('nycc-home:status', 'all');
  const { recap, makeRecap, closeRecap } = useRecap(playersById);
  const dayKey = (t) => new Date(t).toDateString();
  const days = [...new Set(sorted.map((g) => dayKey(g.createdAt)))];
  const people = [...new Set(sorted.flatMap((g) => g.players))].filter((pid) => playersById[pid]);
  const pickedDays = games ? daysSaved.filter((d) => days.includes(d)) : daysSaved;
  const who = games ? whoSaved.filter((pid) => people.includes(pid)) : whoSaved;
  const shown = sorted.filter((g) => (!pickedDays.length || pickedDays.includes(dayKey(g.createdAt))) && (!who.length || who.some((pid) => g.players.includes(pid)))
    && (status === 'all' || (status === 'done') === isDone(g)));


  return html`
    <main class="screen">
      <header class="hero">
        <div class="logo">NYCC<span>Photo Hunt</span></div>
        <div class="hero-actions">
          <a class="round-btn" href="#/stats" aria-label="Player stats" title="Player stats">${STATS_ICON}</a>
          <a class="round-btn" href="#/settings" aria-label="Settings" title="Settings">${GEAR_ICON}</a>
          <button class="round-btn me-btn" onClick=${() => go('/profile')} title=${`${me.name}: edit profile`} aria-label=${`${me.name}: edit profile`}>
            <${Emblem} id=${me.emblem} size=${30} />
          </button>
        </div>
      </header>
      ${!store.isLive && html`<div class="banner warn">
        <b>Demo mode:</b> games only sync on this device. Add your Firebase config to play together live.</div>`}

      <section class="modes">
        <a class="mode-card bingo" href="#/new/bingo">
          <h2>Solo Series</h2>
          <p>Everyone gets their own board. Snap photos, complete lines, win.</p>
        </a>
        <a class="mode-card versus" href="#/new/versus">
          <h2>Crossover</h2>
          <p>Everyone on one shared board. Race to claim squares, or team up to fill it.</p>
        </a>
        <a class="mode-card endless" href="#/new/endless">
          <h2>Endless</h2>
          <p>One item at a time. Take turns, reroll if you're stuck, and pick what your friend hunts next.</p>
        </a>
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>Your games</h2>
          <div class="hero-actions">
            <button class="round-btn small" onClick=${() => setJoinOpen(true)} aria-label="Join a game" title="Join a game">${JOIN_ICON}</button>
            <a class="round-btn small" href="#/collage" aria-label="Make a collage" title="Make a collage">${COLLAGE_ICON}</a>
          </div>
        </div>
        ${games === undefined && html`<p class="muted">Loading…</p>`}
        ${games && !sorted.length && html`<p class="muted">No games yet. Start one above!</p>`}
        ${sorted.length > 1 && html`<div class="row game-filters">
          <${DateMulti} days=${days} value=${pickedDays} onChange=${setDays} />
          <${PlayerMulti} people=${people} value=${who} onChange=${setWho} me=${me} playersById=${playersById} />
        </div>`}
        ${sorted.length > 1 && html`<div class="filter-row status-filter">
          ${[['all', 'All games'], ['live', 'In progress'], ['done', 'Done']].map(([k, l]) => html`
            <button class="pill ${status === k ? 'sel' : ''}" onClick=${() => setStatus(k)}>${l}
              <small>${k === 'all' ? sorted.length : sorted.filter((g) => (k === 'done') === isDone(g)).length}</small></button>`)}
        </div>`}
        <div class="game-list">
          ${shown.map((g) => html`<${GameRow} key=${g.code} g=${g} playersById=${playersById} href=${`#/g/${g.code}`}
            onDelete=${() => confirmDelete(g.code)} onEnd=${() => endGameEarly(g)} onRecap=${() => makeRecap(g)} />`)}
        </div>
        ${sorted.length > 0 && !shown.length && html`<p class="muted center">No games match.</p>`}
      </section>
      ${joinOpen && html`<${JoinSheet} onClose=${() => setJoinOpen(false)} />`}
      ${recap && html`<${RecapModal} recap=${recap} code=${recap.game.code} playersById=${playersById}
        onFeature=${(id) => makeRecap(recap.game, id)} onClose=${closeRecap} />`}
    </main>`;
}

/** Enter a friend's game code. */
function JoinSheet({ onClose }) {
  useScrollLock();
  const sheet = useSwipeDown(onClose);
  const [code, setCode] = useState('');
  const join = (e) => {
    e.preventDefault();
    const c = code.trim().toUpperCase().replace(/^NYCC-?/, '');
    if (c) { onClose(); go(`/g/${c}`); }
  };
  return html`
    <div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <form class="modal" ref=${sheet} onSubmit=${join}>
        <button type="button" class="x" onClick=${onClose} aria-label="Close">×</button>
        <h2 class="recap-title">Join a game</h2>
        <p class="muted">Type the code your friend shared.</p>
        <div class="row">
          <input class="text code" placeholder="CODE" value=${code} maxlength="10" autofocus
            onInput=${(e) => setCode(e.target.value.toUpperCase())} />
          <button class="btn primary" disabled=${!code.trim()}>Join</button>
        </div>
      </form>
    </div>`;
}

/** Pick any number of days (none picked = all dates). value: array of Date.toDateString() keys. */
function DateMulti({ days, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const picked = value.filter((d) => days.includes(d));
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const toggle = (d) => onChange(picked.includes(d) ? picked.filter((x) => x !== d) : days.filter((x) => x === d || picked.includes(x)));
  // Group days by year (con year) so a whole year can be picked at once.
  const years = [...new Set(days.map((d) => new Date(d).getFullYear()))];
  const daysOf = (y) => days.filter((d) => new Date(d).getFullYear() === y);
  const yearOn = (y) => daysOf(y).every((d) => picked.includes(d));
  const toggleYear = (y) => {
    const ds = daysOf(y);
    onChange(yearOn(y) ? picked.filter((d) => !ds.includes(d)) : days.filter((d) => ds.includes(d) || picked.includes(d)));
  };
  const fullYears = years.filter(yearOn);
  const label = !picked.length ? 'All dates'
    : fullYears.length && fullYears.reduce((n, y) => n + daysOf(y).length, 0) === picked.length ? fullYears.map((y) => `All of ${y}`).join(' + ')
    : picked.length === 1 ? dayLabel(picked[0]) : `${picked.length} dates`;
  return html`<div class="multi-select" ref=${ref}>
    <button type="button" class=${'text small-select multi-btn' + (picked.length ? ' active' : '')} aria-expanded=${open} onClick=${() => setOpen(!open)}>${label}</button>
    ${open && html`<div class="multi-pop" role="listbox" aria-multiselectable="true">
      <label class="multi-opt"><input type="checkbox" checked=${!picked.length} onChange=${() => onChange([])} /> All dates</label>
      ${years.map((y) => html`<div class="multi-year" key=${y}>
        <label class="multi-opt year"><input type="checkbox" checked=${yearOn(y)} onChange=${() => toggleYear(y)} /> All of ${y}</label>
        ${daysOf(y).map((d) => html`<label class="multi-opt day" key=${d}><input type="checkbox" checked=${picked.includes(d)} onChange=${() => toggle(d)} /> ${dayLabel(d)}</label>`)}
      </div>`)}
    </div>`}
  </div>`;
}

/** Single-choice dropdown in the same style as the filter dropdowns (the native picker looks out of place). */
function SingleSelect({ options, value, onChange, placeholder, label, active }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const cur = options.find((o) => o.value === value);
  return html`<div class="multi-select" ref=${ref}>
    <button type="button" class=${'text small-select multi-btn' + (active ? ' active' : '')} aria-expanded=${open} aria-label=${label} onClick=${() => setOpen(!open)}>
      ${cur?.value ? cur.label : placeholder}</button>
    ${open && html`<div class="multi-pop" role="listbox">
      ${options.map((o) => html`<button type="button" role="option" aria-selected=${o.value === value} key=${o.value}
        class=${'multi-opt single' + (o.value === value ? ' sel' : '')} onClick=${() => { setOpen(false); onChange(o.value); }}>
        <span class="tick">${o.value === value ? ic('check') : ''}</span>${o.label}</button>`)}
    </div>`}
  </div>`;
}

/** Generic multi-choice dropdown (none picked = all). options: [{ value, label, pre? }]. */
function MultiSelect({ options, value, onChange, allLabel, label, noun }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const values = options.map((o) => o.value);
  const picked = value.filter((v) => values.includes(v));
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const toggle = (v) => onChange(picked.includes(v) ? picked.filter((x) => x !== v) : values.filter((x) => x === v || picked.includes(x)));
  const lab = (v) => options.find((o) => o.value === v)?.label;
  const text = !picked.length ? allLabel : picked.length <= 2 ? picked.map(lab).join(' + ') : `${picked.length} ${noun || 'picked'}`;
  return html`<div class="multi-select" ref=${ref}>
    <button type="button" class=${'text small-select multi-btn' + (picked.length ? ' active' : '')} aria-expanded=${open} aria-label=${label}
      onClick=${() => setOpen(!open)}>${text}</button>
    ${open && html`<div class="multi-pop" role="listbox" aria-multiselectable="true">
      <label class="multi-opt"><input type="checkbox" checked=${!picked.length} onChange=${() => onChange([])} /> ${allLabel}</label>
      ${options.map((o) => html`<label class="multi-opt" key=${o.value}><input type="checkbox" checked=${picked.includes(o.value)} onChange=${() => toggle(o.value)} />
        ${o.pre || ''}${o.label}</label>`)}
    </div>`}
  </div>`;
}

/** Pick any number of players (none picked = everyone). value: array of player ids. */
function PlayerMulti({ people, value, onChange, me, playersById }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const picked = value.filter((pid) => people.includes(pid));
  useEffect(() => {
    if (!open) return;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  const nm = (pid) => (pid === me.id ? 'Me' : playersById[pid]?.name || 'Someone');
  const toggle = (pid) => onChange(picked.includes(pid) ? picked.filter((x) => x !== pid) : people.filter((x) => x === pid || picked.includes(x)));
  const label = !picked.length ? 'Everyone' : picked.length <= 2 ? picked.map(nm).join(' + ') : `${picked.length} players`;
  return html`<div class="multi-select" ref=${ref}>
    <button type="button" class=${'text small-select multi-btn' + (picked.length ? ' active' : '')} aria-expanded=${open} aria-label="Filter by player"
      onClick=${() => setOpen(!open)}>${label}</button>
    ${open && html`<div class="multi-pop right" role="listbox" aria-multiselectable="true">
      <label class="multi-opt"><input type="checkbox" checked=${!picked.length} onChange=${() => onChange([])} /> Everyone</label>
      ${people.map((pid) => html`<label class="multi-opt" key=${pid}><input type="checkbox" checked=${picked.includes(pid)} onChange=${() => toggle(pid)} />
        <${Emblem} id=${playersById[pid]?.emblem} size=${20} /> ${nm(pid)}</label>`)}
    </div>`}
  </div>`;
}

const dayLabel = (key) => {
  const d = new Date(key), today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (key === today.toDateString()) return 'Today';
  if (key === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
};

function HowToPlay() {
  return html`<ul class="how-list">
    <li><b>Solo Series:</b> everyone gets their own board. Tap a square, take a photo, and it's marked. Pick a win rule when you start.</li>
    <li><b>Crossover:</b> everyone shares one board. Snap a square first to claim it with your emblem and get N in a row to win. Or pick <b>Co-op</b> and black out the board together.</li>
    <li><b>Empty board</b> (Crossover option): the board starts blank and everyone gets a hand of items (9 by default). Snap one, place it on any empty square, and you get a whole new hand. Pick your spots to block or build a line.</li>
    <li><b>Endless:</b> 1–5 items are up at a time. Snap one to score (★ = 1 pt, ★★ = 2, ★★★ = 3), then pick the difficulty and type of the next item. An item that sits while 2 others get found swaps itself out.</li>
    <li><b>Backups:</b> in Solo Series and Crossover you get 1–3 backup items. Tap a backup, then tap an unmarked square to swap it in.</li>
    <li><b>${ic('dice')} Reroll:</b> swap an item you haven't found for a random one with the same stars. Rerolls are counted in the stats.</li>
    <li><b>${ic('ban')} Block:</b> never want to see an item again? Block it. It's swapped out and turned off in Edit hunt items.</li>
    <li><b>Stars:</b> ★ items are everywhere, ★★★ items are rare finds.</li>
    <li><b>Friends:</b> share the game code or link. Anyone can join mid-game.</li>
  </ul>`;
}

function SettingsScreen({ me }) {
  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/">‹ Home</a></nav>
      <h1 class="title">Settings</h1>
      <a class="panel items-link" href="#/items">
        <span class="icon">${ic('list', 26)}</span>
        <span class="grow"><b>Edit hunt items</b><small>${itemPool.length} items on · Turn ideas off or add your own</small></span>
        <span>›</span>
      </a>
      <section class="panel">
        <label class="toggle"><input type="checkbox" checked=${!hideStars} onChange=${(e) => setHideStars(!e.target.checked)} />
          <span>Show stars <small>(difficulty levels on items, plus star and difficulty options for new games)</small></span></label>
      </section>
      <section class="panel">
        <h2>How to play</h2>
        <${HowToPlay} />
      </section>
    </main>`;
}

// Rerolls per player. 0 is stored as noSwaps (older games), a cap as rerollLimit, no cap as neither.
const REROLL_LIMITS = [[0, 'Off'], [3, '3'], [5, '5'], [10, '10'], [Infinity, '∞', 'No limit']];
function RerollChoice({ limit, setLimit }) {
  return html`<h2>Rerolls each</h2>
    <${Choice} value=${limit} onChange=${setLimit} options=${REROLL_LIMITS} />
    <p class="muted small">A reroll swaps an item for a random one${hideStars ? '' : ' with the same stars'}.</p>`;
}
const rerollCap = (g) => (g.noSwaps ? 0 : g.rerollLimit || Infinity);
const canReroll = (g, used = 0) => used < rerollCap(g);

function MineToggle({ on, set }) {
  const n = itemPool.filter(isMine).length;
  return html`<label class="toggle"><input type="checkbox" checked=${on} onChange=${(e) => set(e.target.checked)} />
    <span>Only my list <small>(${n} items: your wish list + items you added)</small></span></label>`;
}

/** Pick any number of categories. Callers block starting/dealing while none are picked. */
function CatPicker({ value, onChange }) {
  const toggle = (c) => onChange(value.includes(c) ? value.filter((x) => x !== c) : ALL_CATS.filter((x) => x === c || value.includes(x)));
  return html`<div class="cat-picker">
    ${ALL_CATS.map((c) => html`<button class=${`cat-opt cat-${c}${value.includes(c) ? ' sel' : ''}`} key=${c} onClick=${() => toggle(c)} aria-pressed=${value.includes(c)}>
      <span class="dot"></span>${CATEGORY_LABELS[c]}</button>`)}
  </div>`;
}

function Choice({ options, value, onChange, grid }) {
  return html`<div class=${'choice' + (grid ? ' grid2' : '')}>
    ${options.map(([v, label, sub]) => html`
      <button class=${value === v ? 'sel' : ''} onClick=${() => onChange(v)}>
        <b>${label}</b>${sub && html`<small>${sub}</small>`}
      </button>`)}
  </div>`;
}

const GAME_PRESETS_KEY = 'nycc-game-presets';
const loadGamePresets = () => { try { const v = JSON.parse(loadPref(GAME_PRESETS_KEY, '[]')); return Array.isArray(v) ? v : []; } catch { return []; } };
const saveGamePresets = (list) => savePref(GAME_PRESETS_KEY, JSON.stringify(list));

function NewGame({ mode, me, players }) {
  const isBingo = mode === 'bingo';
  const isEndless = mode === 'endless';
  const [tier, setTier] = useState('any');
  const [slots, setSlots] = useState(1);
  const [turnMode, setTurnMode] = useState('any');
  const [size, setSize] = useState(isBingo ? 5 : 3);
  const [difficulty, setDifficulty] = useState('balanced');
  const [winRule, setWinRule] = useState('line');
  const [minutes, setMinutes] = useState(90);
  const [freeCenter, setFreeCenter] = useState(true);
  const [sameCard, setSameCard] = useState(false);
  const [connect, setConnect] = useState(G.defaultConnect(3));
  const [coop, setCoop] = useState(false);
  const [cats, setCats] = useState(ALL_CATS);
  const [mineOnly, setMineOnly] = useState(false);
  const [tiers, setTiers] = useState(ALL_TIERS);
  const [backups, setBackups] = useState(null); // null = follow the board size
  const [rerollLimit, setRerollLimit] = useState(Infinity);
  const [place, setPlace] = useState(false);
  const [hand, setHand] = useState(HAND_SIZE);
  const toggleTier = (t) => setTiers((ts) => (ts.includes(t) ? (ts.length > 1 ? ts.filter((x) => x !== t) : ts) : ALL_TIERS.filter((x) => x === t || ts.includes(x))));
  const [selected, setSelected] = useState([me.id]);
  const [busy, setBusy] = useState(false);

  // Saved game setups ("presets") for this mode, kept on this device.
  const [presets, setPresets] = useState(loadGamePresets);
  const modePresets = presets.filter((p) => p.mode === mode);
  const [presetId, setPresetId] = useState('');
  const keepConnect = useRef(false);
  const snapshot = () => ({ size, difficulty, winRule, minutes, freeCenter, sameCard, connect, coop, cats, mineOnly, tiers, backups,
    rerollLimit: Number.isFinite(rerollLimit) ? rerollLimit : 'inf', place, hand, tier, slots, turnMode });
  const defaults = useRef(null);
  defaults.current ??= snapshot(); // the screen's starting settings, for "None"
  const applyPreset = (id) => {
    setPresetId(id);
    const v = id ? modePresets.find((x) => x.id === id)?.s : defaults.current;
    if (!v) return;
    keepConnect.current = v.size !== size; // the size change below must not reset "in a row"
    const set = (fn, val) => val !== undefined && fn(val);
    set(setSize, v.size); set(setDifficulty, v.difficulty); set(setWinRule, v.winRule); set(setMinutes, v.minutes);
    set(setFreeCenter, v.freeCenter); set(setSameCard, v.sameCard); set(setConnect, v.connect); set(setCoop, v.coop);
    set(setCats, v.cats); set(setMineOnly, v.mineOnly); set(setTiers, v.tiers); set(setBackups, v.backups);
    set(setRerollLimit, v.rerollLimit === 'inf' ? Infinity : v.rerollLimit); set(setPlace, v.place); set(setHand, v.hand);
    set(setTier, v.tier); set(setSlots, v.slots); set(setTurnMode, v.turnMode);
  };
  const savePreset = () => {
    const current = modePresets.find((x) => x.id === presetId);
    const name = prompt('Name this preset:', current?.name || '')?.trim();
    if (!name) return;
    const existing = presets.find((x) => x.mode === mode && x.name.toLowerCase() === name.toLowerCase());
    if (existing && existing.id !== presetId && !confirm(`Replace your "${existing.name}" preset?`)) return;
    const id = existing?.id || G.uid();
    const next = [...presets.filter((x) => x.id !== id), { id, name, mode, s: snapshot() }];
    setPresets(next); saveGamePresets(next); setPresetId(id);
    toast(`Saved "${name}"`, 'good');
  };
  const deletePreset = () => {
    const p = modePresets.find((x) => x.id === presetId);
    if (!p || !confirm(`Delete the "${p.name}" preset?`)) return;
    const next = presets.filter((x) => x.id !== p.id);
    setPresets(next); saveGamePresets(next); setPresetId('');
  };

  useEffect(() => {
    if (keepConnect.current) { keepConnect.current = false; return; }
    setConnect(G.defaultConnect(size));
  }, [size]);

  const toggle = (pid) => {
    if (pid === me.id) return;
    setSelected((s) => (s.includes(pid) ? s.filter((x) => x !== pid) : [...s, pid]));
  };

  const create = async () => {
    setBusy(true);
    try {
      const code = await createGame({ mode, size, difficulty: hideStars ? 'balanced' : difficulty, winRule, minutes, freeCenter, sameCard, connect, coop, cats, mineOnly,
        tier: hideStars ? 'any' : tier, slots, turnMode, tiers: isEndless || hideStars ? null : tiers,
        backupCount: nb, noSwaps: rerollLimit === 0, rerollLimit: Number.isFinite(rerollLimit) && rerollLimit > 0 ? rerollLimit : null, place: !isBingo && !isEndless && place, handSize: hand, players: selected }, me.id);
      go(`/g/${code}`);
    } catch (e) {
      toast(`Couldn't create game: ${e.message}`, 'error');
      setBusy(false);
    }
  };

  const nb = backups ?? G.backupsFor(size);
  const pool = cats.length ? poolFor({ cats, mineOnly, tiers: isEndless || hideStars ? null : tiers }) : [];
  const tooFew = isEndless ? !pool.length : pool.length < size * size + nb;
  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/">‹ Home</a></nav>
      <h1 class="title">${isBingo ? 'New Solo Series' : isEndless ? 'New Endless Hunt' : 'New Crossover'}</h1>
      ${modePresets.length > 0 && html`<div class="row game-filters preset-row">
        <${SingleSelect} label="Presets" placeholder="Choose a preset…" value=${presetId} onChange=${applyPreset}
          options=${[{ value: '', label: 'None (default settings)' }, ...modePresets.map((p) => ({ value: p.id, label: p.name }))]} />
        ${presetId && html`<button class="preset-del" aria-label="Delete preset" onClick=${deletePreset}>${ic('trash')}</button>`}
      </div>`}

      ${isEndless ? html`<section class="panel">
        <h2>What kind of items?</h2>
        <${CatPicker} value=${cats} onChange=${setCats} />
        <${MineToggle} on=${mineOnly} set=${setMineOnly} />
        <h2>Items active at once</h2>
        <${Choice} value=${slots} onChange=${setSlots} options=${[1, 2, 3, 4, 5].map((k) => [k, String(k)])} />
        <h2>Who can snap?</h2>
        <${Choice} value=${turnMode} onChange=${setTurnMode}
          options=${[['any', 'Anyone', 'First to snap an item gets the points'], ['turns', 'Take turns', 'Players go one at a time']]} />
        ${!hideStars && html`<h2>Starting difficulty</h2>
        <${Choice} grid value=${tier} onChange=${setTier} options=${endlessTiers()} />
        <p class="muted small">Whoever snaps an item picks the difficulty and type of the one that replaces it.</p>`}
        <${RerollChoice} limit=${rerollLimit} setLimit=${setRerollLimit} />
      </section>` : html`<section class="panel">
        <h2>Board size</h2>
        <${Choice} value=${size} onChange=${setSize}
          options=${G.SIZES.map((s) => [s, `${s}×${s}`, `${s * s} squares`])} />

        <h2>What's on the board?</h2>
        <${CatPicker} value=${cats} onChange=${setCats} />
        <${MineToggle} on=${mineOnly} set=${setMineOnly} />

        ${!hideStars && html`<h2>Stars</h2>
        <div class="choice">
          ${ALL_TIERS.map((t) => html`<button class=${tiers.includes(t) ? 'sel' : ''} onClick=${() => toggleTier(t)} aria-pressed=${tiers.includes(t)}>
            <b>${TIER_STARS[t]}</b><small>${{ e: 'Easy', m: 'Medium', h: 'Hard' }[t]}</small></button>`)}
        </div>
        <p class="muted small">Tap to include or leave out a star level.</p>`}

        ${!hideStars && tiers.length > 1 && html`
          <h2>Difficulty</h2>
          <${Choice} grid value=${difficulty} onChange=${setDifficulty}
            options=${Object.entries(G.DIFFICULTY).map(([k, d]) => [k, d.label, d.blurb])} />`}

        ${isBingo ? html`
          <h2>How do you win?</h2>
          <${Choice} value=${winRule} onChange=${setWinRule}
            options=${Object.entries(G.WIN_RULES).map(([k, r]) => [k, r.label, r.blurb])} />
          ${winRule === 'most' && html`
            <h2>Time limit</h2>
            <${Choice} value=${minutes} onChange=${setMinutes}
              options=${[[30, '30m'], [60, '1h'], [90, '1.5h'], [120, '2h'], [180, '3h'], [300, '5h']]} />
            <p class="muted small">1 pt per photo · +3 per line · +10 for blackout</p>`}
          <label class="toggle"><input type="checkbox" checked=${sameCard} onChange=${(e) => setSameCard(e.target.checked)} />
            <span>Same card for everyone <small>(race for the same items)</small></span></label>
          ${size % 2 === 1 && html`
            <label class="toggle"><input type="checkbox" checked=${freeCenter} onChange=${(e) => setFreeCenter(e.target.checked)} />
              <span>Free center square</span></label>`}
        ` : html`
          <h2>Board</h2>
          <${Choice} value=${place} onChange=${setPlace}
            options=${[[false, 'Filled', 'Items start on the board'], [true, 'Empty', 'Snap from your hand, then place it']]} />
          ${place && html`
            <h2>Hand size</h2>
            <${Choice} value=${hand} onChange=${setHand} options=${[3, 5, 7, 9, 12].map((k) => [k, String(k)])} />
            <p class="muted small">Each player holds ${hand} items to pick from. Snap one and you get a whole new hand.</p>`}
          <h2>Game style</h2>
          <${Choice} value=${coop} onChange=${setCoop}
            options=${[[false, 'Race', 'Claim squares, first to get N in a row wins'], [true, 'Co-op', 'Team up and black out the whole board together']]} />
          ${!coop && html`
            <h2>In a row to win</h2>
            <${Choice} value=${connect} onChange=${setConnect}
              options=${Array.from({ length: size - 2 }, (_, i) => i + 3).map((k) => [k, `${k} in a row`])} />`}
        `}

        ${!(place && !isBingo) && html`
          <h2>Backups</h2>
          <${Choice} value=${nb} onChange=${setBackups} options=${[0, 1, 2, 3, 4, 5].map((k) => [k, String(k)])} />
          <p class="muted small">${nb ? `Each player gets ${nb} backup item${nb === 1 ? '' : 's'} to swap onto their board.` : 'No backup items this game.'}</p>`}

        <${RerollChoice} limit=${rerollLimit} setLimit=${setRerollLimit} />
      </section>`}

      <section class="panel">
        <h2>Players</h2>
        <div class="player-pick">
          ${(players || []).map((p) => html`
            <button class="chip big ${selected.includes(p.id) ? 'sel' : ''}" onClick=${() => toggle(p.id)}>
              <${Emblem} id=${p.emblem} size=${32} /> ${p.name}${p.id === me.id ? ' (you)' : ''}
            </button>`)}
        </div>
        <p class="muted small">Not listed? They can join anytime with the game code.${isEndless && turnMode === 'turns' ? ' Turns go in the order people joined, starting with you.' : ''}</p>
      </section>

      <p class="muted small center">Drawing from <b>${pool.length}</b> hunt items · <a href="#/items">edit list</a></p>
      ${!cats.length ? html`<div class="banner warn">Pick at least one category.</div>`
        : tooFew && html`<div class="banner warn">Not enough items turned on${isEndless ? '' : ` for a ${size}×${size} board`}. Turn more on in the item list or pick more categories.</div>`}
      <button class="btn primary huge" disabled=${busy || tooFew} onClick=${create}>${busy ? 'Creating…' : 'Start the hunt!'}</button>
      <button class="btn ghost save-setup" onClick=${savePreset}>${ic('save')} ${presetId ? 'Update or save as a new preset' : 'Save these settings as a preset'}</button>
    </main>`;
}

// ───────────────────────── game rows ─────────────────────────

const svgIcon = (d, size = 22) => html`<svg viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${d} /></svg>`;
// Camera body + lens, and a framed picture: the Endless quick-snap buttons.
const CAMERA_ICON = svgIcon('M3 8.5A2.5 2.5 0 0 1 5.5 6h2l1.5-2h6l1.5 2h2A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5zM12 16.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', 22);
const PHOTOS_ICON = html`<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="9" cy="9.5" r="1.7" fill="currentColor" stroke="none" />
  <path d="M3.5 18l5-5 3.5 3.5 2.5-2.5 6 6" /></svg>`;
// Chunky filled bar chart.
const STATS_ICON = html`<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="currentColor">
  <rect x="3" y="11" width="5" height="10" rx="1.5" /><rect x="9.5" y="4" width="5" height="17" rx="1.5" /><rect x="16" y="8" width="5" height="13" rx="1.5" /></svg>`;
const GEAR_ICON = svgIcon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z');
const PEOPLE_ICON = svgIcon('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8', 20);

// Arrow into a door: join a game.
const JOIN_ICON = svgIcon('M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3', 20);

// A little stack of photos.
const COLLAGE_ICON = html`<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7 3h11a3 3 0 0 1 3 3v11" /><rect x="3" y="7" width="14" height="14" rx="2.5" />
  <circle cx="8" cy="11.5" r="1.6" fill="currentColor" stroke="none" /><path d="M3.5 19l4.5-4.5 3 3 2-2 3.5 3.5" /></svg>`;

const TRASH_SVG = html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>`;

const gameDetail = (g) => g.mode === 'endless' ? `${findCount(g)} find${findCount(g) === 1 ? '' : 's'}`
  : `${g.size}×${g.size}${g.place ? ' · Empty board' : ''} · ${g.mode === 'bingo' ? G.WIN_RULES[g.winRule]?.label : g.coop ? 'Team blackout' : `${g.connect} in a row`}`;
// Over once someone won, the game was ended, or a timed game ran out (its winner is worked out on screen).
const isDone = (g) => !!g.winner || (!!g.endsAt && Date.now() >= g.endsAt);
const gameResult = (g, playersById) => {
  const w = g.winner && playersById[g.winner];
  return w ? html`${ic('trophy')} ${w.name}` : g.winner === 'draw' ? html`${ic('equal')} Draw` : g.winner === 'team' ? html`${ic('sparkles')} Blacked out`
    : g.winner === 'ended' ? html`${ic('flag')} Ended` : isDone(g) ? html`${ic('clock')} Time's up` : 'In progress';
};

/** One game in a list. Pass href to make it a link, onClick/selected for picking. onDelete adds swipe-left Delete; onEnd/onRecap the swipe-right action. */
function GameRow({ g, playersById, href, onClick, selected, onDelete, onEnd, onRecap }) {
  const body = html`
    ${selected !== undefined && html`<span class="check-box">${selected ? ic('check') : ''}</span>`}
    <span class="grow">
      <span class="gr-top"><b>${g.code}</b><span class="mode-label ${g.mode}">${modeTag(g)}</span>
        ${isDone(g) ? html`<span class="status-tag done">${ic('check')}Done</span>` : html`<span class="status-tag live"><i></i>Live</span>`}</span>
      <small>${gameDetail(g)}</small>
      <small>${new Date(g.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${gameResult(g, playersById)}</small>
    </span>
    <span class="stack">${g.players.slice(0, 4).map((pid) => html`<${Emblem} id=${playersById[pid]?.emblem} size=${28} />`)}</span>`;
  const done = isDone(g);
  // Right swipe: End game on a live game, Game recap on a finished one.
  const rightAction = !done ? onEnd && [ic('flag', 22), 'End game', onEnd] : onRecap && [ic('image', 22), 'Recap', onRecap];
  const swipe = useSwipeReveal(!!onDelete, !!rightAction);
  const card = html`<div class=${`game-card mode-${g.mode}${g.coop ? ' coop' : ''}${selected ? ' sel' : ''}${isDone(g) ? ' done' : ''}`}
      ref=${swipe.ref} onClickCapture=${swipe.guard}>
    ${href ? html`<a class="game-main" href=${href}>${body}</a>` : html`<button class="game-main" onClick=${onClick}>${body}</button>`}
  </div>`;
  if (!onDelete) return card;
  return html`<div class="swipe-row">
    ${rightAction && html`<button class=${'swipe-end' + (done ? ' recap' : '')} tabindex="-1" onClick=${async () => { swipe.close(); await rightAction[2](); }}>${rightAction[0]}<span>${rightAction[1]}</span></button>`}
    <button class="swipe-delete" tabindex="-1" onClick=${async () => { swipe.close(); await onDelete(); }}>${TRASH_SVG}<span>Delete</span></button>
    ${card}
  </div>`;
}

const SWIPE_OPEN = 96; // px the row slides to show the button behind it
/** Swipe a row left to reveal Delete (or right to reveal End game). A tap while open (or right after a drag) just closes it.
 *  state.open: 0 closed, -1 slid left, 1 slid right. */
function useSwipeReveal(enabled, canRight) {
  const ref = useRef(null);
  const state = useRef({ open: 0, dragged: false });
  const right = useRef(canRight);
  right.current = canRight;
  const set = (x, animate) => {
    const el = ref.current;
    if (!el) return;
    el.style.transition = animate ? 'transform 0.2s ease-out' : 'none';
    el.style.transform = x ? `translateX(${x}px)` : '';
  };
  const close = () => { state.current.open = 0; set(0, true); };
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    let x0 = 0, y0 = 0, dx = 0, mode = null; // mode: null until we know, 'h' swiping, 'v' scrolling
    const start = (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; dx = 0; mode = null; state.current.dragged = false; };
    const move = (e) => {
      const mx = e.touches[0].clientX - x0, my = e.touches[0].clientY - y0;
      if (!mode) { if (Math.abs(mx) < 10 && Math.abs(my) < 10) return; mode = Math.abs(mx) > Math.abs(my) ? 'h' : 'v'; }
      if (mode !== 'h') return;
      e.preventDefault();
      state.current.dragged = true;
      const max = right.current ? SWIPE_OPEN * 1.4 : 0;
      dx = Math.min(max, Math.max(-SWIPE_OPEN * 1.4, mx + state.current.open * SWIPE_OPEN));
      set(dx, false);
    };
    const end = () => {
      if (mode !== 'h') return;
      state.current.open = dx < -SWIPE_OPEN / 2 ? -1 : dx > SWIPE_OPEN / 2 && right.current ? 1 : 0;
      set(state.current.open * SWIPE_OPEN, true);
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [enabled]);
  const guard = (e) => {
    if (state.current.dragged || state.current.open) {
      e.preventDefault(); e.stopPropagation();
      state.current.dragged = false;
      close();
    }
  };
  return { ref, guard, close };
}

// ───────────────────────── mega collage ─────────────────────────

function CollageScreen({ me, playersById }) {
  const games = useWatch((cb) => store.watchAll('games', cb), []);
  const [picked, setPicked] = useState(() => new Set());
  const [onlyMine, setOnlyMine] = useState(true);
  const [daysSaved, setDays] = usePrefList('nycc-collage:days');
  const [recap, setRecap] = useState(null);

  const dayKey = (t) => new Date(t).toDateString();
  const mine = (games || []).filter((g) => !onlyMine || g.players?.includes(me.id)).sort((a, b) => b.createdAt - a.createdAt);
  const days = [...new Set(mine.map((g) => dayKey(g.createdAt)))];
  const pickedDays = daysSaved.filter((d) => days.includes(d));
  const list = mine.filter((g) => !pickedDays.length || pickedDays.includes(dayKey(g.createdAt)));
  const toggle = (code) => setPicked((s) => { const n = new Set(s); n.has(code) ? n.delete(code) : n.add(code); return n; });
  const allOn = list.length > 0 && list.every((g) => picked.has(g.code));
  const setAll = () => setPicked(allOn ? new Set() : new Set(list.map((g) => g.code)));
  const chosen = list.filter((g) => picked.has(g.code)).sort((a, b) => a.createdAt - b.createdAt);

  const make = async () => {
    setRecap({ progress: 'Gathering photos…' });
    try {
      const data = await Promise.all(chosen.map(async (game) => {
        const [boards, thumbList] = await Promise.all([
          game.mode === 'bingo' ? store.getWhere('boards', 'gameId', '==', game.code) : [],
          store.getWhere('thumbs', 'gameId', '==', game.code),
        ]);
        return { game, boards, thumbs: Object.fromEntries(thumbList.map((t) => [t.id, t])) };
      }));
      const blob = await renderCollage({
        games: data, playersById,
        onProgress: (k, n) => setRecap({ progress: `Drawing game ${k} of ${n}…` }),
      });
      setRecap({ blob, url: URL.createObjectURL(blob) });
    } catch (e) {
      setRecap(null);
      toast(`Couldn't make the collage: ${e.message}`, 'error');
    }
  };
  const close = () => { if (recap?.url) URL.revokeObjectURL(recap.url); setRecap(null); };

  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/">‹ Home</a></nav>
      <h1 class="title">Mega collage</h1>
      <p class="muted">Pick as many games as you like. You'll get one giant poster with the totals, a leaderboard, every photo and every game's recap.</p>

      <section class="panel">
        <div class="row">
          <span class="grow nowrap"><b>${chosen.length}</b> selected</span>
          <button class=${'pill' + (onlyMine ? ' sel' : '')} onClick=${() => setOnlyMine(!onlyMine)}>Only my games</button>
          <button class="pill" onClick=${setAll} disabled=${!list.length}>${allOn ? 'Select none' : 'Select all'}</button>
        </div>
        ${days.length > 1 && html`<div class="row game-filters collage-filter">
          <${DateMulti} days=${days} value=${pickedDays} onChange=${setDays} />
        </div>`}
      </section>

      ${games === undefined ? html`<p class="muted center">Loading games…</p>`
        : !list.length ? html`<div class="panel center muted">No games yet.</div>`
        : html`<div class="game-list collage-list">
          ${list.map((g) => html`<${GameRow} key=${g.code} g=${g} playersById=${playersById}
            selected=${picked.has(g.code)} onClick=${() => toggle(g.code)} />`)}
        </div>`}

      <div class="collage-go">
        <button class="btn primary huge" disabled=${!chosen.length} onClick=${make}>
          ${ic('collage')} Make collage${chosen.length ? ` (${chosen.length})` : ''}</button>
      </div>
      ${recap && html`<${RecapModal} recap=${recap} code="collage" title="Mega collage" playersById=${playersById} onClose=${close} />`}
    </main>`;
}

// ───────────────────────── player stats ─────────────────────────

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');

function StatsScreen({ me, players, playersById, focus }) {
  const games = useWatch((cb) => store.watchAll('games', cb), []);
  const boards = useWatch((cb) => store.watchAll('boards', cb), []);
  const [daysSaved, setDays] = usePrefList('nycc-stats:days');
  const [whoSaved, setWho] = usePrefList('nycc-stats:players');
  if (games === undefined || boards === undefined) return html`<main class="screen"><p class="muted center">Crunching numbers…</p></main>`;

  // Filters: only games on the picked days and/or with the picked player count toward every number below.
  const dayKey = (t) => new Date(t).toDateString();
  const allSorted = games.slice().sort((a, b) => b.createdAt - a.createdAt);
  const days = [...new Set(allSorted.map((g) => dayKey(g.createdAt)))];
  const people = [...new Set(allSorted.flatMap((g) => g.players || []))].filter((pid) => playersById[pid]);
  const pickedDays = daysSaved.filter((d) => days.includes(d));
  const who = whoSaved.filter((pid) => people.includes(pid));
  const fGames = games.filter((g) => (!pickedDays.length || pickedDays.includes(dayKey(g.createdAt))) && (!who.length || who.some((pid) => g.players?.includes(pid))));
  const inSet = new Set(fGames.map((g) => g.code));
  const fBoards = boards.filter((b) => inSet.has(b.gameId));
  const filtered = fGames.length !== games.length;

  const stats = G.playerStats(fGames, fBoards);
  // Picking a player shows only that player: their card, their finds per category, their records.
  const catStats = G.categoryStats(fGames, fBoards, who);
  const ranked = (players || []).filter((p) => stats[p.id] && (!who.length || who.includes(p.id)))
    .sort((a, b) => stats[b.id].wins - stats[a.id].wins || stats[b.id].found - stats[a.id].found);

  if (focus && playersById[focus]) return html`<${PlayerStats} p=${playersById[focus]} s=${stats[focus]} me=${me} playersById=${playersById}
    note=${filtered ? `Filtered to ${fGames.length} of ${games.length} games (change filters on All players)` : null} />`;

  const most = (key) => {
    const top = ranked.slice().sort((a, b) => stats[b.id][key] - stats[a.id][key])[0];
    return top && stats[top.id][key] ? top : null;
  };
  const awards = [
    [ic('trophy'), 'Most wins', most('wins'), 'wins'],
    [ic('search'), 'Most finds', most('found'), 'found'],
    [ic('camera'), 'Most photos', most('photos'), 'photos'],
    [ic('gem'), 'Rare hunter (★★★)', ranked.slice().sort((a, b) => stats[b.id].tiers.h - stats[a.id].tiers.h)[0], null],
    [ic('dice'), 'Reroll addict', most('rerolls'), 'rerolls'],
  ].filter(([, , p]) => p);

  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/">‹ Home</a></nav>
      <h1 class="title">Player stats</h1>
      ${games.length > 1 && html`<div class="row game-filters stats-filters">
        <${DateMulti} days=${days} value=${pickedDays} onChange=${setDays} />
        <${PlayerMulti} people=${people} value=${who} onChange=${setWho} me=${me} playersById=${playersById} />
      </div>
      <p class="muted small filter-note">${filtered ? `Showing ${fGames.length} of ${games.length} games` : `All ${games.length} games`}</p>`}
      ${!ranked.length && html`<div class="panel center muted">${filtered ? 'No games match these filters.' : 'No games played yet. Go hunt!'}</div>`}
      ${ranked.length > 0 && awards.length > 0 && html`<section class="panel">
        <h2>Bragging rights</h2>
        <div class="awards">
          ${awards.map(([icon, label, p, key]) => {
            const v = key ? stats[p.id][key] : stats[p.id].tiers.h;
            return v ? html`<a class="award" href="#/stats/${p.id}" key=${label}>
              <span class="aw-icon">${icon}</span><small>${label}</small>
              <b><${Emblem} id=${p.emblem} size=${20} /> ${firstName(p)}</b><span class="muted small">${v}</span></a>` : null;
          })}
        </div>
      </section>`}
      ${Object.keys(catStats).length > 0 && html`<${CategoryStats} cs=${catStats} playersById=${playersById} />`}
      ${ranked.length > 0 && html`<h2 class="section-title">Players</h2>`}
      ${ranked.map((p, k) => {
        const s = stats[p.id];
        return html`<a class="panel stat-card" href="#/stats/${p.id}" key=${p.id}>
          <div class="stat-head">
            <span class="rank">${k + 1}</span>
            <${Emblem} id=${p.emblem} size=${44} />
            <span class="grow"><b>${p.name}${p.id === me.id ? ' (you)' : ''}</b>
              <small>${s.games} game${s.games === 1 ? '' : 's'}${s.finished ? ` · ${pct(s.wins, s.finished)} win rate` : ''}</small></span>
            <span>›</span>
          </div>
          <div class="stat-grid">
            <div><b>${s.wins}</b><small>Wins</small></div>
            <div><b>${s.found}</b><small>Finds</small></div>
            <div><b>${s.photos}</b><small>Photos</small></div>
            <div><b>${s.tiers.h}</b><small>Hard finds</small></div>
          </div>
          ${s.topItems[0] && html`<p class="top-cat"><span class=${`top-icon cat-${s.topItems[0].item.cat}`}>${itemIcon(s.topItems[0].item.icon)}</span>
            ${s.topItems[0].n > 1 ? 'Most found:' : 'Latest find:'} <b>${s.topItems[0].item.text}</b>${s.topItems[0].n > 1 ? html` <span class="muted">· ${s.topItems[0].n}×</span>` : ''}</p>`}
        </a>`;
      })}
    </main>`;
}

/** Every category side by side: how often it's in play, how often it's found, and its stars. */
function CategoryStats({ cs, playersById }) {
  const rows = Object.keys(CATEGORY_LABELS).filter((c) => cs[c]).map((c) => [c, cs[c]]);
  const totalFound = rows.reduce((t, [, c]) => t + c.found, 0);
  const maxDealt = Math.max(1, ...rows.map(([, c]) => c.dealt));
  const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
  return html`<section class="panel">
    <h2>Categories</h2>
    <p class="muted small">How often each kind of item ends up in play, and how often it gets found.</p>
    <div class="bars cat-usage">
      ${rows.map(([c, v]) => html`<div class="bar-row" key=${c}>
        <span>${catLabel(c)}</span>
        <span class="bar"><span class=${`cat-${c}`} style=${`width:${(v.dealt / maxDealt) * 100}%`}></span></span>
        <b>${v.dealt}</b></div>`)}
    </div>
    <p class="muted small bar-caption">Times in play</p>
    <p class="muted small">Found % = how often items of that kind get found once they're in play. Share = its slice of everyone's finds.</p>
    <div class="cat-cards">
      ${rows.map(([c, v]) => {
        const hunter = top(v.hunters, 1)[0];
        const hp = hunter && playersById[hunter[0]];
        return html`<div class=${`cat-card cat-${c}`} key=${c}>
          <h3><span class=${`dot cat-${c}`}></span> ${catLabel(c)}</h3>
          <div class="stat-grid">
            <div><b>${v.found}</b><small>Finds</small></div>
            <div><b>${pct(v.found, v.dealt)}</b><small>Found %</small></div>
            <div><b>${pct(v.found, totalFound)}</b><small>Share</small></div>
            <div><b>${v.photos}</b><small>Photos</small></div>
          </div>
          ${hp && html`<p class="cat-line">${ic('trophy')} Top hunter: <${Emblem} id=${hp.emblem} size=${20} /> <b>${firstName(hp)}</b> <span class="muted">(${hunter[1]})</span></p>`}
          ${Object.keys(v.items).length > 0 && html`<p class="cat-line">${ic('search')} Most found: ${top(v.items, 3).map(([t, n], k) => html`${k ? ', ' : ''}<b>${t}</b> <span class="muted">(${n})</span>`)}</p>`}
          <p class="cat-line muted">${ic('dice')} In ${v.games} game${v.games === 1 ? '' : 's'}</p>
        </div>`;
      })}
    </div>
  </section>`;
}

function PlayerStats({ p, s, me, playersById, note }) {
  const thumbs = useWatch((cb) => store.watchWhere('thumbs', 'by', '==', p.id, cb), [p.id]);
  if (!s) return html`<main class="screen"><nav class="topbar"><a class="back" href="#/stats">‹ All players</a></nav>
    <div class="panel center muted">${p.name} hasn't played yet.</div></main>`;
  const photos = (thumbs || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/stats">‹ All players</a></nav>
      <div class="player-hero">
        <${Emblem} id=${p.emblem} size=${72} />
        <div><h1 class="title">${p.name}</h1>
          <p class="muted">${s.games} game${s.games === 1 ? '' : 's'}${p.id === me.id ? ' · That\'s you!' : ''}</p></div>
      </div>
      ${note && html`<p class="muted small filter-note">${note}</p>`}

      <section class="panel">
        <div class="stat-grid big">
          <div><b>${s.wins}</b><small>Wins</small></div>
          <div><b>${pct(s.wins, s.finished)}</b><small>Win rate</small></div>
          <div><b>${s.found}</b><small>Finds</small></div>
          <div><b>${s.photos}</b><small>Photos</small></div>
          <div><b>${s.lines}</b><small>Bingo lines</small></div>
          <div><b>${s.blackouts}</b><small>Blackouts</small></div>
          <div><b>${s.teamWins}</b><small>Co-op wins</small></div>
          <div><b>${s.rerolls}</b><small>Rerolls</small></div>
        </div>
      </section>

      <section class="panel">
        <h2>Finds by difficulty</h2>
        <div class="stat-grid">
          <div><b>${s.tiers.e}</b><small>★ Easy</small></div>
          <div><b>${s.tiers.m}</b><small>★★ Medium</small></div>
          <div><b>${s.tiers.h}</b><small>★★★ Hard</small></div>
        </div>
      </section>

      ${s.topItems.length > 0 && html`<section class="panel">
        <h2>Top finds</h2>
        <div class="top-cats">
          ${s.topItems.slice(0, 5).map((t, k) => html`<div class="top-find-row" key=${t.item.text}>
            <span class="rank">${k + 1}</span>
            <span class=${`top-icon cat-${t.item.cat}`}>${itemIcon(t.item.icon)}</span>
            <span class="grow"><b>${t.item.text}</b><small>${catLabel(t.item.cat)} · found ${t.n}×</small></span>
          </div>`)}
        </div>
      </section>`}

      <section class="panel">
        <h2>Games</h2>
        <div class="game-list">
          ${s.recent.map((g) => html`<${GameRow} key=${g.code} g=${g} playersById=${playersById} href=${`#/g/${g.code}`} />`)}
        </div>
      </section>

      <section class="panel">
        <h2>Photos${photos.length ? ` (${photos.length})` : ''}</h2>
        ${thumbs === undefined ? html`<p class="muted">Loading…</p>`
          : !photos.length ? html`<p class="muted">No photos yet.</p>`
          : html`<div class="photo-grid">${photos.map((t) => html`<a href="#/g/${t.gameId}" key=${t.id}><img src=${t.thumb} alt="" loading="lazy" /></a>`)}</div>`}
      </section>
    </main>`;
}

// ───────────────────────── item list editor ─────────────────────────

const TIER_LABELS = { e: 'Easy', m: 'Medium', h: 'Hard' };

function ItemForm({ initial, submitLabel = 'Add item', onSubmit, onCancel, compact, extra }) {
  const [icon, setIcon] = useState(itemIconName(initial?.icon) || 'camera');
  const [picking, setPicking] = useState(false);
  const [mine, setMine] = useState(initial ? initial.mine !== false : true);
  const [text, setText] = useState(initial?.text || '');
  const [tier, setTier] = useState(initial?.tier && initial.tier !== 'free' ? initial.tier : 'e');
  const [cat, setCat] = useState(initial?.cat && initial.cat !== 'free' ? normalizeItem(initial).cat : 'desc');

  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return toast('Describe what to find.', 'error');
    onSubmit({ icon, text: t.slice(0, 80), tier, cat, ...(compact ? {} : { mine }) });
    if (!initial) { setIcon('camera'); setText(''); }
  };

  return html`
    <form class="item-form ${compact ? 'compact' : ''}" onSubmit=${submit}>
      <div class="row">
        <button type="button" class=${'icon-pick-btn' + (picking ? ' sel' : '')} aria-label="Choose an icon" aria-expanded=${picking}
          onClick=${() => setPicking(!picking)}>${ic(icon)}</button>
        <input class="text grow" placeholder="What to find, e.g. Someone with a tail" value=${text} maxlength="80"
          onInput=${(e) => setText(e.target.value)} />
      </div>
      ${picking && html`<div class="icon-grid">
        ${PICKABLE_ICONS.map((n) => html`<button type="button" class=${n === icon ? 'sel' : ''} aria-label=${n}
          onClick=${() => { setIcon(n); setPicking(false); }}>${ic(n)}</button>`)}
      </div>`}
      <${Choice} value=${tier} onChange=${setTier} options=${Object.entries(TIER_LABELS).map(([k, l]) => [k, l, TIER_STARS[k]])} />
      <div class="row cat-select"><${SingleSelect} label="Category" value=${cat} onChange=${setCat}
        options=${Object.entries(CATEGORY_LABELS).map(([k, l]) => ({ value: k, label: l }))} /></div>
      ${!compact && html`<label class="toggle mine-toggle"><input type="checkbox" checked=${mine} onChange=${(e) => setMine(e.target.checked)} />
        <span>Mark as mine <small>(adds it to your list and the Mine filter)</small></span></label>`}
      <div class="row end">
        ${extra && html`<span class="form-extra">${extra}</span>`}
        ${onCancel && html`<button type="button" class="btn ghost small" onClick=${onCancel}>Cancel</button>`}
        <button class="btn primary small">${submitLabel}</button>
      </div>
    </form>`;
}


/** Sheet for changing one item in the list. */
function ItemEditSheet({ item, onSave, onClose, onReset, onDelete, archived, onArchive, used }) {
  useScrollLock();
  const sheet = useSwipeDown(onClose);
  return html`<div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal" ref=${sheet}>
      <button class="x" onClick=${onClose} aria-label="Close">×</button>
      <h2 class="sheet-title">Edit item</h2>
      ${(item.orig || used !== null) && html`<p class="muted small">${item.orig ? `Originally "${item.orig}". ` : ''}${used !== null ? `Used in games ${used} time${used === 1 ? '' : 's'}.` : ''}</p>`}
      <${ItemForm} initial=${{ ...item, mine: isMine(item) }} submitLabel="Save changes" onSubmit=${onSave} onCancel=${onClose}
        extra=${html`<button type="button" class="btn small ghost" onClick=${() => onArchive(!archived)}>${ic('archive')} ${archived ? 'Unarchive' : 'Archive'}</button>`} />
      ${(onReset || onDelete) && html`<div class="row center-row sheet-actions">
        ${onReset && html`<button class="btn small ghost" onClick=${onReset}>${ic('undo')} Reset to original</button>`}
        ${onDelete && html`<button class="btn small danger" onClick=${onDelete}>${ic('trash')} Delete item</button>`}
      </div>`}
    </div>
  </div>`;
}

function ItemsScreen({ bank }) {
  const [q, setQ] = useState('');
  const [tiersF, setTiersF] = useState([]); // [] = any
  const [statusF, setStatusF] = useState([]); // 'on' | 'off'
  const [mineF, setMineF] = useState('any'); // any | mine | not
  const [catsF, setCatsF] = useState([]);
  const [showArchived, setShowArchived] = useState(false);
  const [setName, setSetName] = useState('');
  const disabled = new Set(bank?.disabled || []);
  const archived = new Set(bank?.archived || []);
  // How often each item has been in a game.
  const games = useWatch((cb) => store.watchAll('games', cb), []);
  const boards = useWatch((cb) => store.watchAll('boards', cb), []);
  const usage = useMemo(() => (games && boards ? G.itemUsage(games, boards) : null), [games, boards]);
  const custom = bank?.custom || [];
  const overrides = bank?.overrides || {};
  const all = [...custom.map((c) => ({ ...normalizeItem(c), custom: true })), ...G.withOverrides(bank)];
  const key = (it) => it.orig || it.text; // what on/off is stored under
  const [editing, setEditing] = useState(null); // item being edited

  const save = (next) => store.put('settings', BANK_ID, {
    disabled: bank?.disabled || [], custom, presets: bank?.presets || [], overrides, archived: bank?.archived || [], ...next, updatedAt: Date.now(),
  }).catch((e) => toast(`Sync problem: ${e.message}`, 'error'));

  const saveEdit = (orig, it) => {
    if (all.some((x) => x !== orig && x.text.toLowerCase() === it.text.toLowerCase())) return toast('Another item already has that name.', 'error');
    if (orig.custom) {
      // Your own item: rewrite it in place (and carry its on/off over to a new name).
      const d = [...disabled].map((t) => (t === orig.text ? it.text : t));
      save({ custom: custom.map((c) => (c.text === orig.text ? { ...c, ...it } : c)), disabled: d });
    } else {
      const base = ITEMS.find((x) => x.text === key(orig));
      const ov = { ...overrides };
      const changed = ['text', 'tier', 'cat'].some((k) => it[k] !== base[k]) || itemIconName(it.icon) !== itemIconName(base.icon)
        || !!it.mine !== !!base.mine;
      if (changed) ov[base.text] = { icon: it.icon, text: it.text, tier: it.tier, cat: it.cat, mine: !!it.mine };
      else delete ov[base.text];
      save({ overrides: ov });
    }
    setEditing(null);
    toast('Saved', 'good');
  };
  const setArchived = (it, on) => {
    const a = new Set(archived);
    on ? a.add(key(it)) : a.delete(key(it));
    save({ archived: [...a] });
    setEditing(null);
    toast(on ? `Archived "${it.text}". Find it under Archived.` : `"${it.text}" is back in the list.`);
  };
  const resetItem = (it) => {
    const ov = { ...overrides };
    delete ov[key(it)];
    save({ overrides: ov });
    setEditing(null);
    toast(`Back to "${key(it)}"`);
  };

  const toggle = (text) => {
    const d = new Set(disabled);
    d.has(text) ? d.delete(text) : d.add(text);
    save({ disabled: [...d] });
  };
  const add = (it) => {
    if (all.some((x) => x.text.toLowerCase() === it.text.toLowerCase())) return toast('That item already exists.', 'error');
    save({ custom: [it, ...custom] });
    toast(`Added: ${it.text}`, 'good');
  };
  const removeCustom = (text) => {
    if (!confirm(`Delete "${text}"?`)) return;
    save({ custom: custom.filter((c) => c.text !== text), disabled: [...disabled].filter((t) => t !== text) });
  };
  const setAll = (on) => {
    const visibleTexts = filtered.map(key);
    const changes = visibleTexts.filter((t) => disabled.has(t) === on).length;
    if (changes > 10 && !confirm(`Turn ${on ? 'on' : 'off'} ${changes} items? Save your current set first if you want to come back to it.`)) return;
    const d = new Set(disabled);
    for (const t of visibleTexts) on ? d.delete(t) : d.add(t);
    save({ disabled: [...d] });
  };

  // Saved sets: snapshots of which items are on, so "All on" etc. never loses your picks.
  const savePreset = () => {
    const name = (prompt('Name this set of picks (e.g. "My NYCC list")') || '').trim().slice(0, 30);
    if (!name) return;
    const rest = (bank?.presets || []).filter((pr) => pr.name !== name);
    save({ presets: [...rest, { name, disabled: [...disabled], at: Date.now() }] });
    toast(`Saved "${name}"`, 'good');
  };
  const loadPreset = (pr) => {
    if (!confirm(`Load "${pr.name}"? It replaces which items are on and off right now.`)) return;
    save({ disabled: pr.disabled });
    setSetName(pr.name);
    toast(`Loaded "${pr.name}"`);
  };
  const deletePreset = (pr) => {
    if (!confirm(`Delete the saved set "${pr.name}"?`)) return;
    save({ presets: (bank?.presets || []).filter((x) => x.name !== pr.name) });
    setSetName('');
  };

  const needle = q.trim().toLowerCase();
  const filtered = all.filter((it) =>
    archived.has(key(it)) === showArchived &&
    (hideStars || !tiersF.length || tiersF.includes(it.tier)) &&
    (!catsF.length || catsF.includes(it.cat)) &&
    (!statusF.length || statusF.includes(disabled.has(key(it)) ? 'off' : 'on')) &&
    (mineF === 'any' || (mineF === 'mine') === isMine(it)) &&
    (!needle || it.text.toLowerCase().includes(needle)));
  const usedTimes = (it) => (usage ? (usage[it.text] || 0) + (it.orig && it.orig !== it.text ? usage[it.orig] || 0 : 0) : null);
  const byCat = Object.keys(CATEGORY_LABELS).map((cat) => [cat, filtered.filter((i) => i.cat === cat)]).filter(([, xs]) => xs.length);
  const onCount = all.filter((i) => !disabled.has(key(i)) && !archived.has(key(i))).length;
  const presets = bank?.presets || [];
  const curSet = presets.find((pr) => pr.name === setName);

  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/">‹ Home</a>
        <button class=${'archive-link' + (showArchived ? ' sel' : '')} onClick=${() => setShowArchived(!showArchived)} aria-pressed=${showArchived}>
          ${ic('archive')} ${showArchived ? 'Back to items' : `Archived${archived.size ? ` (${archived.size})` : ''}`}</button></nav>
      <h1 class="title">${showArchived ? 'Archived items' : 'Hunt items'}</h1>
      <p class="muted">${onCount} of ${all.length - archived.size} items on${archived.size ? ` · ${archived.size} archived` : ''}. New games draw only from items that are on. Changes are shared with everyone.</p>

      <section class="panel">
        <h2>Add your own</h2>
        <${ItemForm} onSubmit=${add} />
      </section>

      <section class="panel sticky-filters">
        <input class="text" type="search" placeholder=${showArchived ? 'Search archived…' : 'Search items…'} value=${q} onInput=${(e) => setQ(e.target.value)} />
        ${showArchived && html`<p class="archive-note">${ic('archive')} Archived items: hidden from the list and never used in games. Tap one to bring it back.</p>`}
        <div class="filter-grid">
          <${MultiSelect} label="Categories" allLabel="All categories" noun="categories" value=${catsF} onChange=${setCatsF}
            options=${Object.entries(CATEGORY_LABELS).map(([k, l]) => ({ value: k, label: l, pre: html`<span class=${`dot cat-${k}`}></span> ` }))} />
          <${MultiSelect} label="On or off" allLabel="On + off" value=${statusF} onChange=${setStatusF}
            options=${[{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }]} />
          <${SingleSelect} label="Mine" active=${mineF !== 'any'} value=${mineF} onChange=${setMineF} placeholder="Mine: any"
            options=${[{ value: 'any', label: 'Mine: any' }, { value: 'mine', label: 'Only mine' }, { value: 'not', label: 'Not mine' }]} />
          ${!hideStars && html`<${MultiSelect} label="Stars" allLabel="All stars" noun="star levels" value=${tiersF} onChange=${setTiersF}
            options=${[{ value: 'e', label: '★' }, { value: 'm', label: '★★' }, { value: 'h', label: '★★★' }]} />`}
        </div>
        <div class="row game-filters set-row">
          <${SingleSelect} label="Saved sets" placeholder=${presets.length ? 'Saved sets…' : 'No saved sets yet'} value=${setName}
            onChange=${(n) => { const pr = presets.find((x) => x.name === n); if (pr) loadPreset(pr); }}
            options=${presets.map((pr) => ({ value: pr.name, label: `${pr.name} (${all.length - pr.disabled.length} on)` }))} />
          ${curSet && html`<button class="preset-del" aria-label="Delete saved set" onClick=${() => deletePreset(curSet)}>${ic('trash')}</button>`}
          <button class="preset-del" aria-label="Save current picks as a set" title="Save current" onClick=${savePreset}>${ic('save')}</button>
        </div>
        <div class="row small">
          <span class="grow muted">${filtered.length} shown</span>
          <button class="btn small ghost" onClick=${() => setAll(true)}>All on</button>
          <button class="btn small ghost" onClick=${() => setAll(false)}>All off</button>
        </div>
      </section>

      ${byCat.map(([cat, items]) => html`
        <section class="panel item-group" key=${cat}>
          <h2><span class="dot cat-${cat}"></span>${CATEGORY_LABELS[cat]} <small class="muted">${items.length}</small></h2>
          ${items.map((it) => {
            const on = !disabled.has(key(it));
            return html`<div class="item-row ${on ? '' : 'off'}" key=${key(it)}>
              <button class="item-edit" aria-label=${`Edit ${it.text}`} onClick=${() => setEditing(it)}>
              <span class="icon">${itemIcon(it.icon)}</span>
              <span class="grow">${it.text}${it.orig ? html` <i class="badge edited">edited</i>` : ''}${isMine(it) && html` <i class="badge">mine</i>`}<small class="stars">${TIER_STARS[it.tier]}</small></span>
              ${usedTimes(it) !== null && html`<span class=${'used' + (usedTimes(it) ? '' : ' zero')} title="Times in a game">${usedTimes(it)}×</span>`}
              </button>
              <label class="switch"><input type="checkbox" checked=${on} onChange=${() => toggle(key(it))} /><span></span></label>
            </div>`;
          })}
        </section>`)}
      ${!filtered.length && html`<p class="muted center">No items match.</p>`}
      ${editing && html`<${ItemEditSheet} item=${editing} onSave=${(it) => saveEdit(editing, it)} onClose=${() => setEditing(null)}
        archived=${archived.has(key(editing))} onArchive=${(on) => setArchived(editing, on)} used=${usedTimes(editing)}
        onReset=${editing.orig ? () => resetItem(editing) : null}
        onDelete=${editing.custom ? () => { removeCustom(editing.text); setEditing(null); } : null} />`}
    </main>`;
}

// ───────────────────────── board pieces ─────────────────────────

const STAR_TEXT = { e: '★', m: '★★', h: '★★★', free: '' };
// Reads '' for every level while stars are hidden (Settings), so every star label vanishes with one switch.
const TIER_STARS = new Proxy(STAR_TEXT, { get: (o, k) => (hideStars ? '' : o[k]) });

function Tile({ item, thumb, found, stamp, win, swapTarget, claimColor, onClick }) {
  const cls = ['tile', `cat-${item.cat}`, `tier-${item.tier}`, thumb && 'done', found && !thumb && 'found', win && 'win', swapTarget && 'swap-target']
    .filter(Boolean).join(' ');
  return html`
    <button class=${cls} onClick=${onClick} style=${claimColor ? `--claim:${claimColor}` : ''}>
      ${thumb ? html`
        <img class="shot" src=${thumb} alt="" />
        <span class="cap">${item.text}</span>
        ${stamp && html`<span class="stamp"><${Emblem} id=${stamp} size=${22} /></span>`}
      ` : html`
        <span class="icon">${itemIcon(item.icon)}</span>
        <span class="txt">${item.text}</span>
        ${TIER_STARS[item.tier] && !found && html`<span class="stars">${TIER_STARS[item.tier]}</span>`}
        ${found && html`<span class="check">${ic('check')}</span>`}
        ${found && stamp && html`<span class="stamp"><${Emblem} id=${stamp} size=${22} /></span>`}
      `}
    </button>`;
}

/** Your rerolls in this game, at the top right of the info line. */
function RerollPill({ game, n, show }) {
  if (!show || game.noSwaps) return null;
  const cap = rerollCap(game);
  return html`<span class=${'reroll-pill' + (n >= cap ? ' out' : '')} title="Rerolls you've used this game">${ic('dice')} ${Number.isFinite(cap) ? `${n}/${cap}` : n} reroll${n === 1 && !Number.isFinite(cap) ? '' : 's'}</span>`;
}

function Board({ size, children }) {
  return html`<div class="board s${size}" style=${`--n:${size}`}>${children}</div>`;
}

function BackupTray({ backups, swapIdx, setSwapIdx, canUse }) {
  if (!backups) return null;
  return html`
    <section class="backups">
      <h3>Backups <small>${backups.length} left${canUse && backups.length ? ' · Tap one, then tap a square to swap' : ''}</small></h3>
      <div class="backup-row">
        ${backups.length === 0 && html`<span class="muted small">All used up!</span>`}
        ${backups.map((b, i) => html`
          <button class="backup ${swapIdx === i ? 'sel' : ''}" disabled=${!canUse}
            onClick=${() => setSwapIdx(swapIdx === i ? null : i)}>
            <span class="icon">${itemIcon(b.icon)}</span><span>${b.text}</span><i>${TIER_STARS[b.tier]}</i>
          </button>`)}
      </div>
      ${swapIdx !== null && swapIdx !== undefined && html`
        <div class="banner swap">Tap a square to replace it with <b>${backups[swapIdx]?.text}</b>
          <button class="btn small ghost" onClick=${() => setSwapIdx(null)}>Cancel</button></div>`}
    </section>`;
}

const FACING_KEY = 'nycc-hunt:facing'; // last choice, used as the default for new games
const facingKey = (code) => `${FACING_KEY}:${code}`;
/** Which way the camera opens in the current game ('user' = selfie, 'environment' = back). */
const CameraFacing = createContext('user');
const WIDE_KEY = 'nycc-hunt:wide';
const SAVE_KEY = 'nycc-hunt:save-photos';
const hasLiveCamera = !!navigator.mediaDevices?.getUserMedia;
const loadPref = (key, dflt) => { try { return localStorage.getItem(key) ?? dflt; } catch { return dflt; } };
const savePref = (key, val) => { try { localStorage.setItem(key, val); } catch {} };
/** Like usePref, for a list (stored as JSON). */
const usePrefList = (key) => {
  const [v, setV] = useState(() => { try { const x = JSON.parse(loadPref(key, '[]')); return Array.isArray(x) ? x : []; } catch { return []; } });
  return [v, (x) => { setV(x); savePref(key, JSON.stringify(x)); }];
};
/** useState that remembers its (string) value on this device. */
/** On "my list": the built-in wish list, plus items you added (unless you unticked "mine" for one). */
const isMine = (it) => !!it.mine || (!!it.custom && it.mine !== false);

const usePref = (key, dflt) => {
  const [v, setV] = useState(() => loadPref(key, dflt));
  return [v, (x) => { setV(x); savePref(key, x); }];
};

/** Full-screen in-app camera (getUserMedia). Never fires the flash; front camera by default.
 *  "Wide" asks for the camera's full-sensor 4:3 format and its widest zoom, and the preview
 *  shows the whole frame (no cropping) so what you see is what you get. */
function CameraView({ onFile, onClose, onFallback }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const [facing, setFacing] = useState(useContext(CameraFacing));
  const [wide, setWide] = useState(() => loadPref(WIDE_KEY, '1') === '1');
  const [save, setSave] = useState(() => loadPref(SAVE_KEY, '1') === '1');
  useScrollLock();
  const [shot, setShot] = useState(null); // { url, blob }
  const [error, setError] = useState(null);
  const [ready, setReady] = useState(false);

  const stop = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; };

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    stop();
    // Sizes are in the sensor's landscape orientation; the browser rotates frames to match the phone.
    // 4:3 is the full sensor; 16:9 crops the top and bottom off.
    const size = wide ? { width: { ideal: 4032 }, height: { ideal: 3024 } } : { width: { ideal: 1920 }, height: { ideal: 1080 } };
    navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: facing, ...size } }).then(async (stream) => {
      if (cancelled) return stream.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;
      const track = stream.getVideoTracks()[0];
      const zoom = track?.getCapabilities?.().zoom;
      if (zoom && zoom.min < zoom.max) {
        await track.applyConstraints({ advanced: [{ zoom: wide ? zoom.min : Math.max(zoom.min, Math.min(1, zoom.max)) }] }).catch(() => {});
      }
      const v = videoRef.current;
      v.srcObject = stream;
      v.play().catch(() => {});
    }).catch((e) => {
      if (!cancelled) setError(e.name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow it in your browser settings, or use the phone camera instead.'
        : "Couldn't start the camera on this device.");
    });
    savePref(WIDE_KEY, wide ? '1' : '0');
    return () => { cancelled = true; };
  }, [facing, wide]);
  useEffect(() => () => { stop(); if (shot?.url) URL.revokeObjectURL(shot.url); }, []);

  const snap = () => {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    // Full quality for the camera-roll copy; uploads get shrunk to 1280px later.
    const scale = Math.min(1, 4096 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((blob) => setShot({ blob, url: URL.createObjectURL(blob) }), 'image/jpeg', 0.92);
  };
  const retake = () => { URL.revokeObjectURL(shot.url); setShot(null); };
  const toggleSave = () => { savePref(SAVE_KEY, save ? '0' : '1'); setSave(!save); };
  const use = () => {
    const file = new File([shot.blob], `nycc-hunt-${Date.now()}.jpg`, { type: 'image/jpeg' });
    if (save) saveToDevice(file); // must run inside this tap so the share sheet is allowed
    stop();
    onClose();
    onFile(file);
  };

  return html`
    <div class="camera">
      <video ref=${videoRef} class=${facing === 'user' ? 'mirror' : ''} playsinline muted autoplay
        onLoadedData=${() => setReady(true)} style=${shot ? 'display:none' : ''}></video>
      ${shot && html`<img class="camera-shot" src=${shot.url} alt="Your photo" />`}
      ${!ready && !shot && !error && html`<div class="camera-msg"><div class="spinner"></div>Starting camera…</div>`}
      ${error && html`<div class="camera-msg">
        <p>${error}</p>
        <button class="btn primary" onClick=${() => { stop(); onClose(); onFallback(); }}>${ic('phone')} Use phone camera</button>
      </div>`}
      <button class="cam-btn cam-close" onClick=${() => { stop(); onClose(); }} aria-label="Close camera">${ic('x')}</button>
      ${shot && html`<button class=${'cam-pill' + (save ? ' on' : '')} onClick=${toggleSave}
        aria-pressed=${save}>${save ? html`${ic('check')} Save to Photos` : 'Save to Photos'}</button>`}
      ${!shot && !error && html`<button class=${'cam-pill cam-wide' + (wide ? ' on' : '')} onClick=${() => setWide(!wide)}
        aria-pressed=${wide}>${wide ? '⤡ Wide' : '⤢ Normal'}</button>`}
      <div class="camera-bar">
        ${shot ? html`
          <button class="btn ghost cam-retake" style="color:#141414;background:#fff" onClick=${retake}>${ic('undo')} Retake</button>
          <button class="btn primary" onClick=${use}>${ic('check')} Use photo</button>
        ` : html`
          <span class="cam-spacer"></span>
          <button class="shutter" onClick=${snap} disabled=${!ready} aria-label="Take photo"><span></span></button>
          <button class="cam-btn" onClick=${() => setFacing(facing === 'user' ? 'environment' : 'user')} aria-label="Flip camera">${ic('flip')}</button>
        `}
      </div>
    </div>`;
}

/** Saves a photo to the device. iPhone/Android: opens the share sheet (tap "Save Image").
 *  Desktop: downloads it. Web pages can't write to Photos silently. */
function saveToDevice(file) {
  if (navigator.canShare?.({ files: [file] })) {
    navigator.share({ files: [file] }).catch(() => {});
    return;
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function saveDataUrl(dataUrl, name) {
  const [head, b64] = dataUrl.split(',');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const type = head.match(/:(.*?);/)?.[1] || 'image/jpeg';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  saveToDevice(new File([bytes], `nycc-hunt-${slug || 'photo'}.jpg`, { type }));
}

function PhotoButtons({ onFile, label = 'Take photo' }) {
  const capture = useContext(CameraFacing) === 'environment' ? 'environment' : 'user';
  const [camera, setCamera] = useState(false);
  const nativeRef = useRef(null);
  const handle = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) onFile(f);
  };
  return html`
    <div class="photo-btns">
      ${hasLiveCamera
        ? html`<button class="btn primary huge" onClick=${() => setCamera(true)}>${ic('camera')} ${label}</button>`
        : html`<label class="btn primary huge">${ic('camera')} ${label}
            <input type="file" accept="image/*" capture=${capture} onChange=${handle} hidden /></label>`}
      <label class="btn ghost">${ic('image')} From iPhone
        <input type="file" accept="image/*" onChange=${handle} hidden /></label>
      ${hasLiveCamera && html`<input ref=${nativeRef} type="file" accept="image/*" capture=${capture} onChange=${handle} hidden />`}
      ${camera && html`<${CameraView} onFile=${onFile} onClose=${() => setCamera(false)}
        onFallback=${() => nativeRef.current?.click()} />`}
    </div>`;
}

/** Two round buttons beside an item: in-app camera, or pick from the photo library. */
function QuickSnap({ onFile }) {
  const capture = useContext(CameraFacing) === 'environment' ? 'environment' : 'user';
  const [camera, setCamera] = useState(false);
  const nativeRef = useRef(null);
  const handle = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) onFile(f);
  };
  return html`<div class="quick-btns">
    ${hasLiveCamera
      ? html`<button class="quick-btn snap" aria-label="Snap it" onClick=${() => setCamera(true)}>${CAMERA_ICON}</button>`
      : html`<label class="quick-btn snap" aria-label="Snap it">${CAMERA_ICON}<input type="file" accept="image/*" capture=${capture} onChange=${handle} hidden /></label>`}
    <label class="quick-btn" aria-label="From iPhone">${PHOTOS_ICON}<input type="file" accept="image/*" onChange=${handle} hidden /></label>
    ${hasLiveCamera && html`<input ref=${nativeRef} type="file" accept="image/*" capture=${capture} onChange=${handle} hidden />`}
    ${camera && html`<${CameraView} onFile=${onFile} onClose=${() => setCamera(false)} onFallback=${() => nativeRef.current?.click()} />`}
  </div>`;
}

/** A row of small icon buttons along the bottom of a sheet. tools = [icon, label, onClick] (falsy entries skipped). */
function IconTools({ tools }) {
  const list = tools.filter(Boolean);
  if (!list.length) return null;
  return html`<div class="icon-tools">
    ${list.map(([icon, label, onClick, disabled]) => html`<button class="icon-tool" onClick=${onClick} aria-label=${label} disabled=${!!disabled}>
      <span class="ic">${icon}</span><small>${label}</small></button>`)}
  </div>`;
}

const confirmBlock = (text) => confirm(`Block "${text}"? It gets swapped out now and turned off in your item list for future games.`);

// Freezes the page behind a sheet. iOS Safari ignores overflow:hidden on body, so pin it in place
// and restore the scroll position afterwards. Counted, so stacked sheets work.
let scrollLocks = 0, lockedY = 0;
function useScrollLock() {
  useEffect(() => {
    if (scrollLocks++ === 0) {
      lockedY = window.scrollY;
      Object.assign(document.body.style, { position: 'fixed', top: `-${lockedY}px`, left: '0', right: '0', overflow: 'hidden' });
    }
    return () => {
      if (--scrollLocks === 0) {
        Object.assign(document.body.style, { position: '', top: '', left: '', right: '', overflow: '' });
        window.scrollTo(0, lockedY);
      }
    };
  }, []);
}

/** Swipe a bottom sheet down to dismiss it. Only starts when the sheet is scrolled to the top. */
/** Horizontal swipe on a sheet: left = next, right = previous. Ignores mostly-vertical drags (scroll / swipe-down). */
function useSwipeSides(ref, onPrev, onNext) {
  const cbs = useRef({});
  cbs.current = { onPrev, onNext };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let x0 = null, y0 = 0;
    const start = (e) => {
      if (e.touches.length > 1 || e.target.closest('.camera, input, textarea')) { x0 = null; return; }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
    };
    // Once a drag is clearly sideways, keep the browser from treating it as its own back/forward swipe.
    const move = (e) => {
      if (x0 === null) return;
      const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5) e.preventDefault();
    };
    const end = (e) => {
      if (x0 === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0, dy = t.clientY - y0;
      x0 = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const go = dx < 0 ? cbs.current.onNext : cbs.current.onPrev;
      if (go) go();
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
    };
  }, []);
}

function useSwipeDown(onClose) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose; // keep the latest handler without re-binding listeners mid-drag
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startY = null, dy = 0;
    const start = (e) => {
      if (el.scrollTop > 0 || e.touches.length > 1 || e.target.closest('.camera')) { startY = null; return; }
      startY = e.touches[0].clientY; dy = 0;
      el.style.transition = 'none';
    };
    const move = (e) => {
      if (startY === null) return;
      dy = e.touches[0].clientY - startY;
      if (dy <= 0 || el.scrollTop > 0) { dy = 0; el.style.transform = ''; return; }
      // Ignore the small wobble of a normal tap: blocking it would cancel the tap on iOS.
      if (dy < 12) return;
      e.preventDefault(); // drag the sheet instead of scrolling it
      el.style.transform = `translateY(${dy - 12}px)`;
    };
    const end = () => {
      if (startY === null) return;
      startY = null;
      el.style.transition = 'transform 0.2s ease-out';
      if (dy > 110) { el.style.transform = 'translateY(100%)'; setTimeout(() => closeRef.current(), 180); }
      else el.style.transform = '';
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, []);
  return ref;
}

/** onReroll: swap an unfound square for a random same-star item. onBlock: swap it out and turn it off for good. */
// Full-size photos, fetched once per session. The sheet waits for the real photo instead of flashing the
// square thumbnail first (a different crop, so it visibly jumped when the full one replaced it).
const fullCache = new Map();
const fullLoads = new Map();
const loadFull = (id) => {
  if (fullCache.has(id)) return Promise.resolve(fullCache.get(id));
  if (!fullLoads.has(id)) {
    fullLoads.set(id, store.getOne('photos', id).then((d) => {
      if (d?.full) fullCache.set(id, d.full);
      fullLoads.delete(id);
      return d?.full || null;
    }).catch(() => { fullLoads.delete(id); return null; }));
  }
  return fullLoads.get(id);
};

function SquareModal({ item, photoId, found, thumb, by, at, canAct, actionLabel, onFile, onNoPhoto, onRemove, removeLabel, onEdit,
  onReroll, onBlock, rerolls = 0, onClose, note, onPrev, onNext, position, prefetch }) {
  const [full, setFull] = useState(() => fullCache.get(photoId) || null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useScrollLock();
  const sheet = useSwipeDown(onClose);
  useSwipeSides(sheet, onPrev, onNext);

  useEffect(() => {
    setFull(fullCache.get(photoId) || null);
    if (!photoId) return;
    let alive = true;
    loadFull(photoId).then((f) => alive && f && setFull(f));
    (prefetch || []).forEach((id) => id && loadFull(id)); // neighbours, so swiping lands on a ready photo
    return () => { alive = false; };
  }, [photoId]);

  const wrap = (fn) => async (arg) => {
    setBusy(true);
    try { await fn(arg); } catch (e) { toast(e.message || 'Something went wrong', 'error'); }
    setBusy(false);
  };

  return html`
    <div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal" ref=${sheet}>
        <button class="x" onClick=${onClose} aria-label="Close">×</button>
        <div class="modal-head cat-${item.cat}">
          <span class="icon">${itemIcon(item.icon)}</span>
          <div>
            <h2>${item.text}</h2>
            <small>${catLabel(item.cat)} ${TIER_STARS[item.tier] && html`· <span class="stars">${TIER_STARS[item.tier]}</span>`}</small>
          </div>
        </div>
        ${photoId && html`
          <figure class="photo">
            ${full ? html`<img src=${full} alt=${item.text} />`
              : html`<div class="photo-wait" aria-label="Loading photo"><span class="spinner"></span></div>`}
            ${by && html`<figcaption><${Emblem} id=${by.emblem} size=${22} /> ${by.name}
              ${at && html`<span class="muted"> · ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`}</figcaption>`}
          </figure>`}
        ${found && !photoId && html`<p class="found-note">${ic('checkCircle')} Found${by ? html` by <${Emblem} id=${by.emblem} size=${22} /> ${by.name}` : ''}, no photo
          ${at && html`<span class="muted"> · ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`}</p>`}
        ${note && html`<p class="muted center">${note}</p>`}
        ${position && html`<p class="sheet-pos">
          <button class="pos-btn" disabled=${!onPrev} onClick=${onPrev} aria-label="Previous">‹</button>
          <span>${position}</span>
          <button class="pos-btn" disabled=${!onNext} onClick=${onNext} aria-label="Next">›</button></p>`}
        ${editing ? html`<${ItemForm} initial=${item} submitLabel="Save square" compact
            onSubmit=${(it) => { onEdit(it); setEditing(false); }} onCancel=${() => setEditing(false)} />`
          : canAct && html`<${PhotoButtons} label=${actionLabel} onFile=${wrap(onFile)} />`}
        ${onRemove && html`<button class="btn small danger" onClick=${wrap(onRemove)}>${removeLabel || 'Remove photo'}</button>`}
        ${!editing && html`<${IconTools} tools=${[
          canAct && onNoPhoto && [ic('checkCircle', 22), 'No photo', wrap(onNoPhoto)],
          onReroll && [ic('dice', 22), `Reroll${rerolls ? ` (${rerolls})` : ''}`, onReroll],
          onEdit && [ic('pencil', 22), 'Edit', () => setEditing(true)],
          onBlock && [ic('ban', 22), 'Block', () => confirmBlock(item.text) && onBlock()],
          // Shown right away (greyed until the full photo arrives) so the sheet doesn't jump when it does.
          photoId && [ic('download', 22), 'Save photo', () => full && saveDataUrl(full, item.text), !full],
        ]} />`}
        ${busy && html`<div class="busy"><div class="spinner"></div>Uploading…</div>`}
      </div>
    </div>`;
}

async function uploadPhoto(file, gameId, by) {
  const { thumb, full } = await processPhoto(file);
  const id = G.uid();
  const fail = (e) => toast(`Photo sync problem: ${e.message}`, 'error');
  store.put('thumbs', id, { gameId, thumb, by, at: Date.now() }).catch(fail);
  store.put('photos', id, { gameId, full, by }).catch(fail);
  return id;
}

function Confetti() {
  const bits = useMemo(() => Array.from({ length: 36 }, (_, i) => ({
    left: Math.random() * 100, delay: Math.random() * 0.8, dur: 2 + Math.random() * 1.5,
    shape: ['sq', 'ci', 'strip'][i % 3], color: ['var(--red)', 'var(--yellow)', '#7fb2ff', '#8ce99a', '#c9a7ff'][i % 5],
  })), []);
  return html`<div class="confetti">${bits.map((b) => html`
    <span class=${b.shape} style=${`left:${b.left}%;background:${b.color};animation-delay:${b.delay}s;animation-duration:${b.dur}s`}></span>`)}</div>`;
}

function WinBanner({ text, sub, onRematch }) {
  return html`<div class="win-banner">
    <div class="pow">${text}</div>
    ${sub && html`<p>${sub}</p>`}
    <div class="row center-row">
      <button class="btn small primary" onClick=${() => dispatchEvent(new Event('nycc:recap'))}>${ic('image')} Game recap</button>
      ${onRematch && html`<button class="btn small" onClick=${onRematch}>Rematch</button>`}
    </div>
  </div>`;
}

function RecapModal({ recap, code, playersById, onFeature, onClose, title = 'Game recap' }) {
  useScrollLock();
  const sheet = useSwipeDown(onClose);
  const ext = recap.blob?.type === 'image/jpeg' ? 'jpg' : 'png';
  const file = recap.blob && new File([recap.blob], `nycc-hunt-${code}.${ext}`, { type: recap.blob.type || 'image/png' });
  const canShare = file && navigator.canShare?.({ files: [file] });
  const share = async () => {
    try { await navigator.share({ files: [file], title: 'NYCC Photo Hunt' }); } catch {}
  };
  return html`
    <div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal recap" ref=${sheet}>
        <div class="recap-head">
        <button class="x" onClick=${onClose} aria-label="Close">×</button>
        <h2 class="recap-title">${title}</h2>
        ${recap.boards?.length > 1 && html`<div class="recap-pick">
          <span class="muted small">Feature:</span>
          ${recap.boards.map((b) => html`<button key=${b.playerId}
            class=${'chip' + (recap.featuredId === b.playerId ? ' sel' : '')} disabled=${!recap.url}
            onClick=${() => onFeature(b.playerId)}>
            <${Emblem} id=${playersById[b.playerId]?.emblem} size=${22} /> ${firstName(playersById[b.playerId])}
          </button>`)}
        </div>`}
        ${recap.url && html`<div class="recap-actions">
          ${canShare && html`<button class="btn primary" onClick=${share}>${ic('share')} Save or share</button>`}
          <a class="btn ghost" href=${recap.url} download=${`nycc-hunt-${code}.${ext}`}>${ic('download')} Download</a>
        </div>`}
        </div>
        ${recap.url ? html`
          <img class="recap-img" src=${recap.url} alt="Game recap" />
          <p class="muted small center">Tip: you can also press and hold the image to save it to Photos.</p>
        ` : html`<div class="recap-loading"><div class="spinner"></div>${recap.progress || 'Drawing your comic…'}</div>`}
      </div>
    </div>`;
}

// ───────────────────────── game screens ─────────────────────────

/** Builds a game's recap image. thumbs is optional: without it the game's photos are fetched once. */
function useRecap(playersById) {
  const [recap, setRecap] = useState(null);
  const makeRecap = async (game, featuredId, thumbs) => {
    if (!game) return;
    if (typeof featuredId !== 'string') featuredId = undefined; // called from a click/event
    if (recap?.url) URL.revokeObjectURL(recap.url);
    const same = recap?.game?.code === game.code;
    const cached = featuredId && same && recap?.boards;
    setRecap({ game, boards: cached, featuredId });
    try {
      const [boards, thumbMap] = await Promise.all([
        cached || (game.mode === 'bingo' ? store.getWhere('boards', 'gameId', '==', game.code) : []),
        thumbs || (same && recap?.thumbs) || store.getWhere('thumbs', 'gameId', '==', game.code).then((l) => Object.fromEntries(l.map((t) => [t.id, t]))),
      ]);
      if (!featuredId && boards.length) {
        // Default to the winner's card, else the top score.
        const top = boards.find((b) => b.playerId === game.winner)
          || boards.slice().sort((a, b) => G.scoreBoard(b).points - G.scoreBoard(a).points)[0];
        featuredId = top.playerId;
      }
      const blob = await renderRecap({ game, boards, thumbs: thumbMap, playersById, featuredId });
      setRecap({ game, blob, url: URL.createObjectURL(blob), boards, thumbs: thumbMap, featuredId });
    } catch (e) {
      setRecap(null);
      toast(`Couldn't make the recap: ${e.message}`, 'error');
    }
  };
  const closeRecap = () => { if (recap?.url) URL.revokeObjectURL(recap.url); setRecap(null); };
  return { recap, makeRecap, closeRecap };
}

function GameScreen({ code, me, playersById }) {
  // Opened from a stats page? Go back there instead of Home.
  const [backFrom] = useState(() => (/^#\/stats/.test(prevHash) ? prevHash : null));
  const game = useWatch((cb) => store.watchDoc('games', code, cb), [code]);
  const thumbList = useWatch((cb) => store.watchWhere('thumbs', 'gameId', '==', code, cb), [code]);
  const thumbs = useMemo(() => Object.fromEntries((thumbList || []).map((t) => [t.id, t])), [thumbList]);
  const [joining, setJoining] = useState(false);
  const [facing, setFacing] = useState(() => loadPref(facingKey(code), loadPref(FACING_KEY, 'user')));
  const pickFacing = (f) => { setFacing(f); savePref(facingKey(code), f); savePref(FACING_KEY, f); };

  const { recap, makeRecap, closeRecap } = useRecap(playersById);
  const recapThis = (featuredId) => makeRecap(game, featuredId, thumbs);
  useEffect(() => {
    const on = () => recapThis();
    addEventListener('nycc:recap', on);
    return () => removeEventListener('nycc:recap', on);
  });

  if (game === undefined) return html`<main class="screen"><p class="muted center">Loading game ${code}…</p></main>`;
  if (game === null) return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/">‹ Home</a></nav>
      <div class="panel center"><h2>No game "${code}"</h2><p class="muted">Double-check the code.
        ${!store.isLive && ' (Demo mode only sees games made on this device.)'}</p></div>
    </main>`;

  const isPlayer = game.players.includes(me.id);

  const join = async () => {
    setJoining(true);
    try {
      const res = await store.transact('games', code, (g) => {
        if (!g || g.players.includes(me.id)) return undefined;
        g.players.push(me.id);
        if (g.mode === 'versus' && g.place) g.hands = { ...g.hands, [me.id]: drawHand(g, handSize(g)) };
        else if (g.mode === 'versus') g.backups = { ...g.backups, [me.id]: versusBackups(g) };
        return g;
      });
      if (game.mode === 'bingo') {
        const id = `${code}_${me.id}`;
        if (!(await store.getOne('boards', id))) await store.put('boards', id, makeBoard(res.data || game, me.id));
      }
    } catch (e) {
      toast(`Couldn't join: ${e.message}`, 'error');
    }
    setJoining(false);
  };

  const rematch = async () => {
    const newCode = await createGame(settingsFrom(game), me.id);
    go(`/g/${newCode}`);
  };

  const share = async () => {
    const url = gameUrl(code);
    const text = `Join my NYCC photo hunt! Code ${code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'NYCC Photo Hunt', text, url });
      else { await navigator.clipboard.writeText(url); toast('Link copied!'); }
    } catch {}
  };

  const Screen = game.mode === 'bingo' ? BingoGame : game.mode === 'endless' ? EndlessGame : game.place ? PlaceGame : VersusGame;
  return html`
    <main class="screen game">
      <nav class="topbar">
        ${backFrom ? html`<a class="back" href=${backFrom} onClick=${(e) => { e.preventDefault(); goBack(backFrom); }}>‹ Back</a>`
          : html`<a class="back" href="#/">‹ Home</a>`}
        <span class="topbar-right">
          ${isPlayer && html`<button class="cam-chip" onClick=${() => pickFacing(facing === 'user' ? 'environment' : 'user')}
            title="Camera opens to (tap to switch)" aria-label=${`Camera opens to ${facing === 'user' ? 'selfie' : 'back'} camera. Tap to switch.`}>
            ${facing === 'user' ? html`${ic('user')} Selfie` : html`${ic('camera')} Back`}</button>`}
          <button class="code-chip" onClick=${share}>Code <b>${code}</b> · Share</button>
        </span>
      </nav>
      ${!isPlayer && html`
        <div class="banner join-banner">You're watching this game.
          <button class="btn primary small" disabled=${joining} onClick=${join}>${joining ? 'Joining…' : 'Join game'}</button></div>`}
      <${CameraFacing.Provider} value=${facing}>
        <${Screen} key=${isPlayer ? 'player' : 'watcher'} game=${game} me=${me} playersById=${playersById} thumbs=${thumbs} isPlayer=${isPlayer} onRematch=${rematch} />
      <//>
      <div class="game-footer">
        ${isDone(game) ? html`<button class="btn small" onClick=${() => recapThis()}>${ic('image')} Game recap</button>`
          : isPlayer && html`<button class="btn small" onClick=${() => endGameEarly(game)}>${ic('flag')} End game</button>`}
        <button class="btn small danger" onClick=${async () => { if (await confirmDelete(code)) go('/'); }}>${ic('trash')} Delete game</button>
      </div>
      ${recap && html`<${RecapModal} recap=${recap} code=${code} playersById=${playersById} onFeature=${recapThis} onClose=${closeRecap} />`}
    </main>`;
}

function useCelebrate(winner) {
  const prev = useRef(winner);
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (winner && !prev.current) { setShow(true); setTimeout(() => setShow(false), 4500); }
    prev.current = winner;
  }, [winner]);
  return show;
}

function BingoGame({ game, me, playersById, thumbs, isPlayer, onRematch }) {
  const boards = useWatch((cb) => store.watchWhere('boards', 'gameId', '==', game.code, cb), [game.code]);
  const now = useNow(!!game.endsAt);
  const [viewing, setViewing] = useState(isPlayer ? me.id : null);
  const [swapIdx, setSwapIdx] = useState(null);
  const [open, setOpen] = useState(null); // square index

  const timeUp = (!!game.endsAt && now >= game.endsAt) || !!game.endedEarly;
  const ordered = useMemo(() => (boards || []).slice().sort((a, b) =>
    (a.playerId === me.id ? -1 : b.playerId === me.id ? 1 : a.createdAt - b.createdAt)), [boards, me.id]);
  const scores = useMemo(() => Object.fromEntries(ordered.map((b) => [b.playerId, G.scoreBoard(b)])), [ordered]);

  useEffect(() => { if (!viewing && ordered.length) setViewing(ordered[0].playerId); }, [ordered.length]);
  useEffect(() => { if (isPlayer) setViewing(me.id); }, [isPlayer]);

  // 'most' winner is computed once time is up; line/blackout winners are written to the game doc.
  let winnerId = game.winner;
  if (game.winRule === 'most' && timeUp && !game.endedEarly && ordered.length) {
    const best = Math.max(...ordered.map((b) => scores[b.playerId].points));
    const leaders = ordered.filter((b) => scores[b.playerId].points === best);
    winnerId = leaders.length === 1 ? leaders[0].playerId : 'draw';
  }
  const celebrate = useCelebrate(winnerId);

  if (boards === undefined) return html`<p class="muted center">Loading boards…</p>`;
  const board = ordered.find((b) => b.playerId === viewing);
  const mine = board?.playerId === me.id;
  const canEdit = mine && !timeUp;
  const score = board && scores[board.playerId];

  const boardId = (b) => `${game.code}_${b.playerId}`;

  const tapSquare = async (i) => {
    const item = board.items[i];
    if (swapIdx !== null && canEdit) {
      if (item.tier === 'free' || board.marks?.[i]) return toast('Pick a square without a photo.', 'error');
      const items = board.items.slice();
      const backups = board.backups.slice();
      items[i] = backups.splice(swapIdx, 1)[0];
      setSwapIdx(null);
      store.patch('boards', boardId(board), { items, backups }).catch((e) => toast(e.message, 'error'));
      toast(`Swapped in: ${items[i].text}`);
      return;
    }
    if (item.tier === 'free') return toast('Free space. It counts for everyone!');
    setOpen(i);
  };

  const markSquare = async (file) => {
    const i = open;
    const photo = file ? await uploadPhoto(file, game.code, me.id) : null;
    const mark = { photo, at: Date.now() };
    store.patch('boards', boardId(board), { [`marks.${i}`]: mark }).catch((e) => toast(e.message, 'error'));
    setOpen(null);

    const after = G.scoreBoard({ ...board, marks: { ...board.marks, [i]: mark } });
    const before = scores[board.playerId];
    const won = (game.winRule === 'line' && after.lines > 0) || (game.winRule === 'blackout' && after.blackout);
    if (won && !game.winner) {
      store.transact('games', game.code, (g) => {
        if (!g || g.winner) return undefined;
        return { ...g, winner: me.id, wonAt: Date.now() };
      }).catch(() => {});
    } else if (after.lines > before.lines) toast('LINE!', 'good');
    else toast('Got it!', 'good');
  };

  const editSquare = (it) => {
    const items = board.items.slice();
    items[open] = it;
    store.patch('boards', boardId(board), { items }).catch((e) => toast(e.message, 'error'));
    toast('Square updated');
  };

  const boardExclude = () => [...board.items, ...(board.backups || [])].map((it) => it.text);
  const swapSquare = (i, it, counted) => {
    const items = board.items.slice();
    items[i] = it;
    store.patch('boards', boardId(board), { items, ...(counted ? { rerolls: (board.rerolls || 0) + 1 } : {}) })
      .catch((e) => toast(e.message, 'error'));
  };
  const reroll = () => {
    const it = G.rerollItem(board.items[open], { exclude: boardExclude(), pool: poolFor(game) });
    if (!it) return toast('No other items with these stars to roll.', 'error');
    swapSquare(open, it, true);
  };
  const block = () => {
    const i = open, cur = board.items[i];
    blockItem(cur.text);
    const it = G.rerollItem(cur, { exclude: boardExclude(), pool: poolFor(game).filter((x) => x.text !== cur.text) });
    if (it) swapSquare(i, it, false);
  };

  const unmark = async () => {
    store.patch('boards', boardId(board), { [`marks.${open}`]: store.DELETE }).catch((e) => toast(e.message, 'error'));
    setOpen(null);
  };

  const winner = winnerId && winnerId !== 'draw' ? playersById[winnerId] : null;
  const openMark = open !== null ? board.marks?.[open] : null;

  return html`
    ${celebrate && html`<${Confetti} />`}
    <div class="game-info">
      <span>${game.size}×${game.size} · ${G.WIN_RULES[game.winRule]?.label}${diffTag(game)}${mixTag(game)}${tiersTag(game)}</span>
      <span class="info-right">
        ${game.endsAt && html`<span class="timer ${timeUp ? 'over' : ''}">${ic('clock')} ${timeUp ? "Time's up!" : G.fmtDuration(game.endsAt - now)}</span>`}
        <${RerollPill} game=${game} n=${ordered.find((b) => b.playerId === me.id)?.rerolls || 0} show=${ordered.some((b) => b.playerId === me.id)} />
      </span>
    </div>
    ${winnerId && html`<${WinBanner}
      text=${winnerId === 'draw' ? "IT'S A TIE!" : winnerId === me.id ? 'YOU WIN!' : `${firstName(winner).toUpperCase()} WINS!`}
      sub=${game.endedEarly ? 'Game ended early.' : game.winRule !== 'most' ? 'Keep hunting for bragging rights, or start a rematch.' : null}
      onRematch=${onRematch} />`}

    <div class="scoreboard">
      ${ordered.map((b) => {
        const p = playersById[b.playerId];
        const s = scores[b.playerId];
        return html`<button class="score ${viewing === b.playerId ? 'sel' : ''}" key=${b.playerId} onClick=${() => { setViewing(b.playerId); setSwapIdx(null); }}>
          <${Emblem} id=${p?.emblem} size=${34} />
          <span class="nm">${b.playerId === me.id ? 'You' : firstName(p)}${winnerId === b.playerId ? html` ${ic('trophy')}` : ''}</span>
          <span class="pts">${s.found} found · ${s.lines} line${s.lines === 1 ? '' : 's'}${game.winRule === 'most' ? ` · ${s.points}pt` : ''}${b.rerolls ? html` · ${ic('dice')}${b.rerolls}` : ''}</span>
        </button>`;
      })}
    </div>

    ${board ? html`
      ${!mine && html`<p class="muted center small">Viewing ${firstName(playersById[board.playerId])}'s board</p>`}
      <${Board} size=${game.size}>
        ${board.items.map((item, i) => {
          const m = board.marks?.[i];
          return html`<${Tile} key=${i} item=${item} thumb=${m?.photo && (thumbs[m.photo]?.thumb || PLACEHOLDER)} found=${!!m}
            stamp=${m && playersById[board.playerId]?.emblem} win=${score.lineCells.has(i)}
            swapTarget=${swapIdx !== null && canEdit && !m && item.tier !== 'free'} onClick=${() => tapSquare(i)} />`;
        })}
      <//>
      ${mine && backupCount(game) > 0 && html`<${BackupTray} backups=${board.backups} swapIdx=${swapIdx} setSwapIdx=${setSwapIdx} canUse=${canEdit} />`}
    ` : html`<p class="muted center">No board yet.</p>`}

    ${open !== null && board && html`<${SquareModal}
      item=${board.items[open]}
      photoId=${openMark?.photo} found=${!!openMark} thumb=${openMark?.photo && thumbs[openMark.photo]?.thumb}
      by=${openMark && playersById[board.playerId]} at=${openMark?.at}
      canAct=${canEdit} actionLabel=${openMark?.photo ? 'Retake photo' : openMark ? 'Add a photo' : 'Take photo'}
      onFile=${markSquare} onNoPhoto=${!openMark ? () => markSquare(null) : null}
      onRemove=${canEdit && openMark ? unmark : null} removeLabel=${openMark?.photo ? 'Remove photo' : 'Unmark square'}
      onEdit=${canEdit && !openMark ? editSquare : null}
      onReroll=${canEdit && !openMark && canReroll(game, board.rerolls) ? reroll : null} rerolls=${board.rerolls || 0}
      onBlock=${canEdit && !openMark ? block : null}
      note=${!openMark && !canEdit ? (timeUp ? "Time's up!" : 'Not found yet.') : null}
      onClose=${() => setOpen(null)} />`}
  `;
}

const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ddd"/><g transform="translate(3.25 3.25)">' + iconSVG('camera', '#999', 3.5) + '</g></svg>');

function VersusGame({ game, me, playersById, thumbs, isPlayer, onRematch }) {
  const [swapIdx, setSwapIdx] = useState(null);
  const [open, setOpen] = useState(null);
  const celebrate = useCelebrate(game.winner);

  const counts = G.versusCounts(game);
  const coop = !!game.coop;
  const total = game.size * game.size;
  const foundCount = Object.keys(game.claims || {}).length;
  const winLine = !coop && game.winner && game.winner !== 'draw' ? G.versusWinLine(game, game.winner) : null;
  const winCells = new Set(winLine || []);
  const over = !!game.winner;
  const myBackups = game.backups?.[me.id];

  const tapSquare = async (i) => {
    if (swapIdx !== null && isPlayer && !over) {
      if (game.claims?.[i]) return toast('That square is already claimed.', 'error');
      const idx = swapIdx;
      setSwapIdx(null);
      try {
        const res = await store.transact('games', game.code, (g) => {
          if (!g || g.claims?.[i] || g.winner) return undefined;
          const backups = (g.backups[me.id] || []).slice();
          const [b] = backups.splice(idx, 1);
          if (!b) return undefined;
          g.items[i] = b;
          g.backups = { ...g.backups, [me.id]: backups };
          return g;
        });
        toast(res.ok ? `Swapped in: ${res.data.items[i].text}` : "Couldn't swap. Someone claimed it.", res.ok ? 'info' : 'error');
      } catch (e) { toast(`Swap needs a connection: ${e.message}`, 'error'); }
      return;
    }
    setOpen(i);
  };

  const claim = async (file) => {
    const i = open;
    const photo = file ? await uploadPhoto(file, game.code, me.id) : null;
    const existing = game.claims?.[i];
    if (existing?.by === me.id) {
      // Adding a photo to a square you already claimed without one.
      await store.transact('games', game.code, (g) => {
        if (!g || g.claims?.[i]?.by !== me.id) return undefined;
        g.claims = { ...g.claims, [i]: { ...g.claims[i], photo } };
        return g;
      });
      setOpen(null);
      return toast('Photo added', 'good');
    }
    let res;
    try {
      res = await store.transact('games', game.code, (g) => {
        if (!g || g.winner || g.claims?.[i]) return undefined;
        g.claims = { ...g.claims, [i]: { by: me.id, photo, at: Date.now() } };
        const full = Object.keys(g.claims).length === g.size * g.size;
        if (g.coop) {
          if (full) g.winner = 'team';
        } else if (G.versusWinLine(g, me.id)) {
          g.winner = me.id;
        } else if (full) {
          const c = G.versusCounts(g);
          const best = Math.max(...Object.values(c));
          const leaders = Object.keys(c).filter((k) => c[k] === best);
          g.winner = leaders.length === 1 ? leaders[0] : 'draw';
        }
        if (g.winner) g.wonAt = Date.now();
        return g;
      });
    } catch (e) {
      throw new Error(`Claiming needs a connection. Try again in a sec. (${e.message})`);
    }
    setOpen(null);
    if (!res.ok) {
      const c = res.data?.claims?.[i];
      const who = c && (c.by === me.id ? 'You' : firstName(playersById[c.by]));
      toast(c ? (game.coop ? `${who} already found that one!` : `Too slow! ${who} got it first.`) : 'Game is over!', c && game.coop ? 'info' : 'error');
    } else if (game.coop && !res.data.winner) {
      const left = game.size * game.size - Object.keys(res.data.claims).length;
      toast(`Found it! ${left} to go`, 'good');
    } else if (res.data.winner !== me.id && !game.coop) toast('Claimed!', 'good');
  };

  const editSquare = async (it) => {
    const i = open;
    try {
      const res = await store.transact('games', game.code, (g) => {
        if (!g || g.claims?.[i] || g.winner) return undefined;
        g.items[i] = it;
        return g;
      });
      toast(res.ok ? 'Square updated' : 'Someone already claimed it!', res.ok ? 'info' : 'error');
    } catch (e) { toast(`Editing needs a connection: ${e.message}`, 'error'); }
  };

  const sharedExclude = (g) => [...g.items, ...Object.values(g.backups || {}).flat()].map((it) => it.text);
  // Swaps square i to `choice` (or a random same-star item when choice is null).
  const swapShared = async (i, choice, { counted, avoid } = {}) => {
    try {
      const res = await store.transact('games', game.code, (g) => {
        if (!g || g.claims?.[i] || g.winner) return undefined;
        const taken = sharedExclude(g);
        const it = choice && !taken.includes(choice.text) ? choice
          : G.rerollItem(g.items[i], { exclude: taken, pool: poolFor(g).filter((x) => x.text !== avoid) });
        if (!it) return undefined;
        g.items[i] = it;
        if (counted) g.rerolls = { ...g.rerolls, [me.id]: (g.rerolls?.[me.id] || 0) + 1 };
        return g;
      });
      if (!res.ok) toast(res.data?.claims?.[i] ? 'Someone already got that one!' : 'No other items with these stars to swap in.', 'error');
    } catch (e) { toast(`Swapping needs a connection: ${e.message}`, 'error'); }
  };
  const reroll = () => swapShared(open, null, { counted: true });
  const block = () => {
    const i = open, cur = game.items[i];
    blockItem(cur.text);
    swapShared(i, null, { avoid: cur.text });
  };

  const unclaim = async () => {
    const i = open;
    await store.transact('games', game.code, (g) => {
      if (!g || g.winner || g.claims?.[i]?.by !== me.id) return undefined;
      const claims = { ...g.claims };
      delete claims[i];
      return { ...g, claims };
    });
    setOpen(null);
  };

  const winner = game.winner && game.winner !== 'draw' ? playersById[game.winner] : null;
  const openClaim = open !== null ? game.claims?.[open] : null;

  return html`
    ${celebrate && html`<${Confetti} />`}
    <div class="game-info"><span>${game.size}×${game.size} · ${coop ? 'Co-op: black out the board' : `${game.connect} in a row wins`}${diffTag(game)}${mixTag(game)}${tiersTag(game)}</span><${RerollPill} game=${game} n=${game.rerolls?.[me.id] || 0} show=${isPlayer} /></div>
    ${over && html`<${WinBanner}
      text=${game.winner === 'ended' ? 'GAME OVER' : game.winner === 'team' ? 'TEAM BLACKOUT!' : game.winner === 'draw' ? "IT'S A DRAW!" : game.winner === me.id ? 'YOU WIN!' : `${firstName(winner).toUpperCase()} WINS!`}
      sub=${game.endedEarly ? (coop ? 'Game ended early.' : 'Game ended early: most squares wins.') : coop ? `All ${total} squares found together!` : !winLine && game.winner !== 'draw' ? 'Board full: most squares wins.' : null}
      onRematch=${onRematch} />`}

    ${coop && html`<div class="team-progress">
      <div class="bar"><span style=${`width:${(foundCount / total) * 100}%`}></span></div>
      <b>${foundCount} / ${total} found together</b>
    </div>`}
    <div class="scoreboard">
      ${game.players.map((pid) => {
        const p = playersById[pid];
        return html`<div class="score versus" key=${pid} style=${`--claim:${playerColor(p)}`}>
          <${Emblem} id=${p?.emblem} size=${34} />
          <span class="nm">${pid === me.id ? 'You' : firstName(p)}${game.winner === pid ? html` ${ic('trophy')}` : ''}</span>
          <span class="pts">${counts[pid] || 0} ${coop ? 'found' : 'claimed'}${game.rerolls?.[pid] ? html` · ${ic('dice')}${game.rerolls[pid]}` : ''}</span>
        </div>`;
      })}
    </div>

    <${Board} size=${game.size}>
      ${game.items.map((item, i) => {
        const c = game.claims?.[i];
        const p = c && playersById[c.by];
        return html`<${Tile} key=${i} item=${item} thumb=${c?.photo && (thumbs[c.photo]?.thumb || PLACEHOLDER)} found=${!!c}
          stamp=${p?.emblem} claimColor=${p && playerColor(p)} win=${winCells.has(i)}
          swapTarget=${swapIdx !== null && !c} onClick=${() => tapSquare(i)} />`;
      })}
    <//>

    ${isPlayer && !over && backupCount(game) > 0 && html`<${BackupTray} backups=${myBackups || []} swapIdx=${swapIdx} setSwapIdx=${setSwapIdx} canUse=${true} />`}

    ${open !== null && html`<${SquareModal}
      item=${game.items[open]}
      photoId=${openClaim?.photo} found=${!!openClaim} thumb=${openClaim?.photo && thumbs[openClaim.photo]?.thumb}
      by=${openClaim && playersById[openClaim.by]} at=${openClaim?.at}
      canAct=${isPlayer && (openClaim ? openClaim.by === me.id && !openClaim.photo : !over)}
      actionLabel=${openClaim ? 'Add a photo' : coop ? 'Snap it for the team' : 'Snap it to claim'}
      onFile=${claim} onNoPhoto=${!openClaim ? () => claim(null) : null}
      onRemove=${openClaim?.by === me.id && !over ? unclaim : null} removeLabel=${coop ? 'Unmark square' : 'Undo my claim'}
      onEdit=${isPlayer && !over && !openClaim ? editSquare : null}
      onReroll=${isPlayer && !over && !openClaim && canReroll(game, game.rerolls?.[me.id]) ? reroll : null} rerolls=${game.rerolls?.[me.id] || 0}
      onBlock=${isPlayer && !over && !openClaim ? block : null}
      note=${!openClaim && over ? 'Game over.' : !openClaim && !isPlayer ? `Join the game to ${coop ? 'help out' : 'claim squares'}.` : null}
      onClose=${() => setOpen(null)} />`}
  `;
}

// ───────────────────────── crossover: empty board ─────────────────────────

const EMPTY_ITEM = { icon: '', text: '', cat: 'empty', tier: 'free' };

function PlaceGame({ game, me, playersById, thumbs, isPlayer, onRematch }) {
  const [open, setOpen] = useState(null); // board square being viewed
  const [handIdx, setHandIdx] = useState(null); // hand card being snapped
  const celebrate = useCelebrate(game.winner);

  const coop = !!game.coop;
  const total = game.size * game.size;
  const counts = G.versusCounts(game);
  const placed = Object.keys(game.claims || {}).length;
  const over = !!game.winner;
  const winLine = !coop && game.winner && game.winner !== 'draw' ? G.versusWinLine(game, game.winner) : null;
  const winCells = new Set(winLine || []);
  const hand = game.hands?.[me.id] || [];
  const pending = game.pending?.[me.id];
  const name = (pid) => (pid === me.id ? 'You' : firstName(playersById[pid]));

  const tx = (fn) => store.transact('games', game.code, (g) => (!g || g.winner ? undefined : fn(g) === false ? undefined : g));

  // 1) Snap a card from your hand: it waits as "pending" until you place it, and you get a whole new hand.
  const snap = async (idx, file) => {
    const card = hand[idx];
    const photo = file ? await uploadPhoto(file, game.code, me.id) : null;
    const res = await tx((g) => {
      const old = g.hands?.[me.id] || [];
      if (g.pending?.[me.id] || old[idx]?.text !== card.text) return false;
      g.pending = { ...g.pending, [me.id]: { item: card, photo, at: Date.now() } };
      g.hands = { ...g.hands, [me.id]: [] }; // free the old cards so the new hand can be anything
      g.hands = { ...g.hands, [me.id]: drawHand(g, handSize(g), old.map((it) => it.text)) };
    });
    setHandIdx(null);
    if (!res.ok) toast('Place your last find before snapping another.', 'error');
    else toast('Got it! Now tap an empty square to place it. You have a fresh hand.', 'good');
  };

  // 2) Place the pending find on an empty square.
  const placeAt = async (i) => {
    const res = await tx((g) => {
      const p = g.pending?.[me.id];
      if (!p || g.items[i] || g.claims?.[i]) return false;
      g.items[i] = p.item;
      g.claims = { ...g.claims, [i]: { by: me.id, photo: p.photo, at: Date.now() } };
      const pend = { ...g.pending }; delete pend[me.id]; g.pending = pend;
      const full = Object.keys(g.claims).length === g.size * g.size;
      if (g.coop) { if (full) g.winner = 'team'; }
      else if (G.versusWinLine(g, me.id)) g.winner = me.id;
      else if (full) {
        const c = G.versusCounts(g);
        const best = Math.max(...Object.values(c));
        const leaders = Object.keys(c).filter((k) => c[k] === best);
        g.winner = leaders.length === 1 ? leaders[0] : 'draw';
      }
      if (g.winner) g.wonAt = Date.now();
    }).catch((e) => { toast(`Placing needs a connection: ${e.message}`, 'error'); return null; });
    if (res && !res.ok) toast('Someone just took that square. Pick another.', 'error');
  };

  // Changed your mind: the find goes back into your hand.
  const unpend = async () => {
    await tx((g) => {
      const p = g.pending?.[me.id];
      if (!p) return false;
      g.hands = { ...g.hands, [me.id]: [p.item, ...(g.hands?.[me.id] || []).slice(0, handSize(g) - 1)] };
      const pend = { ...g.pending }; delete pend[me.id]; g.pending = pend;
    });
  };

  const swapCard = async (idx, choice, counted) => {
    const card = hand[idx];
    await tx((g) => {
      const h = (g.hands?.[me.id] || []).slice();
      if (h[idx]?.text !== card.text) return false;
      const it = choice && !placeUsed(g).includes(choice.text) ? choice : drawHand(g, 1, [card.text])[0];
      if (!it) return false;
      h[idx] = it;
      g.hands = { ...g.hands, [me.id]: h };
      if (counted) g.rerolls = { ...g.rerolls, [me.id]: (g.rerolls?.[me.id] || 0) + 1 };
    }).catch((e) => toast(`Swapping needs a connection: ${e.message}`, 'error'));
  };

  // Whole-hand reroll: a fresh set of cards, counted as one reroll.
  const rerollHand = async () => {
    const res = await tx((g) => {
      const old = g.hands?.[me.id] || [];
      if (g.pending?.[me.id]) return false;
      g.hands = { ...g.hands, [me.id]: [] };
      g.hands = { ...g.hands, [me.id]: drawHand(g, handSize(g), old.map((it) => it.text)) };
      g.rerolls = { ...g.rerolls, [me.id]: (g.rerolls?.[me.id] || 0) + 1 };
    });
    if (!res.ok) toast('Place your find before rerolling your hand.', 'error');
  };

  const tapSquare = (i) => {
    if (game.claims?.[i]) return setOpen(i);
    if (over || !isPlayer) return;
    if (pending) return placeAt(i);
    toast('Snap something from your hand first, then place it here.');
  };

  const winner = game.winner && game.winner !== 'draw' && game.winner !== 'team' ? playersById[game.winner] : null;
  const openClaim = open !== null ? game.claims?.[open] : null;
  const card = handIdx !== null ? hand[handIdx] : null;

  return html`
    ${celebrate && html`<${Confetti} />`}
    <div class="game-info"><span>${game.size}×${game.size} · Empty board · ${coop ? 'Co-op: fill the board' : `${game.connect} in a row wins`}${mixTag(game)}${tiersTag(game)}</span><${RerollPill} game=${game} n=${game.rerolls?.[me.id] || 0} show=${isPlayer} /></div>
    ${over && html`<${WinBanner}
      text=${game.winner === 'ended' ? 'GAME OVER' : game.winner === 'team' ? 'TEAM BLACKOUT!' : game.winner === 'draw' ? "IT'S A DRAW!" : game.winner === me.id ? 'YOU WIN!' : `${firstName(winner).toUpperCase()} WINS!`}
      sub=${game.endedEarly ? (coop ? 'Game ended early.' : 'Game ended early: most squares wins.') : coop ? `All ${total} squares filled together!` : !winLine && game.winner !== 'draw' ? 'Board full: most squares wins.' : null}
      onRematch=${onRematch} />`}
    ${coop && html`<div class="team-progress">
      <div class="bar"><span style=${`width:${(placed / total) * 100}%`}></span></div>
      <b>${placed} / ${total} placed</b>
    </div>`}
    <div class="scoreboard">
      ${game.players.map((pid) => {
        const p = playersById[pid];
        return html`<div class="score versus" key=${pid} style=${`--claim:${playerColor(p)}`}>
          <${Emblem} id=${p?.emblem} size=${34} />
          <span class="nm">${name(pid)}${game.winner === pid ? html` ${ic('trophy')}` : ''}</span>
          <span class="pts">${counts[pid] || 0} placed${game.pending?.[pid] ? html` · ${ic('camera')} 1 ready` : ''}</span>
        </div>`;
      })}
    </div>

    ${pending && !over && html`<div class="banner place-banner">
      <span class="grow">${ic('pin')} Tap an empty square to place <b>${pending.item.text}</b></span>
      <button class="btn small ghost" onClick=${unpend}>Put back</button>
    </div>`}

    <${Board} size=${game.size}>
      ${game.items.map((item, i) => {
        const c = game.claims?.[i];
        if (!item || !c) return html`<button class=${'tile empty' + (pending && !over ? ' swap-target' : '')} key=${i} onClick=${() => tapSquare(i)}
          aria-label="Empty square"><span class="plus">${pending && !over ? ic('pin') : '+'}</span></button>`;
        const p = playersById[c.by];
        return html`<${Tile} key=${i} item=${item} thumb=${c.photo && (thumbs[c.photo]?.thumb || PLACEHOLDER)} found=${true}
          stamp=${p?.emblem} claimColor=${p && playerColor(p)} win=${winCells.has(i)} onClick=${() => tapSquare(i)} />`;
      })}
    <//>

    ${isPlayer && !over && html`<section class="hand">
      <div class="hand-head">
        <h3>Your hand <small>${pending ? '· place your find first' : '· tap one to snap it'}</small></h3>
        ${canReroll(game, game.rerolls?.[me.id]) && html`<button class="btn small ghost" disabled=${!!pending} onClick=${rerollHand}>${ic('dice')} Reroll hand</button>`}
      </div>
      <div class="hand-grid">
        ${hand.map((it, idx) => html`<button class=${`hand-card cat-${it.cat}`} key=${it.text} disabled=${!!pending} onClick=${() => setHandIdx(idx)}>
          <span class="icon">${itemIcon(it.icon)}</span><span class="txt">${it.text}</span><span class="stars">${TIER_STARS[it.tier]}</span>
        </button>`)}
      </div>
    </section>`}

    ${card && html`<${SquareModal} item=${card} found=${false} canAct=${!pending && !over} actionLabel="Snap it"
      onFile=${(f) => snap(handIdx, f)} onNoPhoto=${() => snap(handIdx, null)}
      onBlock=${() => { blockItem(card.text); swapCard(handIdx, null, false); setHandIdx(null); }}
      onClose=${() => setHandIdx(null)} />`}
    ${openClaim && html`<${SquareModal} item=${game.items[open]} photoId=${openClaim.photo} found=${true}
      thumb=${openClaim.photo && thumbs[openClaim.photo]?.thumb} by=${playersById[openClaim.by]} at=${openClaim.at}
      canAct=${false} onClose=${() => setOpen(null)} />`}
  `;
}

// ───────────────────────── endless ─────────────────────────

const findCount = (g) => (g.history || []).filter(G.isFind).length;
const endlessTiers = () => [['any', ic('dice'), 'Surprise'], ['e', '★', '1 pt'], ['m', '★★', '2 pts'], ['h', '★★★', '3 pts']];

function EndlessGame({ game, me, playersById, thumbs, isPlayer, onRematch }) {
  const [open, setOpen] = useState(null); // history index being viewed
  const [snapId, setSnapId] = useState(null); // slot open in the snap sheet (multi-slot layout)
  const [busy, setBusy] = useState(false);
  const celebrate = useCelebrate(game.winner);

  const st = G.endlessState(game);
  const scores = G.endlessScores(game);
  const over = !!game.winner;
  const turns = st.turnMode === 'turns';
  const canSnap = isPlayer && !over && (!turns || st.turn === me.id);
  const name = (pid) => (pid === me.id ? 'You' : firstName(playersById[pid]));
  const [histF, setHistF] = useState([]); // filter for "Everything so far"
  const histKind = (h) => (G.isFind(h) ? (h.photo ? 'photo' : 'found') : h.rerolled ? 'rerolled' : h.expired ? 'expired' : h.blocked ? 'blocked' : 'skipped');
  const allHistory = (game.history || []).map((h, i) => ({ ...h, i })).reverse();
  const history = histF.length ? allHistory.filter((h) => histF.includes(histKind(h))) : allHistory;
  const pts = (it) => G.ENDLESS_POINTS[it.tier] || 1;

  // Runs fn(state, g) inside a transaction on the normalized slot state; fn returns false to abort.
  const update = (fn) => store.transact('games', game.code, (g) => {
    if (!g || g.winner) return undefined;
    const s2 = G.endlessState(g);
    s2.active = s2.active.map((a) => ({ ...a }));
    if (fn(s2, g) === false) return undefined;
    return G.withEndlessState(g, s2);
  });
  const slotOf = (s2, id) => s2.active.find((a) => a.id === id);

  const capture = async (slot, file) => {
    setBusy(true);
    let photo = null;
    try { photo = file ? await uploadPhoto(file, game.code, me.id) : null; } finally { setBusy(false); }
    const res = await update((s2, g) => {
      const a = slotOf(s2, slot.id);
      if (!a?.item || a.item.text !== slot.item.text) return false;
      if (s2.turnMode === 'turns' && s2.turn !== me.id) return false;
      const now = Date.now();
      g.history = [...(g.history || []), { item: a.item, by: me.id, photo, at: now }];
      Object.keys(a).forEach((k) => k !== 'id' && delete a[k]);
      a.pick = { by: me.id };
      // Every other item that's still up has now watched one more find; stale ones get swapped out.
      for (const o of s2.active) {
        if (!o.item) continue;
        o.seen = (o.seen || 0) + 1;
        if (o.seen < G.ENDLESS_EXPIRE_AFTER) continue;
        const exclude = [...g.history.map((h) => h.item.text), ...s2.active.filter((x) => x.item).map((x) => x.item.text)];
        const it = G.drawEndless(poolFor({ cats: o.cats, mix: o.mix, mineOnly: g.mineOnly }), { tier: o.tier || 'any', exclude });
        if (!it) continue;
        g.history.push({ item: o.item, expired: true, at: now });
        Object.assign(o, { item: it, seen: 0, at: now });
      }
      if (s2.turnMode === 'turns') s2.turn = G.nextPlayer(g, me.id);
    });
    setSnapId(null);
    if (!res.ok) return toast(turns ? "It's not your turn." : 'Someone got that one first!', 'error');
    toast(`+${pts(slot.item)} pt${pts(slot.item) === 1 ? '' : 's'}!`, 'good');
  };

  const usedTexts = (g, s2) => [...(g.history || []).map((h) => h.item.text), ...s2.active.filter((x) => x.item).map((x) => x.item.text)];
  // Replaces a slot's item with `choice` (or a random same-star one) and logs why it left.
  const swapSlot = async (slot, choice, why) => {
    const res = await update((s2, g) => {
      const a = slotOf(s2, slot.id);
      if (!a?.item || a.item.text !== slot.item.text || (s2.turnMode === 'turns' && s2.turn !== me.id)) return false;
      const used = usedTexts(g, s2);
      const it = choice && !used.includes(choice.text) ? choice
        : G.drawEndless(poolFor({ cats: a.cats, mix: a.mix, mineOnly: g.mineOnly }).filter((x) => x.text !== a.item.text), { tier: a.item.tier, exclude: used });
      if (!it) return false;
      g.history = [...(g.history || []), { item: a.item, by: me.id, [why]: true, at: Date.now() }];
      a.item = it;
      a.seen = 0;
      if (why === 'rerolled') g.rerolls = { ...g.rerolls, [me.id]: (g.rerolls?.[me.id] || 0) + 1 };
    }).catch((e) => { toast(`Swapping needs a connection: ${e.message}`, 'error'); return null; });
    if (res && !res.ok) toast(turns && st.turn !== me.id ? "It's not your turn." : 'That item just changed. Try again.', 'error');
  };
  const reroll = (slot) => swapSlot(slot, null, 'rerolled');
  const block = (slot) => { blockItem(slot.item.text); swapSlot(slot, null, 'blocked'); };

  const deal = async (slot, tier, cats) => {
    const res = await update((s2, g) => {
      const a = slotOf(s2, slot.id);
      if (!a?.pick) return false;
      const exclude = [...(g.history || []).map((h) => h.item.text), ...s2.active.filter((x) => x.item).map((x) => x.item.text)];
      const item = G.drawEndless(poolFor({ cats, mineOnly: g.mineOnly }), { tier, exclude });
      if (!item) return false;
      delete a.pick;
      Object.assign(a, { item, tier, cats, seen: 0, at: Date.now() });
      delete a.mix;
      g.lastPick = { tier, cats };
    }).catch((e) => { toast(`Dealing needs a connection: ${e.message}`, 'error'); return null; });
    if (res && !res.ok && slotOf(G.endlessState(res.data || game), slot.id)?.pick) toast('No items match those settings. Try more categories.', 'error');
  };


  const winner = game.winner && game.winner !== 'draw' ? playersById[game.winner] : null;
  const viewing = open !== null ? game.history[open] : null;
  const single = st.active.length === 1;
  const snapSlot = snapId && st.active.find((a) => a.id === snapId && a.item);

  return html`
    ${celebrate && html`<${Confetti} />`}
    <div class="game-info"><span>Endless · ${findCount(game)} find${findCount(game) === 1 ? '' : 's'} · ${st.slots} active · ${turns ? 'Taking turns' : 'Anyone snaps'}${mixTag(game)}</span><${RerollPill} game=${game} n=${game.rerolls?.[me.id] || 0} show=${isPlayer} /></div>
    ${over && html`<${WinBanner}
      text=${game.winner === 'draw' ? "IT'S A TIE!" : game.winner === me.id ? 'YOU WIN!' : `${firstName(winner).toUpperCase()} WINS!`}
      sub="Most points when the game ended." onRematch=${onRematch} />`}

    <div class="scoreboard">
      ${game.players.map((pid) => {
        const p = playersById[pid];
        const sc = scores[pid] || { points: 0, finds: 0 };
        return html`<div class=${'score' + (turns && pid === st.turn && !over ? ' sel' : '')} key=${pid}>
          <${Emblem} id=${p?.emblem} size=${34} />
          <span class="nm">${name(pid)}${game.winner === pid ? html` ${ic('trophy')}` : ''}</span>
          <span class="pts">${sc.points} pt${sc.points === 1 ? '' : 's'} · ${sc.finds} found${game.rerolls?.[pid] ? html` · ${ic('dice')}${game.rerolls[pid]}` : ''}</span>
        </div>`;
      })}
    </div>

    ${!over && html`
      <p class="turn-line">${!turns ? (isPlayer ? html`${ic('zap')} Anyone can snap. First one gets it!` : 'Anyone in the game can snap.')
        : st.turn === me.id ? html`${ic('target')} Your turn!` : html`<${Emblem} id=${playersById[st.turn]?.emblem} size=${22} /> ${name(st.turn)}'s turn`}</p>
      <div class=${'endless-slots' + (single ? ' single' : '')}>
        ${st.active.map((slot) => slot.pick
          ? html`<${PickSlot} key=${slot.id} slot=${slot} game=${game} me=${me} isPlayer=${isPlayer} name=${name} onDeal=${deal} />`
          : html`<div class=${'endless-slot' + (canSnap && !single ? ' quick' : '')} key=${slot.id}>
            <button class=${`endless-card cat-${slot.item.cat}${single ? '' : ' compact'}`} disabled=${single || !canSnap} onClick=${() => setSnapId(slot.id)}>
              <span class="stars">${TIER_STARS[slot.item.tier]}</span>
              <span class="icon">${itemIcon(slot.item.icon)}</span>
              <h2>${slot.item.text}</h2>
              <small>${catLabel(slot.item.cat)} · ${pts(slot.item)} pt${pts(slot.item) === 1 ? '' : 's'}</small>
            </button>
            ${canSnap && (single ? html`<div class="endless-actions">
              <${PhotoButtons} label="Snap it" onFile=${(f) => capture(slot, f).catch((e) => toast(e.message, 'error'))} />
              <${IconTools} tools=${[
                [ic('checkCircle', 22), 'No photo', () => capture(slot, null).catch((e) => toast(e.message, 'error'))],
                canReroll(game, game.rerolls?.[me.id]) && [ic('dice', 22), `Reroll${game.rerolls?.[me.id] ? ` (${game.rerolls[me.id]})` : ''}`, () => reroll(slot)],
                [ic('ban', 22), 'Block', () => confirmBlock(slot.item.text) && block(slot)],
              ]} />
            </div>` : html`<${QuickSnap} onFile=${(f) => capture(slot, f).catch((e) => toast(e.message, 'error'))} />`)}
          </div>`)}
      </div>
      ${turns && isPlayer && st.turn !== me.id && html`<p class="muted center">Waiting for ${name(st.turn)} to snap one…</p>`}
    `}

    ${allHistory.length > 0 && html`<section class="panel">
      <div class="panel-head hist-head">
        <h2>Everything so far</h2>
        <${MultiSelect} label="Filter history" allLabel="Show all" noun="kinds" value=${histF} onChange=${setHistF}
          options=${[{ value: 'photo', label: 'With photos' }, { value: 'found', label: 'Found, no photo' }, { value: 'rerolled', label: 'Rerolled' },
            { value: 'expired', label: 'Swapped out' }, { value: 'blocked', label: 'Blocked' }]} />
      </div>
      ${!history.length && html`<p class="muted small">Nothing matches this filter.</p>`}
      <div class="endless-history">
        ${history.map((h) => {
          const found = G.isFind(h);
          const who = h.by ? html`<${Emblem} id=${playersById[h.by]?.emblem} size=${16} /> ${name(h.by)} · ` : '';
          const what = found ? `${TIER_STARS[h.item.tier]} +${pts(h.item)}`
            : h.rerolled ? html`${ic('dice')} Rerolled` : h.blocked ? html`${ic('ban')} Blocked` : h.expired ? html`${ic('hourglass')} Swapped out after ${G.ENDLESS_EXPIRE_AFTER} other finds` : 'Skipped';
          return html`<button class=${'hist-row' + (found ? '' : ' skipped')} key=${h.i} onClick=${() => setOpen(h.i)}>
            ${h.photo && thumbs[h.photo] ? html`<img src=${thumbs[h.photo].thumb} alt="" />` : html`<span class=${`hist-icon cat-${h.item.cat}`}>${itemIcon(h.item.icon)}</span>`}
            <span class="grow"><b>${h.item.text}</b><small>${who}${what}</small></span>
          </button>`;
        })}
      </div>
    </section>`}

    ${busy && html`<div class="busy"><div class="spinner"></div>Uploading…</div>`}

    ${snapSlot && html`<${SquareModal} item=${snapSlot.item} found=${false} canAct=${canSnap} actionLabel="Snap it"
      onFile=${(f) => capture(snapSlot, f)} onNoPhoto=${() => capture(snapSlot, null)}
      onReroll=${canSnap && canReroll(game, game.rerolls?.[me.id]) ? () => reroll(snapSlot) : null} rerolls=${game.rerolls?.[me.id] || 0}
      onBlock=${canSnap ? () => { block(snapSlot); setSnapId(null); } : null}
      onClose=${() => setSnapId(null)} />`}
    ${viewing && (() => {
      // Sheet walks the list in display order (newest first): swipe left goes down the list.
      const k = history.findIndex((h) => h.i === open);
      const found = G.isFind(viewing);
      const why = viewing.rerolled ? 'Rerolled' : viewing.blocked ? 'Blocked' : viewing.expired ? `Swapped out after ${G.ENDLESS_EXPIRE_AFTER} other finds` : 'Skipped';
      return html`<${SquareModal} key=${open} item=${viewing.item} photoId=${viewing.photo} found=${found}
        thumb=${viewing.photo && thumbs[viewing.photo]?.thumb} by=${found ? playersById[viewing.by] : null} at=${viewing.at}
        note=${found ? null : `${why}${viewing.by ? ` by ${name(viewing.by)}` : ''}`}
        position=${`${k + 1} of ${history.length}`}
        prefetch=${[history[k - 1]?.photo, history[k + 1]?.photo]}
        onPrev=${k > 0 ? () => setOpen(history[k - 1].i) : null}
        onNext=${k < history.length - 1 ? () => setOpen(history[k + 1].i) : null}
        canAct=${false} onClose=${() => setOpen(null)} />`;
    })()}
  `;
}

/** An empty endless slot: choose difficulty + type, then deal the replacement item. */
function PickSlot({ slot, game, me, isPlayer, name, onDeal }) {
  const [tier, setTier] = useState(game.lastPick?.tier || 'any');
  const [cats, setCats] = useState(game.lastPick?.cats || game.cats || ALL_CATS);
  const mine = slot.pick.by === me.id;
  return html`<section class="panel pick-panel">
    <h2>${mine ? 'You found it! Pick the next item' : `${name(slot.pick.by)} is picking the next item`}</h2>
    ${isPlayer ? html`
      ${!mine && html`<p class="muted small">Anyone can pick if they're busy.</p>`}
      ${!hideStars && html`<h3>Difficulty</h3>
      <${Choice} grid value=${tier} onChange=${setTier} options=${endlessTiers()} />`}
      <h3>Categories</h3>
      <${CatPicker} value=${cats} onChange=${setCats} />
      <button class="btn primary huge" disabled=${!cats.length} onClick=${() => onDeal(slot, hideStars ? 'any' : tier, someCats(cats) || null)}>
        ${cats.length ? html`${ic('cards')} Deal it!` : 'Pick a category'}</button>`
    : html`<p class="muted">Join the game to play.</p>`}
  </section>`;
}

// ───────────────────────── app shell ─────────────────────────

function App() {
  const route = useHash();
  const [, setPrefsTick] = useState(0);
  useEffect(() => {
    const bump = () => setPrefsTick((n) => n + 1);
    addEventListener('nycc:prefs', bump);
    return () => removeEventListener('nycc:prefs', bump);
  }, []);
  const players = useWatch((cb) => store.watchAll('players', cb), []);
  const [meId, setMeId] = useState(loadMe);
  const playersById = useMemo(() => Object.fromEntries((players || []).map((p) => [p.id, p])), [players]);
  const me = meId ? playersById[meId] : null;
  const bank = useWatch((cb) => store.watchDoc('settings', BANK_ID, cb), []);
  itemPool = useMemo(() => G.buildPool(bank), [bank]);

  const pick = (id) => { saveMe(id); setMeId(id); if (route[0] === 'profile') go('/'); };
  const switchPlayer = () => { saveMe(''); setMeId(null); };

  let body;
  if (players === undefined) body = html`<main class="screen"><p class="muted center">Loading…</p></main>`;
  else if (!me || route[0] === 'profile') body = html`<${ProfileScreen} players=${players} me=${me} onPick=${pick} onSwitch=${switchPlayer} />`;
  else if (route[0] === 'settings') body = html`<${SettingsScreen} me=${me} />`;
  else if (route[0] === 'collage') body = html`<${CollageScreen} me=${me} playersById=${playersById} />`;
  else if (route[0] === 'stats') body = html`<${StatsScreen} me=${me} players=${players} playersById=${playersById} focus=${route[1]} key=${route[1] || 'all'} />`;
  else if (route[0] === 'items') body = html`<${ItemsScreen} bank=${bank} />`;
  else if (route[0] === 'new') body = html`<${NewGame} mode=${['versus', 'endless'].includes(route[1]) ? route[1] : 'bingo'} me=${me} players=${players} key=${route[1]} />`;
  else if (route[0] === 'g' && route[1]) body = html`<${GameScreen} code=${route[1].toUpperCase()} me=${me} playersById=${playersById} key=${route[1]} />`;
  else body = html`<${Home} me=${me} playersById=${playersById} />`;

  return html`${body}<${SyncIndicator} /><${StuckBanner} /><${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
