import { html, render, useState, useEffect, useMemo, useRef } from '../vendor/htm-preact.js';
import * as store from './store.js';
import { EMBLEMS, emblemById, emblemSVG } from './data/emblems.js';
import { CATEGORY_LABELS, ITEMS } from './data/items.js';
import * as G from './game.js';
import { processPhoto } from './photo.js';

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

async function uniqueCode() {
  for (let i = 0; i < 8; i++) {
    const code = G.makeCode();
    if (!(await store.getOne('games', code))) return code;
  }
  return G.makeCode(5);
}

function makeBoard(game, pid) {
  const card = game.card || G.generateCard({ size: game.size, difficulty: game.difficulty, freeCenter: game.freeCenter });
  return {
    gameId: game.code, playerId: pid, size: game.size,
    items: card.items, backups: card.backups, marks: {}, createdAt: Date.now(),
  };
}

function versusBackups(game) {
  return G.generateCard({ size: game.size, difficulty: game.difficulty, exclude: game.items.map((i) => i.text) }).backups;
}

async function createGame(settings, createdBy) {
  const code = await uniqueCode();
  const base = {
    code, mode: settings.mode, size: settings.size, difficulty: settings.difficulty,
    players: settings.players, createdBy, createdAt: Date.now(), winner: null,
  };
  const fail = (e) => toast(`Sync problem: ${e.message}`, 'error');
  if (settings.mode === 'bingo') {
    const game = {
      ...base,
      winRule: settings.winRule,
      minutes: settings.minutes,
      endsAt: settings.winRule === 'most' ? Date.now() + settings.minutes * 60_000 : null,
      freeCenter: settings.freeCenter,
      sameCard: settings.sameCard,
      card: settings.sameCard
        ? G.generateCard({ size: settings.size, difficulty: settings.difficulty, freeCenter: settings.freeCenter })
        : null,
    };
    store.put('games', code, game).catch(fail);
    for (const pid of game.players) store.put('boards', `${code}_${pid}`, makeBoard(game, pid)).catch(fail);
  } else {
    const card = G.generateCard({ size: settings.size, difficulty: settings.difficulty });
    const game = { ...base, connect: settings.connect, items: card.items, claims: {}, backups: {} };
    for (const pid of game.players) game.backups[pid] = versusBackups(game);
    store.put('games', code, game).catch(fail);
  }
  return code;
}

const settingsFrom = (g) => ({
  mode: g.mode, size: g.size, difficulty: g.difficulty, players: g.players,
  winRule: g.winRule, minutes: g.minutes || 60, freeCenter: g.freeCenter, sameCard: g.sameCard, connect: g.connect,
});

// ───────────────────────── screens ─────────────────────────

function ProfileScreen({ players, me, onPick }) {
  const [name, setName] = useState(me?.name || '');
  const [emblem, setEmblem] = useState(me?.emblem || EMBLEMS[Math.floor(Math.random() * EMBLEMS.length)].id);
  const others = (players || []).filter((p) => p.id !== me?.id);
  const taken = new Set(others.map((p) => p.emblem));

  const save = () => {
    const n = name.trim();
    if (!n) return toast('Give yourself a hero name!', 'error');
    const id = me?.id || G.uid();
    store.put('players', id, { name: n.slice(0, 24), emblem, createdAt: me?.createdAt || Date.now() })
      .catch((e) => toast(`Sync problem: ${e.message}`, 'error'));
    onPick(id);
  };

  return html`
    <main class="screen">
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
    </main>`;
}

