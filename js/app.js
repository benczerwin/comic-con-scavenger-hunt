import { html, render, useState, useEffect, useMemo, useRef, createContext, useContext } from '../vendor/htm-preact.js';
import * as store from './store.js';
import { EMBLEMS, emblemById, emblemSVG } from './data/emblems.js';
import { CATEGORY_LABELS, ITEMS, itemKind } from './data/items.js';
import * as G from './game.js';
import { processPhoto } from './photo.js';
import { renderRecap, renderCollage } from './recap.js';

// ───────────────────────── helpers & hooks ─────────────────────────

const ME_KEY = 'nycc-hunt:me';
const loadMe = () => { try { return localStorage.getItem(ME_KEY); } catch { return null; } };
const saveMe = (id) => { try { localStorage.setItem(ME_KEY, id); } catch {} };

const go = (path) => { location.hash = path; };
const gameUrl = (code) => `${location.origin}${location.pathname}#/g/${code}`;

function useHash() {
  const parse = () => location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => { setRoute(parse()); window.scrollTo(0, 0); };
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
const toast = (msg, kind = 'info') => pushToast({ msg, kind, id: Math.random() });

function Toasts() {
  const [items, setItems] = useState([]);
  pushToast = (t) => {
    setItems((xs) => [...xs, t]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), 3200);
  };
  return html`<div class="toasts">${items.map((t) => html`<div class="toast ${t.kind}" key=${t.id}>${t.msg}</div>`)}</div>`;
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

const MIXES = {
  all: { label: 'Everything', blurb: 'Every kind of item' },
  char: { label: 'Characters only', blurb: 'Characters, shows & movies', short: 'Characters' },
  obj: { label: 'Fandom gear', blurb: 'Like a Pokémon bag', short: 'Fandom gear' },
};
const mixOf = (g) => g.mix || (g.charsOnly ? 'char' : 'all'); // charsOnly: games made before mixes existed
const poolFor = (g) => { const m = mixOf(g); return m === 'all' ? itemPool : itemPool.filter((it) => itemKind(it) === m); };
const mixTag = (g) => (MIXES[mixOf(g)]?.short ? ` · ${MIXES[mixOf(g)].short}` : '');
const BANK_ID = 'itemBank';

async function uniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = G.makeCode();
    if (!(await store.getOne('games', code))) return code;
  }
  return G.makeCode(5);
}

function makeBoard(game, pid) {
  const card = game.card || G.generateCard({ size: game.size, difficulty: game.difficulty, freeCenter: game.freeCenter, pool: poolFor(game) });
  return {
    gameId: game.code, playerId: pid, size: game.size,
    items: card.items, backups: card.backups, marks: {}, createdAt: Date.now(),
  };
}

function versusBackups(game) {
  return G.generateCard({ size: game.size, difficulty: game.difficulty, exclude: game.items.map((i) => i.text), pool: poolFor(game) }).backups;
}

