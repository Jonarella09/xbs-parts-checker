// IndexedDB key-value storage with an in-memory fallback (private windows, blocked storage).
const NAME = 'the-indexer', VER = 1, STORES = ['projects', 'files', 'meta'];
let dbp = null, mem = null;

function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
function doneP(t) { return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); }); }

function open() {
  if (dbp) return dbp;
  dbp = new Promise((res) => {
    let r;
    try { r = indexedDB.open(NAME, VER); } catch (e) { useMem(); res(null); return; }
    r.onupgradeneeded = () => { const d = r.result; for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => { useMem(); res(null); };
    r.onblocked = () => { useMem(); res(null); };
  });
  return dbp;
}
function useMem() { if (!mem) { mem = {}; STORES.forEach((s) => (mem[s] = new Map())); } }
export const persistent = async () => !!(await open());

export async function get(store, key) {
  const d = await open(); if (!d) return mem[store].get(key);
  return reqP(d.transaction(store).objectStore(store).get(key));
}
export async function put(store, key, val) {
  const d = await open(); if (!d) { mem[store].set(key, val); return; }
  const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(val, key); return doneP(t);
}
export async function putMany(store, entries) {
  const d = await open(); if (!d) { for (const [k, v] of entries) mem[store].set(k, v); return; }
  const t = d.transaction(store, 'readwrite'); const s = t.objectStore(store);
  for (const [k, v] of entries) s.put(v, k);
  return doneP(t);
}
export async function del(store, key) {
  const d = await open(); if (!d) { mem[store].delete(key); return; }
  const t = d.transaction(store, 'readwrite'); t.objectStore(store).delete(key); return doneP(t);
}
const range = (p) => IDBKeyRange.bound(p, p + '￿');
export async function keys(store, prefix) {
  const d = await open(); if (!d) return [...mem[store].keys()].filter((k) => !prefix || k.startsWith(prefix));
  return reqP(d.transaction(store).objectStore(store).getAllKeys(prefix ? range(prefix) : undefined));
}
export async function all(store) {
  const d = await open(); if (!d) return [...mem[store].values()];
  return reqP(d.transaction(store).objectStore(store).getAll());
}
export async function delPrefix(store, prefix) {
  const d = await open(); if (!d) { for (const k of [...mem[store].keys()]) if (k.startsWith(prefix)) mem[store].delete(k); return; }
  const t = d.transaction(store, 'readwrite'); t.objectStore(store).delete(range(prefix)); return doneP(t);
}
export async function askPersist() { try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {} return false; }
