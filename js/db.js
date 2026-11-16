// Petite couche IndexedDB : tout reste stocké sur le téléphone.
const NAME = 'hikaku';
let dbp;

export function open() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      const stores = [
        ['tracks', { keyPath: 'id' }],
        ['audio'],
        ['covers'],
        ['playlists', { keyPath: 'id' }],
        ['kv'],
      ];
      for (const [n, o] of stores) if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, o);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

const wrap = (r) => new Promise((res, rej) => {
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});

const done = (t) => new Promise((res, rej) => {
  t.oncomplete = () => res();
  t.onerror = () => rej(t.error);
  t.onabort = () => rej(t.error || new DOMException('Transaction annulée', 'AbortError'));
});

export async function get(store, key) {
  const d = await open();
  return wrap(d.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const d = await open();
  return wrap(d.transaction(store).objectStore(store).getAll());
}

export async function entries(store) {
  const d = await open();
  const s = d.transaction(store).objectStore(store);
  const [keys, vals] = await Promise.all([wrap(s.getAllKeys()), wrap(s.getAll())]);
  return keys.map((k, i) => [k, vals[i]]);
}

export async function put(store, val, key) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  if (key === undefined) t.objectStore(store).put(val);
  else t.objectStore(store).put(val, key);
  return done(t);
}

export async function del(store, key) {
  const d = await open();
  const t = d.transaction(store, 'readwrite');
  t.objectStore(store).delete(key);
  return done(t);
}

export async function addTrack(track, buf, cover) {
  const d = await open();
  const t = d.transaction(['tracks', 'audio', 'covers'], 'readwrite');
  t.objectStore('tracks').put(track);
  t.objectStore('audio').put(buf, track.id);
  if (cover) t.objectStore('covers').put(cover.buf, cover.key);
  return done(t);
}

export async function removeTrack(id, coverKey) {
  const d = await open();
  const t = d.transaction(['tracks', 'audio', 'covers'], 'readwrite');
  t.objectStore('tracks').delete(id);
  t.objectStore('audio').delete(id);
  if (coverKey) t.objectStore('covers').delete(coverKey);
  return done(t);
}

export async function clearAll() {
  const d = await open();
  const names = ['tracks', 'audio', 'covers', 'playlists', 'kv'];
  const t = d.transaction(names, 'readwrite');
  for (const n of names) t.objectStore(n).clear();
  return done(t);
}
