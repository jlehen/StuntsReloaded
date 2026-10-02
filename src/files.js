// The game's files (store.js) as the ported code loads them: resources are copied into the
// emulated far heap, where original-layout code expects them.
import { M, rw, rd, farAlloc } from './mem.js';
import { decompress } from './res.js';
import { getFile } from './store.js';

export { FILES, addFile, getFile } from './store.js';

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
