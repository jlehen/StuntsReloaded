// Emulated real-mode memory shared by the whole port. GAME.EXE's image is loaded at
// linear 0x10000 (segment 0x1000, as in IDA and the test oracle), so its data segment
// (DGROUP) sits at linear 0x3B770 and every original global lives at its original address.
// The Mindscape build (version.js) is loaded a little higher, so that its shorter code leaves
// DGROUP at the same place; its globals have their own offsets (dseg-labels-ms.js).
// Ported code reads/writes memory with C-like type semantics: stores wrap to the type width.
import LABELS_BB from './dseg-labels.js';
import LABELS_MS from './dseg-labels-ms.js';
import { MS } from './version.js';

const LABELS = MS ? LABELS_MS : LABELS_BB;

export const M = new Uint8Array(0x110000);
const V = new DataView(M.buffer);
export const DSEG = 0x3B77;
export const DS = DSEG << 4;

export const rb = a => M[a];
export const rsb = a => (M[a] << 24) >> 24;
export const rw = a => V.getUint16(a, true);
export const rsw = a => V.getInt16(a, true);
export const rd = a => V.getUint32(a, true);
export const rsd = a => V.getInt32(a, true);
export const wb = (a, v) => { M[a] = v; };
export const ww = (a, v) => V.setInt16(a, v, true);
export const wd = (a, v) => V.setInt32(a, v, true);

// C integer semantics for intermediate results (16-bit int, 32-bit long).
export const s8 = v => (v << 24) >> 24;
export const u8 = v => v & 0xff;
export const s16 = v => (v << 16) >> 16;
export const u16 = v => v & 0xffff;
export const s32 = v => v | 0;
export const u32 = v => v >>> 0;
// Signed 16-bit v / 2^n rounding toward zero, as the Mindscape build computes it (cwd; xor ax,dx;
// sub ax,dx; sar ax,n; xor ax,dx; sub ax,dx) where the Broderbund build has a plain sar.
export const sdiv2 = (v, n) => { v = s16(v); const d = v >> 15; return s16(((s16((v ^ d) - d) >> n) ^ d) - d); };
// Its signed 16-bit v / 2 (cwd; sub ax,dx; sar ax,1): also toward zero, but -32768 gives -16384.
export const shalf = v => s16(s16(v) - (s16(v) >> 15)) >> 1;
// C truncating division / remainder (and 16-bit int versions).
export const div = (a, b) => Math.trunc(a / b);
export const idiv16 = (a, b) => s16(Math.trunc(s16(a) / s16(b)));

// Pointers: near = DS offset, far = seg:off stored in memory.
export const near = off => DS + (off & 0xffff);
export const farptr = a => ((rw(a + 2) << 4) + rw(a)) & 0xfffff; // deref a far pointer variable at a
// Far pointer variable at a, plus a 16-bit offset (wraps within the segment like seg:off math).
export const farptrAt = (a, delta) => ((rw(a + 2) << 4) + ((rw(a) + delta) & 0xffff)) & 0xfffff;
export const setFarptr = (a, lin) => { ww(a, lin & 15); ww(a + 2, lin >> 4); };

// Label addresses: A.name -> linear address of the global. A global the loaded build lacks
// throws when used, so a port cannot silently touch address NaN.
export const A = Object.fromEntries(Object.entries(LABELS).map(([k, [o]]) => [k, DS + o]));
for (const k of Object.keys(LABELS_BB)) {
  if (!(k in LABELS)) Object.defineProperty(A, k, { get() { throw new Error(`global ${k} does not exist in this build`); } });
}
// G.name: scalar global access with the declared width (db/dw/dd), signed.
// U.name: same, unsigned. Arrays: use A.name with rb/rw/... helpers.
export const G = {}, U = {};
for (const [k, [o, w]] of Object.entries(LABELS)) {
  const a = DS + o;
  const [gs, gu, st] = w === 1 ? [rsb, rb, wb] : w === 2 ? [rsw, rw, ww] : [rsd, rd, wd];
  Object.defineProperty(G, k, { get: () => gs(a), set: v => st(a, v), enumerable: true });
  Object.defineProperty(U, k, { get: () => gu(a), set: v => st(a, v), enumerable: true });
}

