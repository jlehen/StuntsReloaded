// Loaders for the original Stunts data files: compression, RES archives, 3D shapes, palette.
// Ported from restunts c/fileio.c, c/memmgr.c, c/shape3d.c.

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u24 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

// .PRE/.P3S/.PVS: one or more RLE (type 1) / VLE (type 2) passes.
export function decompress(src) {
  let passes = 1, pos = 0;
  if (src[0] & 0x80) { passes = src[0] & 0x7f; pos = 4; }
  let data = src.subarray(pos);
  while (passes--) {
    if (data[0] === 1) data = decompRle(data);
    else if (data[0] === 2) data = decompVle(data);
    else throw new Error('bad compression type ' + data[0]);
  }
  return data;
}

function decompRle(src) {
  const len = u24(src, 1);
  const srclen = u24(src, 4);
  let esclen = src[8];
  const skipseq = esclen & 0x80;
  esclen &= 0x7f;
  const esc = src.subarray(9, 9 + esclen);
  let data = src.subarray(9 + esclen, 9 + esclen + srclen);
  if (!skipseq) data = rleSeq(data, esc[1]);
  const lookup = new Uint8Array(256);
  for (let i = 0; i < esclen; i++) lookup[esc[i]] = i + 1;
  const dst = new Uint8Array(len);
  let s = 0, d = 0;
  while (d < len) {
    const cur = data[s++];
    const k = lookup[cur];
    if (!k) { dst[d++] = cur; continue; }
    let rep;
    if (k === 1) rep = data[s++];
    else if (k === 3) { rep = u16(data, s); s += 2; }
    else rep = k - 1;
    const v = data[s++];
    dst.fill(v, d, d + rep);
    d += rep;
  }
  return dst;
}

// Byte-sequence runs: esc <bytes> esc <count>.
function rleSeq(src, esc) {
  const out = [];
  for (let s = 0; s < src.length;) {
    const cur = src[s++];
    if (cur !== esc) { out.push(cur); continue; }
    const start = s;
    while (src[s] !== esc) s++;
    const seq = src.subarray(start, s);
    const rep = src[s + 1];
    for (let r = 0; r < rep; r++) for (const b of seq) out.push(b);
    s += 2;
  }
  return Uint8Array.from(out);
}

// Variable-length (Huffman-like) codes, straight port of file_decomp_vle.
function decompVle(src) {
  const len = u24(src, 1);
  let s = 4;
  let esclen = src[s++];
  const additive = esclen & 0x80;
  esclen &= 0x7f;
  const wdtpos = s;
  const esc1 = new Uint16Array(16), esc2 = new Uint16Array(16);
  let alphlen = 0;
  for (let i = 0, j = 0; i < esclen; i++, j *= 2) {
    esc1[i] = alphlen - j;
    const t = src[s++];
    j += t; alphlen += t;
    esc2[i] = j;
  }
  const alph = src.slice(s, s + alphlen);
  s += alphlen;
  const codpos = s;
  s = wdtpos;
  const symb = new Uint8Array(256), wdth = new Uint8Array(256).fill(0x40);
  const widthdistr = Math.min(esclen, 8);
  for (let width = 1, i = 0, j = 0, numsymb = 0x80; width <= widthdistr; width++, numsymb >>= 1) {
    for (let n = src[s++]; n > 0; n--, j++) {
      for (let k = numsymb; k; k--, i++) { symb[i] = alph[j]; wdth[i] = width; }
    }
  }
  s = codpos;
  const dst = new Uint8Array(len);
  let d = 0, curword = (src[s] << 8) | src[s + 1], curwdt = 8, cursymb = 0, lenleft = len + 1;
  s += 2;
  while (lenleft) {
    let code = curword >> 8;
    let nextwdt = wdth[code];
    if (nextwdt > 8) {
      code = curword & 0xff;
      curword >>= 8;
      for (let i = 7; ;) {
        if (!curwdt) { code = src[s++]; curwdt = 8; }
        curword = ((curword << 1) + ((code & 0x80) ? 1 : 0)) & 0xffff;
        code = (code << 1) & 0xff;
        curwdt--; i++;
        if (curword < esc2[i]) {
          curword = (curword + esc1[i]) & 0xffff;
          cursymb = additive ? (cursymb + alph[curword]) & 0xff : alph[curword];
          if (d < len) dst[d++] = cursymb;
          lenleft--;
          break;
        }
      }
      curword = ((code << curwdt) | src[s++]) & 0xffff;
      nextwdt = 8 - curwdt;
      curwdt = 8;
    } else {
      cursymb = additive ? (cursymb + symb[code]) & 0xff : symb[code];
      if (d < len) dst[d++] = cursymb;
      lenleft--;
      if (curwdt < nextwdt) {
        curword = (curword << curwdt) & 0xffff;
        nextwdt -= curwdt;
        curwdt = 8;
        curword |= src[s++];
      }
    }
    curword = (curword << nextwdt) & 0xffff;
    curwdt -= nextwdt;
  }
  return dst;
}

