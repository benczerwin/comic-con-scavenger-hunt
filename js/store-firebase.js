import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache, disableNetwork, enableNetwork,
  doc, collection, query, where, onSnapshot, getDoc, getDocFromCache, getDocs, setDoc, updateDoc, deleteDoc,
  runTransaction, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export const isLive = true;

const app = initializeApp(firebaseConfig);
// iOS Safari can lose its IndexedDB connection while the tab sits in the background. Firestore's on-disk cache
// then wedges, and every save after that hangs until the page is reloaded. So on iPhone/iPad keep the cache in
// memory (saves still queue while offline); elsewhere keep the on-disk cache for spotty con Wi-Fi.
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const db = initializeFirestore(app, {
  localCache: isIOS ? memoryLocalCache() : persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

// Phones drop the live connection while the screen is off or the app is in the background, and Firestore can be
// slow to notice. Kick it when we come back, and whenever the browser says the network is back.
export async function resetNetwork() {
  try { await disableNetwork(db); await enableNetwork(db); } catch (e) { logErr('reset network')(e); }
}
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > 15000) resetNetwork();
});
addEventListener('online', resetNetwork);

const withId = (snap) => (snap.exists() ? { id: snap.id, ...snap.data() } : null);
const logErr = (where) => (e) => console.error(`[firestore] ${where}`, e);

export function watchDoc(col, id, cb) {
  return onSnapshot(doc(db, col, id), (s) => cb(withId(s)), logErr(`watch ${col}/${id}`));
}

export function watchWhere(col, field, op, value, cb) {
  const q = query(collection(db, col), where(field, op, value));
  return onSnapshot(q, (s) => cb(s.docs.map(withId)), logErr(`query ${col}`));
}

export function watchAll(col, cb) {
  return onSnapshot(collection(db, col), (s) => cb(s.docs.map(withId)), logErr(`all ${col}`));
}

export async function getOne(col, id) {
  const ref = doc(db, col, id);
  try {
    return withId(await getDoc(ref));
  } catch (e) {
    try { return withId(await getDocFromCache(ref)); } catch { return null; }
  }
}

// Writes resolve only once the server acks, so callers shouldn't block the UI on them.
export function put(col, id, data) {
  return setDoc(doc(db, col, id), data).catch((e) => { logErr(`put ${col}/${id}`)(e); throw e; });
}

export function patch(col, id, changes) {
  const out = {};
  for (const [k, v] of Object.entries(changes)) out[k] = v && v.__delete ? deleteField() : v;
  return updateDoc(doc(db, col, id), out).catch((e) => { logErr(`patch ${col}/${id}`)(e); throw e; });
}

export async function transact(col, id, fn) {
  const ref = doc(db, col, id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.exists() ? snap.data() : null;
    const next = fn(cur ? structuredClone(cur) : null);
    if (next === undefined) return { ok: false, data: cur };
    tx.set(ref, next);
    return { ok: true, data: next };
  });
}

export async function getWhere(col, field, op, value) {
  const snap = await getDocs(query(collection(db, col), where(field, op, value)));
  return snap.docs.map(withId);
}

export function remove(col, id) {
  return deleteDoc(doc(db, col, id)).catch((e) => { logErr(`remove ${col}/${id}`)(e); throw e; });
}