function Home({ me, playersById }) {
  const games = useWatch((cb) => store.watchWhere('games', 'players', 'array-contains', me.id, cb), [me.id]);
  const [code, setCode] = useState('');
  const sorted = (games || []).slice().sort((a, b) => b.createdAt - a.createdAt);

  const join = (e) => {
    e.preventDefault();
    const c = code.trim().toUpperCase().replace(/^NYCC-?/, '');
    if (c) go(`/g/${c}`);
  };

  return html`
    <main class="screen">
      <header class="hero">
        <div class="logo">NYCC<span>Photo Hunt</span></div>
        <button class="me" onClick=${() => go('/profile')} title="Edit profile">
          <${Emblem} id=${me.emblem} size=${44} /><span>${me.name}</span>
        </button>
      </header>
      ${!store.isLive && html`<div class="banner warn">
        <b>Demo mode:</b> games only sync on this device. Add your Firebase config to play together live.</div>`}

      <section class="modes">
        <a class="mode-card bingo" href="#/new/bingo">
          <div class="burst">BINGO!</div>
          <h2>Bingo Hunt</h2>
          <p>Everyone gets their own card. Snap photos, complete lines, win.</p>
        </a>
        <a class="mode-card versus" href="#/new/versus">
          <div class="burst">VS!</div>
          <h2>Showdown</h2>
          <p>One shared board, tic-tac-toe style. First photo claims the square!</p>
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
        <h2>Your games</h2>
        ${games === undefined && html`<p class="muted">Loading…</p>`}
        ${games && !sorted.length && html`<p class="muted">No games yet. Start one above!</p>`}
        <div class="game-list">
          ${sorted.map((g) => {
            const winner = g.winner && playersById[g.winner];
            return html`
              <a class="game-row" href="#/g/${g.code}" key=${g.code}>
                <span class="tag ${g.mode}">${g.mode === 'bingo' ? 'BINGO' : 'VS'}</span>
                <span class="grow">
                  <b>${g.code}</b> · ${g.size}×${g.size}
                  ${g.mode === 'bingo' ? ` · ${G.WIN_RULES[g.winRule]?.label}` : ` · connect ${g.connect}`}
                  <small>${new Date(g.createdAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
                    ${winner ? ` · 🏆 ${winner.name}` : g.winner === 'draw' ? ' · Draw' : ''}</small>
                </span>
                <span class="stack">${g.players.slice(0, 5).map((pid) => html`<${Emblem} id=${playersById[pid]?.emblem} size=${26} />`)}</span>
              </a>`;
          })}
        </div>
      </section>

      <details class="panel how">
        <summary>How to play</summary>
        <ul>
          <li><b>Bingo Hunt:</b> each player gets a card. Tap a square → take a photo → it's marked. Choose a win rule when you create the game.</li>
          <li><b>Showdown:</b> everyone shares one board. Snap it first to claim it with your emblem. Get N-in-a-row to win.</li>
          <li><b>Backups:</b> you get 1–3 backup items (based on board size). Tap a backup, then tap any unmarked square to swap it in.</li>
          <li><b>Easy squares</b> are thematic (tails, wings, horns…). ★★★ squares are the rare finds.</li>
          <li>Share the game code or link with your crew. Anyone can join mid-game.</li>
          <li>${ITEMS.length} ideas in the hunt pool.</li>
        </ul>
      </details>
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
  const [size, setSize] = useState(isBingo ? 5 : 3);
  const [difficulty, setDifficulty] = useState('balanced');
  const [winRule, setWinRule] = useState('line');
  const [minutes, setMinutes] = useState(90);
  const [freeCenter, setFreeCenter] = useState(true);
  const [sameCard, setSameCard] = useState(false);
  const [connect, setConnect] = useState(G.defaultConnect(3));
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
      const code = await createGame({ mode, size, difficulty, winRule, minutes, freeCenter, sameCard, connect, players: selected }, me.id);
      go(`/g/${code}`);
    } catch (e) {
      toast(`Couldn't create game: ${e.message}`, 'error');
      setBusy(false);
    }
  };

  const nb = G.backupsFor(size);
  return html`
    <main class="screen">
      <nav class="topbar"><a class="back" href="#/">‹ Home</a></nav>
      <h1 class="title">${isBingo ? 'New Bingo Hunt' : 'New Showdown'}</h1>

      <section class="panel">
        <h2>Board size</h2>
        <${Choice} value=${size} onChange=${setSize}
          options=${G.SIZES.map((s) => [s, `${s}×${s}`, `${s * s} squares`])} />
        <p class="muted small">Each player gets <b>${nb} backup${nb > 1 ? 's' : ''}</b> to swap in.</p>

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
          <h2>In a row to win</h2>
          <${Choice} value=${connect} onChange=${setConnect}
            options=${Array.from({ length: size - 2 }, (_, i) => i + 3).map((k) => [k, `${k} in a row`])} />
        `}
      </section>

      <section class="panel">
        <h2>Players</h2>
        <div class="player-pick">
          ${(players || []).map((p) => html`
            <button class="chip big ${selected.includes(p.id) ? 'sel' : ''}" onClick=${() => toggle(p.id)}>
              <${Emblem} id=${p.emblem} size=${32} /> ${p.name}${p.id === me.id ? ' (you)' : ''}
            </button>`)}
        </div>
        <p class="muted small">Not listed? They can join anytime with the game code.</p>
      </section>

      <button class="btn primary huge" disabled=${busy} onClick=${create}>${busy ? 'Creating…' : 'Start the hunt!'}</button>
    </main>`;
}

// ───────────────────────── board pieces ─────────────────────────

const TIER_STARS = { e: '★', m: '★★', h: '★★★', free: '' };

function Tile({ item, thumb, stamp, win, swapTarget, claimColor, onClick }) {
  const cls = ['tile', `cat-${item.cat}`, `tier-${item.tier}`, thumb && 'done', win && 'win', swapTarget && 'swap-target']
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
        ${TIER_STARS[item.tier] && html`<span class="stars">${TIER_STARS[item.tier]}</span>`}
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
      <h3>Backups <small>${backups.length} left${canUse && backups.length ? ' · tap one, then tap a square to swap' : ''}</small></h3>
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

function PhotoButtons({ onFile, label = 'Take photo' }) {
  const handle = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) onFile(f);
  };
  return html`
    <div class="photo-btns">
      <label class="btn primary huge">📸 ${label}
        <input type="file" accept="image/*" capture="environment" onChange=${handle} hidden /></label>
      <label class="btn ghost">🖼️ Choose from library
        <input type="file" accept="image/*" onChange=${handle} hidden /></label>
    </div>`;
}

function SquareModal({ item, photoId, thumb, by, at, canAct, actionLabel, onFile, onRemove, removeLabel, onClose, note }) {
  const [full, setFull] = useState(null);
  const [busy, setBusy] = useState(false);

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
        ${note && html`<p class="muted center">${note}</p>`}
        ${canAct && html`<${PhotoButtons} label=${actionLabel} onFile=${wrap(onFile)} />`}
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
    ${onRematch && html`<button class="btn small" onClick=${onRematch}>Rematch</button>`}
  </div>`;
}