async function createGame(settings, createdBy) {
  const code = await uniqueCode();
  const base = {
    code, mode: settings.mode, size: settings.size, difficulty: settings.difficulty,
    players: settings.players, mix: settings.mix || 'all', createdBy, createdAt: Date.now(), winner: null,
  };
  const fail = (e) => toast(`Sync problem: ${e.message}`, 'error');
  if (settings.mode === 'endless') {
    const tier = settings.tier || 'any';
    const slots = settings.slots || 1;
    const active = [];
    for (let k = 0; k < slots; k++) {
      const item = G.drawEndless(poolFor(settings), { tier, exclude: active.map((a) => a.item.text) });
      if (!item) throw new Error('No items turned on for that mix.');
      active.push({ id: G.uid(), item, tier, mix: base.mix, at: Date.now() });
    }
    const turnMode = settings.turnMode || 'any';
    const game = {
      ...base, size: null, history: [], rerolls: {}, lastPick: { tier, mix: base.mix },
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
        ? G.generateCard({ size: settings.size, difficulty: settings.difficulty, freeCenter: settings.freeCenter, pool: poolFor(settings) })
        : null,
    };
    store.put('games', code, game).catch(fail);
    for (const pid of game.players) store.put('boards', `${code}_${pid}`, makeBoard(game, pid)).catch(fail);
  } else {
    const card = G.generateCard({ size: settings.size, difficulty: settings.difficulty, pool: poolFor(settings) });
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
  mode: g.mode, size: g.size, difficulty: g.difficulty, players: g.players,
  winRule: g.winRule, minutes: g.minutes || 60, freeCenter: g.freeCenter, sameCard: g.sameCard, connect: g.connect, coop: !!g.coop, mix: mixOf(g), tier: g.lastPick?.tier,
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
  return html`
    <div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal">
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
  const [code, setCode] = useState('');
  const sorted = (games || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  const [day, setDay] = useState('all');
  const [who, setWho] = useState('all');
  const dayKey = (t) => new Date(t).toDateString();
  const days = [...new Set(sorted.map((g) => dayKey(g.createdAt)))];
  const people = [...new Set(sorted.flatMap((g) => g.players))].filter((pid) => playersById[pid]);
  const shown = sorted.filter((g) => (day === 'all' || dayKey(g.createdAt) === day) && (who === 'all' || g.players.includes(who)));

  const join = (e) => {
    e.preventDefault();
    const c = code.trim().toUpperCase().replace(/^NYCC-?/, '');
    if (c) go(`/g/${c}`);
  };

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
          <div class="burst">SOLO!</div>
          <h2>Solo Series</h2>
          <p>Everyone gets their own board. Snap photos, complete lines, win.</p>
        </a>
        <a class="mode-card versus" href="#/new/versus">
          <div class="burst">X-OVER!</div>
          <h2>Crossover</h2>
          <p>Everyone on one shared board. Race to claim squares, or team up to fill it.</p>
        </a>
        <a class="mode-card endless" href="#/new/endless">
          <div class="burst">∞!</div>
          <h2>Endless</h2>
          <p>One item at a time. Take turns, reroll if you're stuck, and pick what your friend hunts next.</p>
        </a>
      </section>

      <form class="panel join" onSubmit=${join}>
        <h2>Join a game</h2>
        <div class="row">
          <input class="text code" placeholder="CODE" value=${code} maxlength="10"
            onInput=${(e) => setCode(e.target.value.toUpperCase())} />
          <button class="btn primary">Join</button>
        </div>
      </form>

      <section class="panel">
        <div class="panel-head">
          <h2>Your games</h2>
          <a class="round-btn small" href="#/collage" aria-label="Make a collage" title="Make a collage">${COLLAGE_ICON}</a>
        </div>
        ${games === undefined && html`<p class="muted">Loading…</p>`}
        ${games && !sorted.length && html`<p class="muted">No games yet. Start one above!</p>`}
        ${sorted.length > 1 && html`<div class="row game-filters">
          <select class="text small-select" value=${day} onChange=${(e) => setDay(e.target.value)} aria-label="Filter by date">
            <option value="all">All dates</option>
            ${days.map((d) => html`<option value=${d}>${dayLabel(d)}</option>`)}
          </select>
          <select class="text small-select" value=${who} onChange=${(e) => setWho(e.target.value)} aria-label="Filter by player">
            <option value="all">Everyone</option>
            ${people.map((pid) => html`<option value=${pid}>${pid === me.id ? 'Me' : playersById[pid].name}</option>`)}
          </select>
        </div>`}
        <div class="game-list">
          ${shown.map((g) => html`<${GameRow} key=${g.code} g=${g} playersById=${playersById} href=${`#/g/${g.code}`}
            onDelete=${() => confirmDelete(g.code)} />`)}
        </div>
        ${sorted.length > 0 && !shown.length && html`<p class="muted center">No games match.</p>`}
      </section>
    </main>`;
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
    <li><b>Endless:</b> 1–3 items are up at a time. Snap one to score (★ = 1 pt, ★★ = 2, ★★★ = 3), then pick the difficulty and type of the next item. An item that sits while 2 others get found swaps itself out.</li>
    <li><b>Backups:</b> in Solo Series and Crossover you get 1–3 backup items. Tap a backup, then tap an unmarked square to swap it in.</li>
    <li><b>🎲 Reroll:</b> swap any item for another one with the same stars. Rerolls are counted in the stats.</li>
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
        <span class="icon">📝</span>
        <span class="grow"><b>Edit hunt items</b><small>${itemPool.length} items on · Turn ideas off or add your own</small></span>
        <span>›</span>
      </a>
      <section class="panel">
        <h2>How to play</h2>
        <${HowToPlay} />
      </section>
    </main>`;
}

function Choice({ options, value, onChange }) {
  return html`<div class="choice">
    ${options.map(([v, label, sub]) => html`
      <button class=${value === v ? 'sel' : ''} onClick=${() => onChange(v)}>
        <b>${label}</b>${sub && html`<small>${sub}</small>`}
      </button>`)}
  </div>`;
}

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
  const [mix, setMix] = useState('all');
  const [selected, setSelected] = useState([me.id]);
  const [busy, setBusy] = useState(false);

  useEffect(() => setConnect(G.defaultConnect(size)), [size]);

  const toggle = (pid) => {
    if (pid === me.id) return;
    setSelected((s) => (s.includes(pid) ? s.filter((x) => x !== pid) : [...s, pid]));
  };

  const create = async () => {
    setBusy(true);
    try {
      const code = await createGame({ mode, size, difficulty, winRule, minutes, freeCenter, sameCard, connect, coop, mix, tier, slots, turnMode, players: selected }, me.id);
      go(`/g/${code}`);
    } catch (e) {
      toast(`Couldn't create game: ${e.message}`, 'error');
      setBusy(false);
    }
  };

  const nb = G.backupsFor(size);
  const pool = poolFor({ mix });
  const tooFew = isEndless ? !pool.length : pool.length < size * size + nb;
  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/">‹ Home</a></nav>
      <h1 class="title">${isBingo ? 'New Solo Series' : isEndless ? 'New Endless Hunt' : 'New Crossover'}</h1>

      ${isEndless ? html`<section class="panel">
        <h2>What kind of items?</h2>
        <${Choice} value=${mix} onChange=${setMix}
          options=${Object.entries(MIXES).map(([k, m]) => [k, m.label, m.blurb])} />
        <h2>Items active at once</h2>
        <${Choice} value=${slots} onChange=${setSlots} options=${[[1, '1', 'One at a time'], [2, '2', 'Two to hunt'], [3, '3', 'Three to hunt']]} />
        <h2>Who can snap?</h2>
        <${Choice} value=${turnMode} onChange=${setTurnMode}
          options=${[['any', 'Anyone', 'First to snap an item gets the points'], ['turns', 'Take turns', 'Players go one at a time']]} />
        <h2>Starting difficulty</h2>
        <${Choice} value=${tier} onChange=${setTier} options=${ENDLESS_TIERS} />
        <p class="muted small">Whoever snaps an item picks the difficulty and type of the one that replaces it.</p>
      </section>` : html`<section class="panel">
        <h2>Board size</h2>
        <${Choice} value=${size} onChange=${setSize}
          options=${G.SIZES.map((s) => [s, `${s}×${s}`, `${s * s} squares`])} />
        <p class="muted small">Each player gets <b>${nb} backup${nb > 1 ? 's' : ''}</b> to swap in.</p>

        <h2>What's on the board?</h2>
        <${Choice} value=${mix} onChange=${setMix}
          options=${Object.entries(MIXES).map(([k, m]) => [k, m.label, m.blurb])} />

        <h2>Difficulty</h2>
        <${Choice} value=${difficulty} onChange=${setDifficulty}
          options=${Object.entries(G.DIFFICULTY).map(([k, d]) => [k, d.label, d.blurb])} />

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
          <h2>Game style</h2>
          <${Choice} value=${coop} onChange=${setCoop}
            options=${[[false, 'Race', 'Claim squares, first to get N in a row wins'], [true, 'Co-op', 'Team up and black out the whole board together']]} />
          ${!coop && html`
            <h2>In a row to win</h2>
            <${Choice} value=${connect} onChange=${setConnect}
              options=${Array.from({ length: size - 2 }, (_, i) => i + 3).map((k) => [k, `${k} in a row`])} />`}
        `}
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

      <p class="muted small center">Drawing from <b>${pool.length}</b> hunt items${mix === 'all' ? '' : ` (${MIXES[mix].short.toLowerCase()})`} · <a href="#/items">edit list</a></p>
      ${tooFew && html`<div class="banner warn">Not enough items turned on${isEndless ? '' : ` for a ${size}×${size} board`}. Turn more on in the item list${mix !== 'all' ? ' or pick Everything' : ''}.</div>`}
      <button class="btn primary huge" disabled=${busy || tooFew} onClick=${create}>${busy ? 'Creating…' : 'Start the hunt!'}</button>
    </main>`;
}

// ───────────────────────── game rows ─────────────────────────

const svgIcon = (d, size = 22) => html`<svg viewBox="0 0 24 24" width=${size} height=${size} fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${d} /></svg>`;
// Chunky filled bar chart.
const STATS_ICON = html`<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="currentColor">
  <rect x="3" y="11" width="5" height="10" rx="1.5" /><rect x="9.5" y="4" width="5" height="17" rx="1.5" /><rect x="16" y="8" width="5" height="13" rx="1.5" /></svg>`;
const GEAR_ICON = svgIcon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z');
const PEOPLE_ICON = svgIcon('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8', 20);

// A little stack of photos.
const COLLAGE_ICON = html`<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor"
  stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7 3h11a3 3 0 0 1 3 3v11" /><rect x="3" y="7" width="14" height="14" rx="2.5" />
  <circle cx="8" cy="11.5" r="1.6" fill="currentColor" stroke="none" /><path d="M3.5 19l4.5-4.5 3 3 2-2 3.5 3.5" /></svg>`;

const TRASH_SVG = html`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></svg>`;

const gameDetail = (g) => g.mode === 'endless' ? `${findCount(g)} find${findCount(g) === 1 ? '' : 's'}`
  : `${g.size}×${g.size} · ${g.mode === 'bingo' ? G.WIN_RULES[g.winRule]?.label : g.coop ? 'Team blackout' : `${g.connect} in a row`}`;
const gameResult = (g, playersById) => {
  const w = g.winner && playersById[g.winner];
  return w ? `🏆 ${w.name}` : g.winner === 'draw' ? '🤝 Draw' : g.winner === 'team' ? '🎉 Blacked out' : 'In progress';
};

/** One game in a list. Pass href to make it a link, onClick/selected for picking, onDelete for a trash button. */
function GameRow({ g, playersById, href, onClick, selected, onDelete }) {
  const body = html`
    ${selected !== undefined && html`<span class="check-box">${selected ? '✓' : ''}</span>`}
    <span class="grow">
      <span class="gr-top"><b>${g.code}</b><span class="mode-label ${g.mode}">${modeTag(g)}</span></span>
      <small>${gameDetail(g)}</small>
      <small>${new Date(g.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · ${gameResult(g, playersById)}</small>
    </span>
    <span class="stack">${g.players.slice(0, 4).map((pid) => html`<${Emblem} id=${playersById[pid]?.emblem} size=${28} />`)}</span>`;
  return html`<div class=${`game-card mode-${g.mode}${g.coop ? ' coop' : ''}${selected ? ' sel' : ''}`}>
    ${href ? html`<a class="game-main" href=${href}>${body}</a>` : html`<button class="game-main" onClick=${onClick}>${body}</button>`}
    ${onDelete && html`<button class="icon-btn" aria-label=${`Delete game ${g.code}`} onClick=${onDelete}>${TRASH_SVG}</button>`}
  </div>`;
}

// ───────────────────────── mega collage ─────────────────────────

function CollageScreen({ me, playersById }) {
  const games = useWatch((cb) => store.watchAll('games', cb), []);
  const [picked, setPicked] = useState(() => new Set());
  const [onlyMine, setOnlyMine] = useState(true);
  const [day, setDay] = useState('all');
  const [recap, setRecap] = useState(null);

  const dayKey = (t) => new Date(t).toDateString();
  const mine = (games || []).filter((g) => !onlyMine || g.players?.includes(me.id)).sort((a, b) => b.createdAt - a.createdAt);
  const days = [...new Set(mine.map((g) => dayKey(g.createdAt)))];
  const list = mine.filter((g) => day === 'all' || dayKey(g.createdAt) === day);
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
          <select class="text small-select" value=${day} onChange=${(e) => setDay(e.target.value)} aria-label="Filter by date">
            <option value="all">All dates</option>
            ${days.map((d) => html`<option value=${d}>${dayLabel(d)}</option>`)}
          </select>
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
          🧩 Make collage${chosen.length ? ` (${chosen.length})` : ''}</button>
      </div>
      ${recap && html`<${RecapModal} recap=${recap} code="collage" title="Mega collage" playersById=${playersById} onClose=${close} />`}
    </main>`;
}

// ───────────────────────── player stats ─────────────────────────

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');

function StatsScreen({ me, players, playersById, focus }) {
  const games = useWatch((cb) => store.watchAll('games', cb), []);
  const boards = useWatch((cb) => store.watchAll('boards', cb), []);
  if (games === undefined || boards === undefined) return html`<main class="screen"><p class="muted center">Crunching numbers…</p></main>`;

  const stats = G.playerStats(games, boards);
  const ranked = (players || []).filter((p) => stats[p.id])
    .sort((a, b) => stats[b.id].wins - stats[a.id].wins || stats[b.id].found - stats[a.id].found);

  if (focus && playersById[focus]) return html`<${PlayerStats} p=${playersById[focus]} s=${stats[focus]} me=${me} playersById=${playersById} />`;

  const most = (key) => {
    const top = ranked.slice().sort((a, b) => stats[b.id][key] - stats[a.id][key])[0];
    return top && stats[top.id][key] ? top : null;
  };
  const awards = [
    ['🏆', 'Most wins', most('wins'), 'wins'],
    ['🔍', 'Most finds', most('found'), 'found'],
    ['📸', 'Most photos', most('photos'), 'photos'],
    ['💎', 'Rare hunter (★★★)', ranked.slice().sort((a, b) => stats[b.id].tiers.h - stats[a.id].tiers.h)[0], null],
    ['🎲', 'Reroll addict', most('rerolls'), 'rerolls'],
  ].filter(([, , p]) => p);

  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/">‹ Home</a></nav>
      <h1 class="title">Player stats</h1>
      ${!ranked.length && html`<div class="panel center muted">No games played yet. Go hunt!</div>`}
      ${ranked.length > 1 && html`<section class="panel">
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
        </a>`;
      })}
    </main>`;
}

function PlayerStats({ p, s, me, playersById }) {
  const thumbs = useWatch((cb) => store.watchWhere('thumbs', 'by', '==', p.id, cb), [p.id]);
  if (!s) return html`<main class="screen"><nav class="topbar"><a class="back" href="#/stats">‹ All players</a></nav>
    <div class="panel center muted">${p.name} hasn't played yet.</div></main>`;
  const cats = Object.entries(s.cats).sort((a, b) => b[1] - a[1]);
  const maxCat = cats[0]?.[1] || 1;
  const photos = (thumbs || []).slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/stats">‹ All players</a></nav>
      <div class="player-hero">
        <${Emblem} id=${p.emblem} size=${72} />
        <div><h1 class="title">${p.name}</h1>
          <p class="muted">${s.games} game${s.games === 1 ? '' : 's'}${p.id === me.id ? ' · That\'s you!' : ''}</p></div>
      </div>

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
        ${cats.length > 0 && html`<h2>Favorite kinds of finds</h2>
          <div class="bars">${cats.map(([c, n]) => html`<div class="bar-row" key=${c}>
            <span>${CATEGORY_LABELS[c] || c}</span>
            <span class="bar"><span class=${`cat-${c}`} style=${`width:${(n / maxCat) * 100}%`}></span></span>
            <b>${n}</b></div>`)}</div>`}
      </section>

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

