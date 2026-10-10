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
export const { watchDoc, watchWhere, watchAll, getOne, getWhere, put, patch, transact, remove } = backend;
