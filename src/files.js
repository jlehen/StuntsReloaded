// Game files, preloaded so ported code can load synchronously like the original's DOS I/O.
// Resources are copied into the emulated far heap, where original-layout code expects them.
import { M, rw, rd, farAlloc } from './mem.js';
import { decompress } from './res.js';

export const FILES = new Map(); // upper-case file name -> Uint8Array

export function addFile(name, bytes) { FILES.set(name.toUpperCase(), bytes); }
export const getFile = name => FILES.get(name.toUpperCase()) ?? null;

// Browser: fetch the whole game directory listing we know about.
export async function preload(names, base = 'game/') {
  await Promise.all(names.map(async n => {
    const r = await fetch(base + n);
    if (r.ok) addFile(n, new Uint8Array(await r.arrayBuffer()));
  }));
}

// Copy bytes into the far heap; returns the linear address.
export function toHeap(bytes) {
  const a = farAlloc(bytes.length);
  M.set(bytes, a);
  return a;
}

// file_load_binary / file_decomp: raw or decompressed file in the far heap, or 0.
export function loadBinary(name) { const f = getFile(name); return f ? toHeap(f) : 0; }
export function loadDecomp(name) { const f = getFile(name); return f ? toHeap(decompress(f)) : 0; }
// file_load_resfile: name.res, else name.pre (compressed).
export const loadResfile = name => loadBinary(name + '.res') || loadDecomp(name + '.pre');
// file_load_3dres: name.p3s (compressed), else name.3sh.
export const load3dres = name => loadDecomp(name + '.p3s') || loadBinary(name + '.3sh');

// locate_resource: find a 4-char named chunk in a RES archive at linear address res.
export function locateResource(res, name) {
  const n = rw(res + 4);
  const key = (name + '    ').slice(0, 4);
  for (let j = 0; j < n; j++) {
    const p = res + 6 + j * 4;
    let i = 0;
    for (; i < 4; i++) if (M[p + i] !== key.charCodeAt(i)) break;
    if (i === 4 || (M[p + i] === 0 && key.charCodeAt(i) === 0x20)) return res + n * 8 + 6 + rd(res + 6 + n * 4 + j * 4);
  }
  return 0;
}

// User-supplied game files (folder picker / drag and drop), cached in IndexedDB between visits.
const DB = 'stunts-files';
function idb(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('files');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('files', mode);
      const r = fn(tx.objectStore('files'));
      tx.oncomplete = () => resolve(r?.result);
      tx.onerror = () => reject(tx.error);
    };
  });
}
export async function loadCachedFiles() {
  try {
    const all = await idb('readonly', st => st.getAll());
    const keys = await idb('readonly', st => st.getAllKeys());
    keys?.forEach((k, i) => addFile(k, new Uint8Array(all[i])));
    return !!keys?.length;
  } catch { return false; }
}
export async function addUserFiles(fileList) {
  const entries = [];
  for (const f of fileList) {
    const name = f.name.toUpperCase();
    if (/\.(EXE|P3S|PRE|PVS|PES|RES|TRK|RPL|3SH|VSH)$/.test(name)) entries.push([name, new Uint8Array(await f.arrayBuffer())]);
  }
  for (const [n, b] of entries) addFile(n, b);
  try { await idb('readwrite', st => { for (const [n, b] of entries) st.put(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), n); }); } catch { /* private mode */ }
  return entries.length;
}