function ItemForm({ initial, submitLabel = 'Add item', onSubmit, onCancel, compact }) {
  const [icon, setIcon] = useState(initial?.icon || '');
  const [text, setText] = useState(initial?.text || '');
  const [tier, setTier] = useState(initial?.tier && initial.tier !== 'free' ? initial.tier : 'e');
  const [cat, setCat] = useState(initial?.cat && initial.cat !== 'free' ? initial.cat : 'theme');

  const submit = (e) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return toast('Describe what to find.', 'error');
    onSubmit({ icon: icon.trim() || '📸', text: t.slice(0, 80), tier, cat });
    if (!initial) { setIcon(''); setText(''); }
  };

  return html`
    <form class="item-form ${compact ? 'compact' : ''}" onSubmit=${submit}>
      <div class="row">
        <input class="text emoji" placeholder="🙂" value=${icon} maxlength="8" aria-label="Emoji"
          onInput=${(e) => setIcon(e.target.value)} />
        <input class="text grow" placeholder="What to find, e.g. Someone with a tail" value=${text} maxlength="80"
          onInput=${(e) => setText(e.target.value)} />
      </div>
      <${Choice} value=${tier} onChange=${setTier} options=${Object.entries(TIER_LABELS).map(([k, l]) => [k, l, TIER_STARS[k]])} />
      <select class="text" value=${cat} onChange=${(e) => setCat(e.target.value)} aria-label="Category">
        ${Object.entries(CATEGORY_LABELS).map(([k, l]) => html`<option value=${k}>${l} (${KIND_HINT[itemKind({ cat: k }) ?? 'other']})</option>`)}
      </select>
      <div class="row end">
        ${onCancel && html`<button type="button" class="btn ghost small" onClick=${onCancel}>Cancel</button>`}
        <button class="btn primary small">${submitLabel}</button>
      </div>
    </form>`;
}