// --- Structs: views over memory with typed field accessors.
const PRIM = {
  i8: [1, rsb, wb], u8: [1, rb, wb], i16: [2, rsw, ww], u16: [2, rw, ww], i32: [4, rsd, wd], u32: [4, rd, wd],
};
// Array views: v[i] get/set with element type; element struct types return views.
function arrayView(type, n, a) {
  const size = sizeOf(type);
  const o = { addr: a, length: n };
  for (let i = 0; i < n; i++) {
    const ea = a + i * size;
    if (typeof type === 'string') {
      const [, get, set] = PRIM[type];
      Object.defineProperty(o, i, { get: () => get(ea), set: v => set(ea, v) });
    } else {
      Object.defineProperty(o, i, { get: () => new type(ea), set: v => copyStruct(type, ea, v.addr) });
    }
  }
  return o;
}
export const sizeOf = t => typeof t === 'string' ? PRIM[t][0] : t.size;
export const copyStruct = (type, dst, src) => M.copyWithin(dst, src, src + type.size);

// struct([['name', type], ['arr', type, count], ...]) -> class with .addr and field accessors.
// Assigning a struct field copies bytes (C struct assignment); v.$field gives the field address.
export function struct(fields, expectSize) {
  class S { constructor(addr) { this.addr = addr; } }
  let off = 0;
  S.offsets = {};
  for (const [name, type, count] of fields) {
    const o = off;
    S.offsets[name] = o;
    const size = sizeOf(type) * (count ?? 1);
    Object.defineProperty(S.prototype, '$' + name, { get() { return this.addr + o; } });
    if (count !== undefined) {
      Object.defineProperty(S.prototype, name, { get() { return arrayView(type, count, this.addr + o); } });
    } else if (typeof type === 'string') {
      const [, get, set] = PRIM[type];
      Object.defineProperty(S.prototype, name, { get() { return get(this.addr + o); }, set(v) { set(this.addr + o, v); } });
    } else {
      Object.defineProperty(S.prototype, name, {
        get() { return new type(this.addr + o); },
        set(v) { copyStruct(type, this.addr + o, v.addr); },
      });
    }
    off += size;
  }
  S.size = off;
  if (expectSize !== undefined && off !== expectSize) throw new Error(`struct size ${off} != ${expectSize}`);
  return S;
}

// --- Scratch "stack" for locals whose address is taken (vectors, matrices...).
// Lives in unused DGROUP space (BSS ends at 0xAD20) below the oracle's stack (0xD800..0xFFF0).
const STACK_TOP = DS + 0xd800, STACK_LIMIT = DS + 0xb000;
let sp = STACK_TOP;
export function alloca(size) {
  sp -= (size + 1) & ~1;
  if (sp < STACK_LIMIT) throw new Error('alloca: stack overflow');
  M.fill(0, sp, sp + size);
  return sp;
}
export const stackMark = () => sp;
export const stackRelease = mark => { sp = mark; };
// Run fn with a stack frame released afterwards (on all paths).
export function frame(fn) { const m = sp; try { return fn(); } finally { sp = m; } }
export const local = (type, count = 1) => {
  const a = alloca(sizeOf(type) * count);
  return count === 1 && typeof type !== 'string' ? new type(a) : a;
};

// --- Far heap: paragraph-aligned bump allocator above the exe image.
const HEAP_START = 0x50000, HEAP_END = 0x100000;
let heap = HEAP_START;
export function farAlloc(bytes) {
  const a = heap;
  heap = (heap + bytes + 15) & ~15;
  if (heap > HEAP_END) throw new Error('far heap exhausted');
  M.fill(0, a, a + bytes);
  return a;
}
export const heapReset = (to = HEAP_START) => { heap = to; };
export const heapMark = () => heap;

// Load the MZ image (with relocations) at segment LOAD_SEG: initializes DGROUP exactly
// as the original's data segment. BSS beyond the image is zeroed.
export const LOAD_SEG = MS ? 0x10dd : 0x1000;
export function loadExe(exe, seg = LOAD_SEG) {
  const w = o => exe[o] | (exe[o + 1] << 8);
  const hdr = w(8) * 16, nrel = w(6), relo = w(0x18);
  let size = w(4) * 512 - hdr; if (w(2)) size -= 512 - w(2);
  M.fill(0);
  M.set(exe.subarray(hdr, hdr + size), seg * 16);
  for (let i = 0; i < nrel; i++) {
    const a = (seg + w(relo + i * 4 + 2)) * 16 + w(relo + i * 4);
    ww(a, (rw(a) + seg) & 0xffff);
  }
  heapReset();
  sp = STACK_TOP;
}
