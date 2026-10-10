import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, query, where, onSnapshot, getDoc, getDocFromCache, getDocs, setDoc, updateDoc, deleteDoc,
  runTransaction, deleteField,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

export const isLive = true;

const app = initializeApp(firebaseConfig);
// Offline cache: the board still works on spotty convention Wi-Fi; writes sync when back online.
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});

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