// RES archive: u32 size, u16 count, count*4 names, count*u32 offsets, data.
export function parseRes(buf) {
  const n = u16(buf, 4);
  const base = 6 + n * 8;
  const offs = [];
  for (let i = 0; i < n; i++) {
    const name = String.fromCharCode(...buf.subarray(6 + i * 4, 10 + i * 4)).replace(/[\0 ]+$/, '');
    offs.push([name, u32(buf, 6 + n * 4 + i * 4)]);
  }
  const sorted = offs.map(o => o[1]).sort((a, b) => a - b);
  const map = new Map();
  for (const [name, o] of offs) {
    const next = sorted.find(x => x > o) ?? buf.length - base;
    map.set(name, buf.subarray(base + o, base + next));
  }
  return map;
}

// 3D shape: header, verts (3*i16), cull1/cull2 (4 bytes/prim each), primitives.
// Primitive: type, flags, paint per material slot, vertex indices.
// type 1 = dot, 2 = line, 3..10 = polygon, 11 = sphere, 12 = wheel, 13 = ?
export const PRIM_INDEX_COUNT = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 2, 6, 3];
export function parseShape3d(b) {
  const nv = b[0], np = b[1], npaints = b[2];
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const verts = [];
  for (let i = 0; i < nv; i++) verts.push([dv.getInt16(4 + i * 6, true), dv.getInt16(6 + i * 6, true), dv.getInt16(8 + i * 6, true)]);
  let p = 4 + nv * 6 + np * 8;
  const prims = [];
  for (let i = 0; i < np; i++) {
    const type = b[p], flags = b[p + 1];
    const paints = Array.from(b.subarray(p + 2, p + 2 + npaints));
    p += 2 + npaints;
    const idx = Array.from(b.subarray(p, p + PRIM_INDEX_COUNT[type]));
    p += PRIM_INDEX_COUNT[type];
    prims.push({ type, flags, paints, idx });
  }
  return { verts, prims, npaints };
}

// VGA palette from sdmain.pvs "!pal": 16-byte header then 256 * 6-bit RGB.
export function parsePalette(res) {
  const pal = res.get('!pal').subarray(16, 16 + 768);
  return Array.from({ length: 256 }, (_, i) => [0, 1, 2].map(c => (pal[i * 3 + c] * 255 / 63) | 0));
}

export async function loadFile(name) {
  const r = await fetch('game/' + name.toUpperCase());
  if (!r.ok) throw new Error('missing game file ' + name);
  return new Uint8Array(await r.arrayBuffer());
}

// 2D bitmap (PVS/VSH shapes): 16-byte header (width, height, 2 unknown words, x, y, 4 flag
// bytes), then width*height palette indices. Flip type (flags[2] >> 4): 0 row-major,
// 1 column-major, 2 column-major interlaced (file_unflip_shape2d).
export function parseShape2d(b) {
  const w = u16(b, 0), h = u16(b, 2);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const flip = (b[15] & 0xf0) ? 0 : b[14] >> 4;
  const src = b.subarray(16, 16 + w * h);
  let px = src;
  if (flip === 1 || flip === 2) {
    px = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      const sj = flip === 1 ? j : (j & 1) ? ((h + j) >> 1) : j >> 1;
      for (let i = 0; i < w; i++) px[i + j * w] = src[sj + i * h];
    }
  }
  return { width: w, height: h, x: dv.getInt16(8, true), y: dv.getInt16(10, true), pixels: px };
}
