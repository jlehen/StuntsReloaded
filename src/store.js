// The original game's files, preloaded so the ported code can load them synchronously like the
// original's DOS I/O. A copy of the game is one of two builds (version.js): the page keeps the
// copies it is given apart, by build, and plays one of them.
import { buildExe, exeVersion } from './exe.js';

export const FILES = new Map(); // upper-case file name -> Uint8Array, of the copy in use
export const CARS = ['COUN', 'ANSX', 'AUDI', 'FGTO', 'JAGU', 'LANC', 'LM02', 'P962', 'PC04', 'PMIN', 'VETT'];
export const BUILDS = { ms: 'Mindscape 4D Sports Driving 1.1 (as playstunts)', bb: 'Broderbund Stunts 1.1' };
export const available = []; // builds there is a copy of (filled by start.js)
// Plays another build: it is fixed when the game's modules load, so the page reloads.
export function chooseBuild(version) {
  localStorage.setItem('stunts.version', version);
  const url = new URL(location.href);
  url.searchParams.delete('version');
  location.replace(url);
}

export function addFile(name, bytes) { FILES.set(name.toUpperCase(), bytes); }
export const getFile = name => FILES.get(name.toUpperCase()) ?? null;

// The executable comes whole (restunts' game.exe) or, in a retail copy, in pieces (exe.js).
const EXE_PIECES = ['MCGA.HDR', 'EGA.CMN', 'MCGA.COD', 'MCGA.DIF'];
// The executable of a copy, given a way to get its files: [bytes, 'bb' | 'ms'], or null.
function findExe(get) {
  const exe = get('GAME.EXE') ?? (EXE_PIECES.every(get) ? buildExe(get) : null);
  const version = exe && exeVersion(exe);
  return version ? [exe, version] : null;
}

const fetchBytes = async url => {
  const r = await fetch(url).catch(() => null); // offline: fall through to the next source
  return r?.ok ? new Uint8Array(await r.arrayBuffer()) : null;
};
// A copy served over HTTP: looks for its executable, then loads `names` once it is chosen.
// lower: the server has lower-case names for these (restunts' game.exe).
async function httpCopy(base, lower = []) {
  const url = n => base + (lower.includes(n) ? n.toLowerCase() : n);
  const got = new Map();
  got.set('GAME.EXE', await fetchBytes(url('GAME.EXE')));
  if (!got.get('GAME.EXE')) await Promise.all(EXE_PIECES.map(async n => got.set(n, await fetchBytes(url(n)))));
  const found = findExe(n => got.get(n) ?? null);
  return found && {
    version: found[1],
    async load(names) {
      addFile('GAME.EXE', found[0]);
      await Promise.all(names.map(async n => { const b = await fetchBytes(url(n)); if (b) addFile(n, b); }));
    },
  };
}

// --- The player's own copies (folder picker, drag and drop, .zip), kept in IndexedDB between
// visits under 'bb/NAME' and 'ms/NAME'.
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
async function cachedCopies() {
  const out = [];
  try {
    const keys = await idb('readonly', st => st.getAllKeys()), all = await idb('readonly', st => st.getAll());
    const files = { bb: new Map(), ms: new Map() };
    keys.forEach((k, i) => {
      const m = String(k).match(/^(bb|ms)\/(.*)$/); // keys without a prefix: a copy cached before there were two builds
      (m ? files[m[1]] : files.bb).set(m ? m[2] : String(k), new Uint8Array(all[i]));
    });
    for (const [, map] of Object.entries(files)) {
      const found = findExe(n => map.get(n) ?? null);
      if (found) out.push({ version: found[1], async load() { for (const [n, b] of map) addFile(n, b); addFile('GAME.EXE', found[0]); } });
    }
  } catch { /* private mode */ }
  return out;
}

// .zip: stored and deflated entries, through the central directory.
async function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = [];
  let end = bytes.length - 22;
  while (end >= 0 && dv.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) return out;
  let p = dv.getUint32(end + 16, true);
  for (let n = dv.getUint16(end + 10, true); n > 0 && dv.getUint32(p, true) === 0x02014b50; n--) {
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nameLen = dv.getUint16(p + 28, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const data = bytes.subarray(local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true)).subarray(0, csize);
    if (method === 0) out.push([name, data]);
    else if (method === 8) out.push([name, new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer())]);
    p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return out;
}
const WANTED = /\.(EXE|HDR|CMN|COD|DIF|P3S|PRE|PVS|PES|RES|TRK|RPL|3SH|VSH)$/;
// Takes dropped or picked files (a folder's, or a .zip of the game): keeps the copy, and returns
// its build ('bb' | 'ms'), or null if there is no game executable among them.
export async function addUserFiles(fileList) {
  const entries = new Map();
  for (const f of fileList) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const items = /\.zip$/i.test(f.name) ? await unzip(bytes) : [[f.name, bytes]];
    for (const [path, b] of items) {
      const name = path.split('/').pop().toUpperCase();
      if (WANTED.test(name)) entries.set(name, b);
    }
  }
  const found = findExe(n => entries.get(n) ?? null);
  if (!found) return null;
  try {
    await idb('readwrite', st => { for (const [n, b] of entries) st.put(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), `${found[1]}/${n}`); });
  } catch { /* private mode: the copy lasts until the page is closed */ }
  pending.push({ version: found[1], async load() { for (const [n, b] of entries) addFile(n, b); addFile('GAME.EXE', found[0]); } });
  return found[1];
}
const pending = []; // copies added during this visit

// The copies at hand, best first: the player's own, then the server's game-ms/ and game/, then
// restunts' on GitHub (Broderbund). Each: { version, load(names) }.
export async function findCopies() {
  const served = await Promise.all([httpCopy('game-ms/'), httpCopy('game/')]);
  const local = [...pending, ...await cachedCopies(), ...served.filter(Boolean)];
  // restunts is only asked when nothing here has the Broderbund build.
  if (!local.some(c => c.version === 'bb')) {
    const r = await httpCopy('https://raw.githubusercontent.com/4d-stunts/restunts/master/stunts/', ['GAME.EXE']);
    if (r) local.push(r);
  }
  return local;
}