// ───────────────────────── game screens ─────────────────────────

function GameScreen({ code, me, playersById }) {
  const game = useWatch((cb) => store.watchDoc('games', code, cb), [code]);
  const thumbList = useWatch((cb) => store.watchWhere('thumbs', 'gameId', '==', code, cb), [code]);
  const thumbs = useMemo(() => Object.fromEntries((thumbList || []).map((t) => [t.id, t])), [thumbList]);
  const [joining, setJoining] = useState(false);

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

  const Screen = game.mode === 'bingo' ? BingoGame : VersusGame;
  return html`
    <main class="screen game">
      <nav class="topbar">
        <a class="back" href="#/">‹ Home</a>
        <button class="code-chip" onClick=${share}>Code <b>${code}</b> · Share</button>
      </nav>
      ${!isPlayer && html`
        <div class="banner join-banner">You're watching this game.
          <button class="btn primary small" disabled=${joining} onClick=${join}>${joining ? 'Joining…' : 'Join game'}</button></div>`}
      <${Screen} game=${game} me=${me} playersById=${playersById} thumbs=${thumbs} isPlayer=${isPlayer} onRematch=${rematch} />
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
    const photo = await uploadPhoto(file, game.code, me.id);
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
    else toast('Got it! 📸', 'good');
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
      <span>${game.size}×${game.size} · ${G.WIN_RULES[game.winRule]?.label} · ${G.DIFFICULTY[game.difficulty]?.label}</span>
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
          <span class="pts">${s.found} 📸 · ${s.lines} line${s.lines === 1 ? '' : 's'}${game.winRule === 'most' ? ` · ${s.points}pt` : ''}</span>
        </button>`;
      })}
    </div>

    ${board ? html`
      ${!mine && html`<p class="muted center small">Viewing ${firstName(playersById[board.playerId])}'s board</p>`}
      <${Board} size=${game.size}>
        ${board.items.map((item, i) => {
          const m = board.marks?.[i];
          return html`<${Tile} key=${i} item=${item} thumb=${m && (thumbs[m.photo]?.thumb || PLACEHOLDER)}
            stamp=${m && playersById[board.playerId]?.emblem} win=${score.lineCells.has(i)}
            swapTarget=${swapIdx !== null && canEdit && !m && item.tier !== 'free'} onClick=${() => tapSquare(i)} />`;
        })}
      <//>
      ${mine && html`<${BackupTray} backups=${board.backups} swapIdx=${swapIdx} setSwapIdx=${setSwapIdx} canUse=${canEdit} />`}
    ` : html`<p class="muted center">No board yet.</p>`}

    ${open !== null && board && html`<${SquareModal}
      item=${board.items[open]}
      photoId=${openMark?.photo} thumb=${openMark && thumbs[openMark.photo]?.thumb}
      by=${openMark && playersById[board.playerId]} at=${openMark?.at}
      canAct=${canEdit} actionLabel=${openMark ? 'Retake photo' : 'Take photo'}
      onFile=${markSquare}
      onRemove=${canEdit && openMark ? unmark : null}
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
  const winLine = game.winner && game.winner !== 'draw' ? G.versusWinLine(game, game.winner) : null;
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
    const photo = await uploadPhoto(file, game.code, me.id);
    let res;
    try {
      res = await store.transact('games', game.code, (g) => {
        if (!g || g.winner || g.claims?.[i]) return undefined;
        g.claims = { ...g.claims, [i]: { by: me.id, photo, at: Date.now() } };
        if (G.versusWinLine(g, me.id)) {
          g.winner = me.id;
        } else if (Object.keys(g.claims).length === g.size * g.size) {
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
      toast(c ? `Too slow! ${firstName(playersById[c.by])} got it first.` : 'Game is over!', 'error');
    } else if (res.data.winner !== me.id) toast('Claimed! 🚩', 'good');
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
    <div class="game-info"><span>${game.size}×${game.size} · ${game.connect} in a row wins · ${G.DIFFICULTY[game.difficulty]?.label}</span></div>
    ${over && html`<${WinBanner}
      text=${game.winner === 'draw' ? "IT'S A DRAW!" : game.winner === me.id ? 'YOU WIN!' : `${firstName(winner).toUpperCase()} WINS!`}
      sub=${!winLine && game.winner !== 'draw' ? 'Board full: most squares wins.' : null}
      onRematch=${onRematch} />`}

    <div class="scoreboard">
      ${game.players.map((pid) => {
        const p = playersById[pid];
        return html`<div class="score versus" key=${pid} style=${`--claim:${playerColor(p)}`}>
          <${Emblem} id=${p?.emblem} size=${34} />
          <span class="nm">${pid === me.id ? 'You' : firstName(p)}${game.winner === pid ? ' 🏆' : ''}</span>
          <span class="pts">${counts[pid] || 0} claimed</span>
        </div>`;
      })}
    </div>

    <${Board} size=${game.size}>
      ${game.items.map((item, i) => {
        const c = game.claims?.[i];
        const p = c && playersById[c.by];
        return html`<${Tile} key=${i} item=${item} thumb=${c && (thumbs[c.photo]?.thumb || PLACEHOLDER)}
          stamp=${p?.emblem} claimColor=${p && playerColor(p)} win=${winCells.has(i)}
          swapTarget=${swapIdx !== null && !c} onClick=${() => tapSquare(i)} />`;
      })}
    <//>

    ${isPlayer && !over && html`<${BackupTray} backups=${myBackups || []} swapIdx=${swapIdx} setSwapIdx=${setSwapIdx} canUse=${true} />`}

    ${open !== null && html`<${SquareModal}
      item=${game.items[open]}
      photoId=${openClaim?.photo} thumb=${openClaim && thumbs[openClaim.photo]?.thumb}
      by=${openClaim && playersById[openClaim.by]} at=${openClaim?.at}
      canAct=${isPlayer && !over && !openClaim} actionLabel="Snap it to claim"
      onFile=${claim}
      onRemove=${openClaim?.by === me.id && !over ? unclaim : null} removeLabel="Undo my claim"
      note=${!openClaim && over ? 'Game over.' : !openClaim && !isPlayer ? 'Join the game to claim squares.' : null}
      onClose=${() => setOpen(null)} />`}
  `;
}

// ───────────────────────── app shell ─────────────────────────

function App() {
  const route = useHash();
  const players = useWatch((cb) => store.watchAll('players', cb), []);
  const [meId, setMeId] = useState(loadMe);
  const playersById = useMemo(() => Object.fromEntries((players || []).map((p) => [p.id, p])), [players]);
  const me = meId ? playersById[meId] : null;

  const pick = (id) => { saveMe(id); setMeId(id); if (route[0] === 'profile') go('/'); };

  let body;
  if (players === undefined) body = html`<main class="screen"><p class="muted center">Loading…</p></main>`;
  else if (!me || route[0] === 'profile') body = html`<${ProfileScreen} players=${players} me=${me} onPick=${pick} />`;
  else if (route[0] === 'new') body = html`<${NewGame} mode=${route[1] === 'versus' ? 'versus' : 'bingo'} me=${me} players=${players} key=${route[1]} />`;
  else if (route[0] === 'g' && route[1]) body = html`<${GameScreen} code=${route[1].toUpperCase()} me=${me} playersById=${playersById} key=${route[1]} />`;
  else body = html`<${Home} me=${me} playersById=${playersById} />`;

  return html`${body}<${Toasts} />`;
}

render(html`<${App} />`, document.getElementById('app'));