const KIND_HINT = { char: 'Characters + Everything boards', obj: 'Fandom gear + Everything boards', other: 'Everything boards only' };

function ItemsScreen({ bank }) {
  const [q, setQ] = useState('');
  const [tier, setTier] = useState('all');
  const [show, setShow] = useState('all'); // all | on | off | custom
  const [kind, setKind] = useState('all'); // all | char | obj | other: which board mix an item can land in
  const disabled = new Set(bank?.disabled || []);
  const custom = bank?.custom || [];
  const all = [...custom.map((c) => ({ ...c, custom: true })), ...ITEMS];

  const save = (next) => store.put('settings', BANK_ID, {
    disabled: bank?.disabled || [], custom, ...next, updatedAt: Date.now(),
  }).catch((e) => toast(`Sync problem: ${e.message}`, 'error'));

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
    const visibleTexts = filtered.map((i) => i.text);
    const d = new Set(disabled);
    for (const t of visibleTexts) on ? d.delete(t) : d.add(t);
    save({ disabled: [...d] });
  };

  const needle = q.trim().toLowerCase();
  const filtered = all.filter((it) =>
    (tier === 'all' || it.tier === tier) &&
    (kind === 'all' || (itemKind(it) ?? 'other') === kind) &&
    (show === 'all' || (show === 'on' && !disabled.has(it.text)) || (show === 'off' && disabled.has(it.text)) || (show === 'custom' && it.custom)) &&
    (!needle || it.text.toLowerCase().includes(needle)));
  const byCat = Object.keys(CATEGORY_LABELS).map((cat) => [cat, filtered.filter((i) => i.cat === cat)]).filter(([, xs]) => xs.length);
  const onCount = all.filter((i) => !disabled.has(i.text)).length;

  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/">‹ Home</a></nav>
      <h1 class="title">Hunt items</h1>
      <p class="muted">${onCount} of ${all.length} items on. New games draw only from items that are on. Changes are shared with everyone.</p>

      <section class="panel">
        <h2>Add your own</h2>
        <${ItemForm} onSubmit=${add} />
      </section>

      <section class="panel sticky-filters">
        <input class="text" type="search" placeholder="Search items…" value=${q} onInput=${(e) => setQ(e.target.value)} />
        <div class="filter-row">
          ${[['all', 'All boards'], ['char', '🦸 Characters'], ['obj', '🎒 Fandom gear'], ['other', 'Everything-only']].map(([k, l]) => html`
            <button class="pill ${kind === k ? 'sel' : ''}" onClick=${() => setKind(k)}>${l}</button>`)}
        </div>
        <div class="filter-row">
          ${[['all', 'All'], ['e', '★'], ['m', '★★'], ['h', '★★★']].map(([k, l]) => html`
            <button class="pill ${tier === k ? 'sel' : ''}" onClick=${() => setTier(k)}>${l}</button>`)}
          <span class="sep"></span>
          ${[['all', 'Any'], ['on', 'On'], ['off', 'Off'], ['custom', 'Mine']].map(([k, l]) => html`
            <button class="pill ${show === k ? 'sel' : ''}" onClick=${() => setShow(k)}>${l}</button>`)}
        </div>
        <div class="row small">
          <span class="grow muted">${filtered.length} shown</span>
          <button class="btn small ghost" onClick=${() => setAll(true)}>All on</button>
          <button class="btn small ghost" onClick=${() => setAll(false)}>All off</button>
        </div>
      </section>

      ${byCat.map(([cat, items]) => html`
        <section class="panel item-group" key=${cat}>
          <h2><span class="dot cat-${cat}"></span>${CATEGORY_LABELS[cat]} <small class="muted">${items.length} · ${KIND_HINT[itemKind({ cat }) ?? 'other']}</small></h2>
          ${items.map((it) => {
            const on = !disabled.has(it.text);
            return html`<div class="item-row ${on ? '' : 'off'}" key=${it.text}>
              <span class="icon">${it.icon}</span>
              <span class="grow">${it.text}${it.custom && html` <i class="badge">mine</i>`}<small class="stars">${TIER_STARS[it.tier]}</small></span>
              ${it.custom && html`<button class="icon-btn round" aria-label="Delete item" onClick=${() => removeCustom(it.text)}>${TRASH_SVG}</button>`}
              <label class="switch"><input type="checkbox" checked=${on} onChange=${() => toggle(it.text)} /><span></span></label>
            </div>`;
          })}
        </section>`)}
      ${!filtered.length && html`<p class="muted center">No items match.</p>`}
    </main>`;
}

// ───────────────────────── board pieces ─────────────────────────

const TIER_STARS = { e: '★', m: '★★', h: '★★★', free: '' };

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
        <span class="icon">${item.icon}</span>
        <span class="txt">${item.text}</span>
        ${TIER_STARS[item.tier] && !found && html`<span class="stars">${TIER_STARS[item.tier]}</span>`}
        ${found && html`<span class="check">✓</span>`}
        ${found && stamp && html`<span class="stamp"><${Emblem} id=${stamp} size=${22} /></span>`}
      `}
    </button>`;
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
            <span class="icon">${b.icon}</span><span>${b.text}</span><i>${TIER_STARS[b.tier]}</i>
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
        <button class="btn primary" onClick=${() => { stop(); onClose(); onFallback(); }}>📱 Use phone camera</button>
      </div>`}
      <button class="cam-btn cam-close" onClick=${() => { stop(); onClose(); }} aria-label="Close camera">✕</button>
      ${shot && html`<button class=${'cam-pill' + (save ? ' on' : '')} onClick=${toggleSave}
        aria-pressed=${save}>${save ? '✓ Save to Photos' : 'Save to Photos'}</button>`}
      ${!shot && !error && html`<button class=${'cam-pill cam-wide' + (wide ? ' on' : '')} onClick=${() => setWide(!wide)}
        aria-pressed=${wide}>${wide ? '⤡ Wide' : '⤢ Normal'}</button>`}
      <div class="camera-bar">
        ${shot ? html`
          <button class="btn ghost cam-retake" style="color:#141414;background:#fff" onClick=${retake}>↺ Retake</button>
          <button class="btn primary" onClick=${use}>✓ Use photo</button>
        ` : html`
          <span class="cam-spacer"></span>
          <button class="shutter" onClick=${snap} disabled=${!ready} aria-label="Take photo"><span></span></button>
          <button class="cam-btn" onClick=${() => setFacing(facing === 'user' ? 'environment' : 'user')} aria-label="Flip camera">🔄</button>
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

function PhotoButtons({ onFile, onNoPhoto, label = 'Take photo' }) {
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
        ? html`<button class="btn primary huge" onClick=${() => setCamera(true)}>📸 ${label}</button>`
        : html`<label class="btn primary huge">📸 ${label}
            <input type="file" accept="image/*" capture=${capture} onChange=${handle} hidden /></label>`}
      <div class="row two">
        <label class="btn ghost">🖼️ Library
          <input type="file" accept="image/*" onChange=${handle} hidden /></label>
        ${hasLiveCamera && html`<label class="btn ghost">📱 Phone camera
          <input ref=${nativeRef} type="file" accept="image/*" capture=${capture} onChange=${handle} hidden /></label>`}
      </div>
      ${onNoPhoto && html`<button class="btn ghost" onClick=${onNoPhoto}>✅ Found it, no photo</button>`}
      ${camera && html`<${CameraView} onFile=${onFile} onClose=${() => setCamera(false)}
        onFallback=${() => nativeRef.current?.click()} />`}
    </div>`;
}

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

