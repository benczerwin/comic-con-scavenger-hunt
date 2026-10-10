// Demo backend: localStorage + BroadcastChannel. Syncs between tabs on ONE device only.
export const isLive = false;

const listeners = new Set();
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('nycc-hunt') : null;
const key = (col) => `nycc-hunt:${col}`;

function load(col) {
  try { return JSON.parse(localStorage.getItem(key(col)) || '{}'); } catch { return {}; }
}
function save(col, all) {
  try {
    localStorage.setItem(key(col), JSON.stringify(all));
  } catch (e) {
    console.warn('Local storage is full — demo mode cannot keep more photos.', e);
    throw new Error('This device ran out of demo storage. Connect Firebase for real games.');
  }
  notify(col);
  channel?.postMessage(col);
}
function notify(col) {
  for (const l of listeners) if (l.col === col) l.run();
}
channel?.addEventListener('message', (e) => notify(e.data));

function listen(col, run) {
  const l = { col, run };
  listeners.add(l);
  queueMicrotask(run);
  return () => listeners.delete(l);
}

const rows = (col) => Object.entries(load(col)).map(([id, d]) => ({ id, ...d }));

export const watchDoc = (col, id, cb) =>
  listen(col, () => { const d = load(col)[id]; cb(d ? { id, ...d } : null); });

export const watchAll = (col, cb) => listen(col, () => cb(rows(col)));

export const watchWhere = (col, field, op, value, cb) =>
  listen(col, () => cb(rows(col).filter((r) =>
    op === 'array-contains' ? (r[field] || []).includes(value) : r[field] === value)));

export async function getOne(col, id) {
  const d = load(col)[id];
  return d ? { id, ...d } : null;
}

export async function put(col, id, data) {
  const all = load(col);
  all[id] = structuredClone(data);
  save(col, all);
}

export async function patch(col, id, changes) {
  const all = load(col);
  const d = all[id] || {};
  for (const [path, v] of Object.entries(changes)) {
    const parts = path.split('.');
    let o = d;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    const last = parts.at(-1);
    if (v && v.__delete) delete o[last]; else o[last] = structuredClone(v);
  }
  all[id] = d;
  save(col, all);
}

export async function transact(col, id, fn) {
  const all = load(col);
  const cur = all[id] ? structuredClone(all[id]) : null;
  const next = fn(cur);
  if (next === undefined) return { ok: false, data: all[id] || null };
  all[id] = next;
  save(col, all);
  return { ok: true, data: next };
}
