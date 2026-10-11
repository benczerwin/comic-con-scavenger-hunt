// Backend facade. Uses Firestore when configured, otherwise a localStorage demo backend.
// API (both backends):
//   watchDoc(col, id, cb) / watchWhere(col, field, op, value, cb) / watchAll(col, cb) -> unsubscribe
//   getOne(col, id) -> data|null / getWhere(col, field, op, value) -> rows (one-time)
//   put(col, id, data)                 full write (works offline, queued)
//   patch(col, id, changes)            dotted-key partial update; use DELETE to remove a field
//   remove(col, id)
//   transact(col, id, fn)              fn(current|null) -> new full doc, or undefined to abort
import { firebaseConfig } from './firebase-config.js';

export const DELETE = { __delete: true };

const configured = !!firebaseConfig?.projectId && !firebaseConfig.projectId.startsWith('YOUR');
const forceLocal = new URLSearchParams(location.search).has('local');

export const backend = configured && !forceLocal
  ? await import('./store-firebase.js')
  : await import('./store-local.js');

export const isLive = backend.isLive;
export const { watchDoc, watchWhere, watchAll, getOne, getWhere, put, patch, remove } = backend;

// Transactions need the server, so on slow Wi-Fi they can take a while. Track them so the UI can show
// "Saving…", and give up after a bit instead of hanging forever.
let pending = 0;
const pendingListeners = new Set();
const emitPending = () => pendingListeners.forEach((cb) => cb(pending));
export const onPending = (cb) => { pendingListeners.add(cb); return () => pendingListeners.delete(cb); };
// A save that times out usually means the connection is wedged (a reload always clears it), so tell the UI.
const stuckListeners = new Set();
export const onStuck = (cb) => { stuckListeners.add(cb); return () => stuckListeners.delete(cb); };
export async function transact(col, id, fn) {
  pending++; emitPending();
  let timer;
  try {
    return await Promise.race([
      backend.transact(col, id, fn),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          backend.resetNetwork?.();
          stuckListeners.forEach((cb) => cb());
          reject(new Error('The connection is slow. Try again in a moment.'));
        }, 12000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    pending--; emitPending();
  }
}