function SquareModal({ item, photoId, found, thumb, by, at, canAct, actionLabel, onFile, onNoPhoto, onRemove, removeLabel, onEdit, onReroll, rerolls = 0, onClose, note }) {
  const [full, setFull] = useState(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  useScrollLock();

  useEffect(() => {
    setFull(null);
    if (!photoId) return;
    let alive = true;
    store.getOne('photos', photoId).then((d) => alive && d && setFull(d.full));
    return () => { alive = false; };
  }, [photoId]);

  const wrap = (fn) => async (arg) => {
    setBusy(true);
    try { await fn(arg); } catch (e) { toast(e.message || 'Something went wrong', 'error'); }
    setBusy(false);
  };

  return html`
    <div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal">
        <button class="x" onClick=${onClose} aria-label="Close">×</button>
        <div class="modal-head cat-${item.cat}">
          <span class="icon">${item.icon}</span>
          <div>
            <h2>${item.text}</h2>
            <small>${CATEGORY_LABELS[item.cat] || ''} ${TIER_STARS[item.tier] && html`· <span class="stars">${TIER_STARS[item.tier]}</span>`}</small>
          </div>
        </div>
        ${photoId && html`
          <figure class="photo">
            <img src=${full || thumb} alt=${item.text} />
            ${by && html`<figcaption><${Emblem} id=${by.emblem} size=${22} /> ${by.name}
              ${at && html`<span class="muted"> · ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`}</figcaption>`}
          </figure>`}
        ${found && !photoId && html`<p class="found-note">✅ Found${by ? html` by <${Emblem} id=${by.emblem} size=${22} /> ${by.name}` : ''}, no photo
          ${at && html`<span class="muted"> · ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>`}</p>`}
        ${note && html`<p class="muted center">${note}</p>`}
        ${editing ? html`<${ItemForm} initial=${item} submitLabel="Save square" compact
            onSubmit=${(it) => { onEdit(it); setEditing(false); }} onCancel=${() => setEditing(false)} />`
          : canAct && html`<${PhotoButtons} label=${actionLabel} onFile=${wrap(onFile)} onNoPhoto=${onNoPhoto && wrap(onNoPhoto)} />`}
        ${!editing && (onEdit || onReroll) && html`<div class="row two">
          ${onReroll && html`<button class="btn small ghost" onClick=${onReroll}>🎲 Reroll${rerolls ? ` (${rerolls} used)` : ''}</button>`}
          ${onEdit && html`<button class="btn small ghost" onClick=${() => setEditing(true)}>✏️ Edit square</button>`}
        </div>`}
        ${photoId && full && html`<button class="btn small ghost" onClick=${() => saveDataUrl(full, item.text)}>💾 Save photo</button>`}
        ${onRemove && html`<button class="btn small danger" onClick=${wrap(onRemove)}>${removeLabel || 'Remove photo'}</button>`}
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
    ch: ['💥', '⭐', '⚡', '🎉', '✨', '🦸'][i % 6],
  })), []);
  return html`<div class="confetti">${bits.map((b) => html`
    <span style=${`left:${b.left}%;animation-delay:${b.delay}s;animation-duration:${b.dur}s`}>${b.ch}</span>`)}</div>`;
}

function WinBanner({ text, sub, onRematch }) {
  return html`<div class="win-banner">
    <div class="pow">${text}</div>
    ${sub && html`<p>${sub}</p>`}
    <div class="row center-row">
      <button class="btn small primary" onClick=${() => dispatchEvent(new Event('nycc:recap'))}>🖼️ Game recap</button>
      ${onRematch && html`<button class="btn small" onClick=${onRematch}>Rematch</button>`}
    </div>
  </div>`;
}

function RecapModal({ recap, code, playersById, onFeature, onClose, title = 'Game recap' }) {
  useScrollLock();
  const ext = recap.blob?.type === 'image/jpeg' ? 'jpg' : 'png';
  const file = recap.blob && new File([recap.blob], `nycc-hunt-${code}.${ext}`, { type: recap.blob.type || 'image/png' });
  const canShare = file && navigator.canShare?.({ files: [file] });
  const share = async () => {
    try { await navigator.share({ files: [file], title: 'NYCC Photo Hunt' }); } catch {}
  };
  return html`
    <div class="modal-bg" onClick=${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal recap">
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
        </div>
        ${recap.url ? html`
          <img class="recap-img" src=${recap.url} alt="Game recap" />
          <p class="muted small center">Tip: press and hold the image to save it to Photos.</p>
          ${canShare && html`<button class="btn primary huge" onClick=${share}>📤 Save or share</button>`}
          <a class="btn ghost" href=${recap.url} download=${`nycc-hunt-${code}.${ext}`}>⬇️ Download</a>
        ` : html`<div class="recap-loading"><div class="spinner"></div>${recap.progress || 'Drawing your comic…'}</div>`}
      </div>
    </div>`;
}

// ───────────────────────── game screens ─────────────────────────

function GameScreen({ code, me, playersById }) {
  const game = useWatch((cb) => store.watchDoc('games', code, cb), [code]);
  const thumbList = useWatch((cb) => store.watchWhere('thumbs', 'gameId', '==', code, cb), [code]);
  const thumbs = useMemo(() => Object.fromEntries((thumbList || []).map((t) => [t.id, t])), [thumbList]);
  const [joining, setJoining] = useState(false);
  const [recap, setRecap] = useState(null);
  const [facing, setFacing] = useState(() => loadPref(facingKey(code), loadPref(FACING_KEY, 'user')));
  const pickFacing = (f) => { setFacing(f); savePref(facingKey(code), f); savePref(FACING_KEY, f); };

  const makeRecap = async (featuredId) => {
    if (!game) return;
    if (typeof featuredId !== 'string') featuredId = undefined; // called from an event
    if (recap?.url) URL.revokeObjectURL(recap.url);
    const cached = featuredId && recap?.boards;
    setRecap({ boards: cached, featuredId });
    try {
      const boards = cached || (game.mode === 'bingo' ? await store.getWhere('boards', 'gameId', '==', code) : []);
      if (!featuredId && boards.length) {
        // Default to the winner's card, else the top score.
        const top = boards.find((b) => b.playerId === game.winner)
          || boards.slice().sort((a, b) => G.scoreBoard(b).points - G.scoreBoard(a).points)[0];
        featuredId = top.playerId;
      }
      const blob = await renderRecap({ game, boards, thumbs, playersById, featuredId });
      setRecap({ blob, url: URL.createObjectURL(blob), boards, featuredId });
    } catch (e) {
      setRecap(null);
      toast(`Couldn't make the recap: ${e.message}`, 'error');
    }
  };
  const closeRecap = () => { if (recap?.url) URL.revokeObjectURL(recap.url); setRecap(null); };
  useEffect(() => {
    addEventListener('nycc:recap', makeRecap);
    return () => removeEventListener('nycc:recap', makeRecap);
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
        if (g.mode === 'versus') g.backups = { ...g.backups, [me.id]: versusBackups(g) };
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

  const Screen = game.mode === 'bingo' ? BingoGame : game.mode === 'endless' ? EndlessGame : VersusGame;
  return html`
    <main class="screen game">
      <nav class="topbar">
        <a class="back" href="#/">‹ Home</a>
        <button class="code-chip" onClick=${share}>Code <b>${code}</b> · Share</button>
      </nav>
      ${!isPlayer && html`
        <div class="banner join-banner">You're watching this game.
          <button class="btn primary small" disabled=${joining} onClick=${join}>${joining ? 'Joining…' : 'Join game'}</button></div>`}
      ${isPlayer && html`<div class="facing-pick">
        <span>Camera opens to</span>
        <button class=${'pill' + (facing === 'user' ? ' sel' : '')} onClick=${() => pickFacing('user')}>🤳 Selfie</button>
        <button class=${'pill' + (facing === 'environment' ? ' sel' : '')} onClick=${() => pickFacing('environment')}>📷 Back</button>
      </div>`}
      <${CameraFacing.Provider} value=${facing}>
        <${Screen} key=${isPlayer ? 'player' : 'watcher'} game=${game} me=${me} playersById=${playersById} thumbs=${thumbs} isPlayer=${isPlayer} onRematch=${rematch} />
      <//>
      <div class="game-footer">
        <button class="btn small" onClick=${makeRecap}>🖼️ Game recap</button>
        <button class="btn small danger" onClick=${async () => { if (await confirmDelete(code)) go('/'); }}>🗑️ Delete game</button>
      </div>
      ${recap && html`<${RecapModal} recap=${recap} code=${code} playersById=${playersById} onFeature=${makeRecap} onClose=${closeRecap} />`}
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

  const timeUp = !!game.endsAt && now >= game.endsAt;
  const ordered = useMemo(() => (boards || []).slice().sort((a, b) =>
    (a.playerId === me.id ? -1 : b.playerId === me.id ? 1 : a.createdAt - b.createdAt)), [boards, me.id]);
  const scores = useMemo(() => Object.fromEntries(ordered.map((b) => [b.playerId, G.scoreBoard(b)])), [ordered]);

  useEffect(() => { if (!viewing && ordered.length) setViewing(ordered[0].playerId); }, [ordered.length]);
  useEffect(() => { if (isPlayer) setViewing(me.id); }, [isPlayer]);

  // 'most' winner is computed once time is up; line/blackout winners are written to the game doc.
  let winnerId = game.winner;
  if (game.winRule === 'most' && timeUp && ordered.length) {
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
    } else if (after.lines > before.lines) toast('LINE! 💥', 'good');
    else toast(photo ? 'Got it! 📸' : 'Got it! ✅', 'good');
  };

  const editSquare = (it) => {
    const items = board.items.slice();
    items[open] = it;
    store.patch('boards', boardId(board), { items }).catch((e) => toast(e.message, 'error'));
    toast('Square updated');
  };

  const reroll = () => {
    const i = open;
    const exclude = [...board.items, ...(board.backups || [])].map((it) => it.text);
    const it = G.rerollItem(board.items[i], { exclude, pool: poolFor(game) });
    if (!it) return toast('No other items at this level to roll.', 'error');
    const items = board.items.slice();
    items[i] = it;
    store.patch('boards', boardId(board), { items, rerolls: (board.rerolls || 0) + 1 }).catch((e) => toast(e.message, 'error'));
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
      <span>${game.size}×${game.size} · ${G.WIN_RULES[game.winRule]?.label} · ${G.DIFFICULTY[game.difficulty]?.label}${mixTag(game)}</span>
      ${game.endsAt && html`<span class="timer ${timeUp ? 'over' : ''}">⏱ ${timeUp ? "Time's up!" : G.fmtDuration(game.endsAt - now)}</span>`}
    </div>
    ${winnerId && html`<${WinBanner}
      text=${winnerId === 'draw' ? "IT'S A TIE!" : winnerId === me.id ? 'YOU WIN!' : `${firstName(winner).toUpperCase()} WINS!`}
      sub=${game.winRule !== 'most' ? 'Keep hunting for bragging rights, or start a rematch.' : null}
      onRematch=${onRematch} />`}

    <div class="scoreboard">
      ${ordered.map((b) => {
        const p = playersById[b.playerId];
        const s = scores[b.playerId];
        return html`<button class="score ${viewing === b.playerId ? 'sel' : ''}" key=${b.playerId} onClick=${() => { setViewing(b.playerId); setSwapIdx(null); }}>
          <${Emblem} id=${p?.emblem} size=${34} />
          <span class="nm">${b.playerId === me.id ? 'You' : firstName(p)}${winnerId === b.playerId ? ' 🏆' : ''}</span>
          <span class="pts">${s.found} found · ${s.lines} line${s.lines === 1 ? '' : 's'}${game.winRule === 'most' ? ` · ${s.points}pt` : ''}${b.rerolls ? ` · 🎲${b.rerolls}` : ''}</span>
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
      ${mine && html`<${BackupTray} backups=${board.backups} swapIdx=${swapIdx} setSwapIdx=${setSwapIdx} canUse=${canEdit} />`}
    ` : html`<p class="muted center">No board yet.</p>`}

    ${open !== null && board && html`<${SquareModal}
      item=${board.items[open]}
      photoId=${openMark?.photo} found=${!!openMark} thumb=${openMark?.photo && thumbs[openMark.photo]?.thumb}
      by=${openMark && playersById[board.playerId]} at=${openMark?.at}
      canAct=${canEdit} actionLabel=${openMark?.photo ? 'Retake photo' : openMark ? 'Add a photo' : 'Take photo'}
      onFile=${markSquare} onNoPhoto=${!openMark ? () => markSquare(null) : null}
      onRemove=${canEdit && openMark ? unmark : null} removeLabel=${openMark?.photo ? 'Remove photo' : 'Unmark square'}
      onEdit=${canEdit && !openMark ? editSquare : null}
      onReroll=${canEdit && !openMark ? reroll : null} rerolls=${board.rerolls || 0}
      note=${!openMark && !canEdit ? (timeUp ? "Time's up!" : 'Not found yet.') : null}
      onClose=${() => setOpen(null)} />`}
  `;
}

const PLACEHOLDER = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#ddd"/><text x="5" y="6.5" font-size="4" text-anchor="middle">📸</text></svg>');

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
      return toast('Photo added 📸', 'good');
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
      toast(`Found it! ${left} to go 💪`, 'good');
    } else if (res.data.winner !== me.id && !game.coop) toast('Claimed! 🚩', 'good');
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

  const reroll = async () => {
    const i = open;
    try {
      const res = await store.transact('games', game.code, (g) => {
        if (!g || g.claims?.[i] || g.winner) return undefined;
        const exclude = [...g.items, ...Object.values(g.backups || {}).flat()].map((it) => it.text);
        const it = G.rerollItem(g.items[i], { exclude, pool: poolFor(g) });
        if (!it) return undefined;
        g.items[i] = it;
        g.rerolls = { ...g.rerolls, [me.id]: (g.rerolls?.[me.id] || 0) + 1 };
        return g;
      });
      if (!res.ok) toast(res.data?.claims?.[i] ? 'Someone already got that one!' : 'No other items at this level to roll.', 'error');
    } catch (e) { toast(`Rerolling needs a connection: ${e.message}`, 'error'); }
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
    <div class="game-info"><span>${game.size}×${game.size} · ${coop ? 'Co-op: black out the board' : `${game.connect} in a row wins`} · ${G.DIFFICULTY[game.difficulty]?.label}${mixTag(game)}</span></div>
    ${over && html`<${WinBanner}
      text=${game.winner === 'team' ? 'TEAM BLACKOUT!' : game.winner === 'draw' ? "IT'S A DRAW!" : game.winner === me.id ? 'YOU WIN!' : `${firstName(winner).toUpperCase()} WINS!`}
      sub=${coop ? `All ${total} squares found together. 🎉` : !winLine && game.winner !== 'draw' ? 'Board full: most squares wins.' : null}
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
          <span class="nm">${pid === me.id ? 'You' : firstName(p)}${game.winner === pid ? ' 🏆' : ''}</span>
          <span class="pts">${counts[pid] || 0} ${coop ? 'found' : 'claimed'}${game.rerolls?.[pid] ? ` · 🎲${game.rerolls[pid]}` : ''}</span>
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

    ${isPlayer && !over && html`<${BackupTray} backups=${myBackups || []} swapIdx=${swapIdx} setSwapIdx=${setSwapIdx} canUse=${true} />`}

    ${open !== null && html`<${SquareModal}
      item=${game.items[open]}
      photoId=${openClaim?.photo} found=${!!openClaim} thumb=${openClaim?.photo && thumbs[openClaim.photo]?.thumb}
      by=${openClaim && playersById[openClaim.by]} at=${openClaim?.at}
      canAct=${isPlayer && (openClaim ? openClaim.by === me.id && !openClaim.photo : !over)}
      actionLabel=${openClaim ? 'Add a photo' : coop ? 'Snap it for the team' : 'Snap it to claim'}
      onFile=${claim} onNoPhoto=${!openClaim ? () => claim(null) : null}
      onRemove=${openClaim?.by === me.id && !over ? unclaim : null} removeLabel=${coop ? 'Unmark square' : 'Undo my claim'}
      onEdit=${isPlayer && !over && !openClaim ? editSquare : null}
      onReroll=${isPlayer && !over && !openClaim ? reroll : null} rerolls=${game.rerolls?.[me.id] || 0}
      note=${!openClaim && over ? 'Game over.' : !openClaim && !isPlayer ? `Join the game to ${coop ? 'help out' : 'claim squares'}.` : null}
      onClose=${() => setOpen(null)} />`}
  `;
}

// ───────────────────────── endless ─────────────────────────

const findCount = (g) => (g.history || []).filter(G.isFind).length;
const ENDLESS_TIERS = [['any', '🎲', 'Surprise'], ['e', '★', '1 pt'], ['m', '★★', '2 pts'], ['h', '★★★', '3 pts']];

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
  const history = (game.history || []).map((h, i) => ({ ...h, i })).reverse();
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
        const it = G.drawEndless(poolFor({ mix: o.mix }), { tier: o.tier || 'any', exclude });
        if (!it) continue;
        g.history.push({ item: o.item, expired: true, at: now });
        Object.assign(o, { item: it, seen: 0, at: now });
      }
      if (s2.turnMode === 'turns') s2.turn = G.nextPlayer(g, me.id);
    });
    setSnapId(null);
    if (!res.ok) return toast(turns ? "It's not your turn." : 'Someone got that one first!', 'error');
    toast(`+${pts(slot.item)} pt${pts(slot.item) === 1 ? '' : 's'}! 🎉`, 'good');
  };

  const reroll = async (slot) => {
    const res = await update((s2, g) => {
      const a = slotOf(s2, slot.id);
      if (!a?.item || (s2.turnMode === 'turns' && s2.turn !== me.id)) return false;
      const exclude = [...(g.history || []).map((h) => h.item.text), ...s2.active.filter((x) => x.item).map((x) => x.item.text)];
      const it = G.drawEndless(poolFor({ mix: a.mix }), { tier: a.item.tier, exclude });
      if (!it || it.text === a.item.text) return false;
      g.history = [...(g.history || []), { item: a.item, by: me.id, rerolled: true, at: Date.now() }];
      a.item = it;
      a.seen = 0;
      g.rerolls = { ...g.rerolls, [me.id]: (g.rerolls?.[me.id] || 0) + 1 };
    }).catch((e) => { toast(`Rerolling needs a connection: ${e.message}`, 'error'); return null; });
    if (res && !res.ok) toast('No other items at this level to roll.', 'error');
  };

  const deal = async (slot, tier, mix) => {
    const res = await update((s2, g) => {
      const a = slotOf(s2, slot.id);
      if (!a?.pick) return false;
      const exclude = [...(g.history || []).map((h) => h.item.text), ...s2.active.filter((x) => x.item).map((x) => x.item.text)];
      const item = G.drawEndless(poolFor({ mix }), { tier, exclude });
      if (!item) return false;
      delete a.pick;
      Object.assign(a, { item, tier, mix, seen: 0, at: Date.now() });
      g.lastPick = { tier, mix };
    }).catch((e) => { toast(`Dealing needs a connection: ${e.message}`, 'error'); return null; });
    if (res && !res.ok && slotOf(G.endlessState(res.data || game), slot.id)?.pick) toast('No items match those settings. Try another type.', 'error');
  };

  const endGame = async () => {
    if (!confirm('End the game? Most points wins.')) return;
    await store.transact('games', game.code, (g) => {
      if (!g || g.winner) return undefined;
      const sc = G.endlessScores(g);
      const best = Math.max(0, ...Object.values(sc).map((x) => x.points));
      const leaders = Object.keys(sc).filter((k) => sc[k].points === best);
      g.winner = leaders.length === 1 ? leaders[0] : 'draw';
      g.wonAt = Date.now();
      return g;
    });
  };

  const winner = game.winner && game.winner !== 'draw' ? playersById[game.winner] : null;
  const viewing = open !== null ? game.history[open] : null;
  const single = st.active.length === 1;
  const snapSlot = snapId && st.active.find((a) => a.id === snapId && a.item);

  return html`
    ${celebrate && html`<${Confetti} />`}
    <div class="game-info"><span>Endless · ${findCount(game)} find${findCount(game) === 1 ? '' : 's'} · ${st.slots} active · ${turns ? 'Taking turns' : 'Anyone snaps'}${mixTag(game)}</span></div>
    ${over && html`<${WinBanner}
      text=${game.winner === 'draw' ? "IT'S A TIE!" : game.winner === me.id ? 'YOU WIN!' : `${firstName(winner).toUpperCase()} WINS!`}
      sub="Most points when the game ended." onRematch=${onRematch} />`}

    <div class="scoreboard">
      ${game.players.map((pid) => {
        const p = playersById[pid];
        const sc = scores[pid] || { points: 0, finds: 0 };
        return html`<div class=${'score' + (turns && pid === st.turn && !over ? ' sel' : '')} key=${pid}>
          <${Emblem} id=${p?.emblem} size=${34} />
          <span class="nm">${name(pid)}${game.winner === pid ? ' 🏆' : ''}</span>
          <span class="pts">${sc.points} pt${sc.points === 1 ? '' : 's'} · ${sc.finds} found${game.rerolls?.[pid] ? ` · 🎲${game.rerolls[pid]}` : ''}</span>
        </div>`;
      })}
    </div>

    ${!over && html`
      <p class="turn-line">${!turns ? (isPlayer ? '⚡ Anyone can snap. First one gets it!' : 'Anyone in the game can snap.')
        : st.turn === me.id ? '🎯 Your turn!' : html`<${Emblem} id=${playersById[st.turn]?.emblem} size=${22} /> ${name(st.turn)}'s turn`}</p>
      <div class=${'endless-slots' + (single ? ' single' : '')}>
        ${st.active.map((slot) => slot.pick
          ? html`<${PickSlot} key=${slot.id} slot=${slot} game=${game} me=${me} isPlayer=${isPlayer} name=${name} onDeal=${deal} />`
          : html`<div class="endless-slot" key=${slot.id}>
            <button class=${`endless-card cat-${slot.item.cat}${single ? '' : ' compact'}`} disabled=${single || !canSnap} onClick=${() => setSnapId(slot.id)}>
              <span class="stars">${TIER_STARS[slot.item.tier]}</span>
              <span class="icon">${slot.item.icon}</span>
              <h2>${slot.item.text}</h2>
              <small>${CATEGORY_LABELS[slot.item.cat] || ''} · ${pts(slot.item)} pt${pts(slot.item) === 1 ? '' : 's'}</small>
            </button>
            ${canSnap && (single ? html`<div class="endless-actions">
              <${PhotoButtons} label="Snap it" onFile=${(f) => capture(slot, f).catch((e) => toast(e.message, 'error'))}
                onNoPhoto=${() => capture(slot, null).catch((e) => toast(e.message, 'error'))} />
              <button class="btn small ghost" onClick=${() => reroll(slot)}>🎲 Reroll${game.rerolls?.[me.id] ? ` (${game.rerolls[me.id]} used)` : ''}</button>
            </div>` : html`<div class="row slot-actions">
              <button class="btn primary" onClick=${() => setSnapId(slot.id)}>📸 Snap</button>
              <button class="btn ghost" onClick=${() => reroll(slot)}>🎲 Reroll</button>
            </div>`)}
          </div>`)}
      </div>
      ${turns && isPlayer && st.turn !== me.id && html`<p class="muted center">Waiting for ${name(st.turn)} to snap one…</p>`}
    `}

    ${history.length > 0 && html`<section class="panel">
      <h2>Everything so far</h2>
      <div class="endless-history">
        ${history.map((h) => {
          const found = G.isFind(h);
          const who = h.by ? html`<${Emblem} id=${playersById[h.by]?.emblem} size=${16} /> ${name(h.by)} · ` : '';
          const what = found ? `${TIER_STARS[h.item.tier]} +${pts(h.item)}`
            : h.rerolled ? '🎲 Rerolled' : h.expired ? `⌛ Swapped out after ${G.ENDLESS_EXPIRE_AFTER} other finds` : 'Skipped';
          return html`<button class=${'hist-row' + (found ? '' : ' skipped')} key=${h.i} onClick=${() => found && setOpen(h.i)}>
            ${h.photo && thumbs[h.photo] ? html`<img src=${thumbs[h.photo].thumb} alt="" />` : html`<span class=${`hist-icon cat-${h.item.cat}`}>${h.item.icon}</span>`}
            <span class="grow"><b>${h.item.text}</b><small>${who}${what}</small></span>
          </button>`;
        })}
      </div>
    </section>`}

    ${isPlayer && !over && html`<button class="btn small ghost end-game" onClick=${endGame}>🏁 End game</button>`}
    ${busy && html`<div class="busy"><div class="spinner"></div>Uploading…</div>`}

    ${snapSlot && html`<${SquareModal} item=${snapSlot.item} found=${false} canAct=${canSnap} actionLabel="Snap it"
      onFile=${(f) => capture(snapSlot, f)} onNoPhoto=${() => capture(snapSlot, null)}
      onReroll=${canSnap ? () => reroll(snapSlot) : null} rerolls=${game.rerolls?.[me.id] || 0}
      onClose=${() => setSnapId(null)} />`}
    ${viewing && html`<${SquareModal} item=${viewing.item} photoId=${viewing.photo} found=${true}
      thumb=${viewing.photo && thumbs[viewing.photo]?.thumb} by=${playersById[viewing.by]} at=${viewing.at}
      canAct=${false} onClose=${() => setOpen(null)} />`}
  `;
}

/** An empty endless slot: choose difficulty + type, then deal the replacement item. */
function PickSlot({ slot, game, me, isPlayer, name, onDeal }) {
  const [tier, setTier] = useState(game.lastPick?.tier || 'any');
  const [mix, setMix] = useState(game.lastPick?.mix || mixOf(game));
  const mine = slot.pick.by === me.id;
  return html`<section class="panel pick-panel">
    <h2>${mine ? 'You found it! Pick the next item' : `${name(slot.pick.by)} is picking the next item`}</h2>
    ${isPlayer ? html`
      ${!mine && html`<p class="muted small">Anyone can pick if they're busy.</p>`}
      <h3>Difficulty</h3>
      <${Choice} value=${tier} onChange=${setTier} options=${ENDLESS_TIERS} />
      <h3>Type</h3>
      <${Choice} value=${mix} onChange=${setMix} options=${Object.entries(MIXES).map(([k, m]) => [k, m.label])} />
      <button class="btn primary huge" onClick=${() => onDeal(slot, tier, mix)}>🃏 Deal it!</button>`
    : html`<p class="muted">Join the game to play.</p>`}
  </section>`;
}

// ───────────────────────── app shell ─────────────────────────

function App() {
  const route = useHash();
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

  return html`${body}<${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
