// The game's executable as the original loader builds it. Retail copies have no GAME.EXE: the
// loader (STUNTS.COM / LOAD.EXE) joins <mode>.HDR, EGA.CMN patched with <mode>.DIF, and <mode>.COD
// in memory (restunts src/execombiner). The result is packed with Microsoft EXEPACK, which is
// undone here, giving a plain MZ executable with a relocation table, as restunts' game.exe is.
import { decompress } from './res.js';

const w = (b, o) => b[o] | (b[o + 1] << 8);

// .DIF: a list of (distance to the next patch, 2 or 4 bytes) over the common part.
function applyDif(common, dif) {
  let at = 0, target = -1;
  for (;;) {
    const delta = w(dif, at); at += 2;
    if (!delta) return;
    target += delta & 0x7fff;
    const n = delta & 0x8000 ? 4 : 2;
    common.set(dif.subarray(at, at + n), target);
    at += n;
  }
}

// EXEPACK: the load module is unpacked backwards in place; the stub at the entry segment holds
// the real entry registers and, after its error message, the relocations as 16 lists of offsets
// (one per 64 K of the image).
export function unpackExepack(exe) {
  const hdr = w(exe, 8) * 16, stub = hdr + w(exe, 0x16) * 16;
  const [ip, cs, , stubSize, sp, ss, destParas] = [0, 2, 4, 6, 8, 10, 12].map(o => w(exe, stub + o));
  if (w(exe, stub + 14) !== 0x4252 && w(exe, stub + 16) !== 0x4252) throw new Error('not an EXEPACK executable');
  const size = destParas * 16;
  const image = new Uint8Array(size);
  image.set(exe.subarray(hdr, stub));
  let src = stub - hdr, dst = size;
  while (image[src - 1] === 0xff) src--;
  for (;;) {
    const cmd = image[--src];
    const count = (image[src - 1] << 8) | image[src - 2];
    src -= 2;
    if ((cmd & 0xfe) === 0xb0) { dst -= count; image.fill(image[--src], dst, dst + count); }
    else if ((cmd & 0xfe) === 0xb2) for (let i = 0; i < count; i++) image[--dst] = image[--src];
    else throw new Error('EXEPACK: bad command ' + cmd);
    if (cmd & 1) break;
  }
  const msg = 'Packed file is corrupt';
  let p = stub;
  find: for (;; p++) {
    if (p >= stub + stubSize) throw new Error('EXEPACK: no relocation table');
    for (let i = 0; i < msg.length; i++) if (exe[p + i] !== msg.charCodeAt(i)) continue find;
    break;
  }
  p += msg.length;
  const relocs = [];
  for (let seg = 0; seg < 16; seg++) {
    const n = w(exe, p); p += 2;
    for (let i = 0; i < n; i++, p += 2) relocs.push(w(exe, p), seg << 12);
  }
  // Plain MZ: header, relocation table (offset, segment pairs), image.
  const tbl = 0x1c, hsize = (tbl + relocs.length * 2 + 15) & ~15, total = hsize + size;
  const out = new Uint8Array(total), dv = new DataView(out.buffer);
  out.set(image, hsize);
  const fields = [0x5a4d, total % 512, Math.ceil(total / 512), relocs.length / 2, hsize / 16, w(exe, 10), w(exe, 12), ss, sp, 0, ip, cs, tbl, 0];
  fields.forEach((v, i) => dv.setUint16(i * 2, v, true));
  relocs.forEach((v, i) => dv.setUint16(tbl + i * 2, v, true));
  return out;
}

// GAME.EXE from the retail pieces; get(name) returns a file's bytes or null. mode: MCGA, EGA, ...
export function buildExe(get, mode = 'MCGA') {
  const hdr = get(mode + '.HDR'), cmn = get('EGA.CMN'), cod = get(mode + '.COD');
  if (!hdr || !cmn || !cod) return null;
  const common = decompress(cmn).slice();
  if (mode !== 'EGA') applyDif(common, decompress(get(mode + '.DIF')));
  const code = decompress(cod), hsize = w(hdr, 8) * 16;
  const packed = new Uint8Array(hsize + common.length + code.length);
  packed.set(hdr);
  packed.set(common, hsize);
  packed.set(code, hsize + common.length);
  return unpackExepack(packed);
}

// Which build an executable is ('bb' or 'ms', see version.js), from where its data segment
// starts: the C runtime's copyright string is at DGROUP:8.
export function exeVersion(exe) {
  const hdr = w(exe, 8) * 16, sig = 'MS Run-Time Library';
  find: for (let p = hdr; p < exe.length - sig.length; p++) {
    for (let i = 0; i < sig.length; i++) if (exe[p + i] !== sig.charCodeAt(i)) continue find;
    return { 0x2b770: 'bb', 0x2a9a0: 'ms' }[p - 8 - hdr] ?? null;
  }
  return null;
}
