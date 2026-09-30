// Fixed-point math, ported from the original asm (seg006/seg011/seg012, seg001 plane ops).
// Angles: 0..0x3FF per turn. Unit length: 0x4000 (matrices, sin/cos). All vectors/matrices
// are addresses in emulated memory (see mem.js), so aliasing and 16-bit wrap match the original.
import { M, A, G, rb, rw, rsw, ww, s16, u16, farptr, farptrAt, frame, alloca } from './mem.js';
import { M11, M21, M31, M12, M22, M32, M13, M23, M33 } from './structs.js';

// Signed 32/16 division as the 8086 idiv: truncates; quotient must fit int16. The original
// div0 handler would resume mid-instruction on overflow, so treat it as a bug if reached.
export function idiv(num32, den16) {
  const q = Math.trunc(num32 / den16);
  if (den16 === 0 || q > 32767 || q < -32768) throw new Error(`divide overflow ${num32}/${den16}`);
  return q;
}
const mulhi14 = (a, b) => s16((a * b) >> 14); // imul; shl ax,1; rcl dx,1 (x2): high word of p<<2

export function sin_fast(s) {
  const c = s & 0xff;
  switch ((s >> 8) & 3) {
    case 0: return rsw(A.sinetable + c * 2);
    case 1: return rsw(A.sinetable + (0x100 - c) * 2);
    case 2: return s16(-rsw(A.sinetable + c * 2));
    default: return s16(-rsw(A.sinetable + (0x100 - c) * 2));
  }
}
export const cos_fast = s => sin_fast(u16(s + 0x100));

// Angle of (z, y) where (0, y>0) is 0 and (z>0, 0) is 0x100. Returns int16.
// polarAngle(0, 0) returns the caller's AX in the original; pass it as ax.
export function polarAngle(z, y, ax = 0) {
  z = s16(z); y = s16(y);
  let f = 0;
  if (z < 0) { f |= 4; z = s16(-z); }
  if (y < 0) { f |= 2; y = s16(-y); }
  let r;
  if (z === y) {
    if (z === 0) return s16(ax);
    r = 0x80;
  } else {
    let lo = z & 0xffff, hi = y & 0xffff; // after neg, -32768 stays 0x8000 (unsigned div)
    if (s16(z) > s16(y)) { [lo, hi] = [hi, lo]; f |= 1; }
    const q = Math.floor(lo * 65536 / hi);
    r = rb(A.atantable + (q >> 8) + ((q & 0xff) >= 0x80 ? 1 : 0));
  }
  switch (f) {
    case 0: return r;
    case 1: return s16(0x100 - r);
    case 2: return s16(0x200 - r);
    case 3: return s16(r + 0x100);
    case 4: return s16(-r);
    case 5: return s16(r - 0x100);
    case 6: return s16(r - 0x200);
    default: return s16(-(r + 0x100));
  }
}

export function polarRadius2D(z, y) {
  let a = polarAngle(z, y, z);
  if (a < 0) a = s16(-a);
  if (a >= 0x100) a = s16(-(a - 0x200));
  let d, v;
  if (a <= 0x80) { d = cos_fast(a) & 0xffff; v = s16(y); } else { d = sin_fast(a) & 0xffff; v = s16(z); }
  if (v < 0) v = s16(-v);
  const num = (v * 16384) >>> 0; // sar/rcr: signed 32-bit v<<14, divided unsigned
  const q = Math.floor(num / d);
  if (q > 0xffff) throw new Error('polarRadius2D overflow');
  return s16(q);
}
export const polarRadius3D = v => polarRadius2D(polarRadius2D(rsw(v), rsw(v + 2)), rsw(v + 4));

// out = mat * in (vectors as columns). Terms with a zero factor are skipped, as in the original.
export function mat_mul_vector(inv, mat, out) {
  for (let row = 0; row < 3; row++) {
    const m = [mat + (M11 + row) * 2, mat + (M12 + row) * 2, mat + (M13 + row) * 2];
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const a = rsw(m[k]), b = rsw(inv + k * 2);
      if (a !== 0 && b !== 0) acc = s16(acc + mulhi14(a, b));
      ww(out + row * 2, acc); // stored after each term, like the original
    }
  }
}
// Same, with the (far) matrix copied first (to the stack, so out never aliases it).
export function mat_mul_vector2(inv, mat, out) {
  frame(() => {
    const t = alloca(18);
    M.copyWithin(t, mat, mat + 18);
    mat_mul_vector(inv, t, out);
  });
}

// out = r * l, element by element in the original order (so aliasing matches).
export function mat_multiply(r, l, out) {
  let si = r, bx = l, di = out;
  for (let cx = 9; cx > 0; cx--) {
    let acc = 0;
    let a = rsw(si), b = rsw(bx);
    if (a !== 0 && b !== 0) acc = mulhi14(a, b);
    ww(di, acc);
    a = rsw(si + 2); b = rsw(bx + 6);
    if (a !== 0 && b !== 0) ww(di, rsw(di) + mulhi14(a, b));
    a = rsw(si + 4); b = rsw(bx + 12);
    if (a !== 0 && b !== 0) ww(di, rsw(di) + mulhi14(a, b));
    di += 2;
    if (cx === 7 || cx === 4) { bx -= 4; si += 6; } else bx += 2;
  }
}

export function mat_invert(inm, out) {
  if (inm === out) {
    for (const [i, j] of [[M21, M12], [M31, M13], [M32, M23]]) {
      const t = rw(inm + j * 2); ww(inm + j * 2, rw(inm + i * 2)); ww(inm + i * 2, t);
    }
    return;
  }
  const map = [[M11, M11], [M12, M21], [M13, M31], [M21, M12], [M22, M22], [M23, M32], [M31, M13], [M32, M23], [M33, M33]];
  for (const [o, i] of map) ww(out + o * 2, rw(inm + i * 2));
}

function setMat(out, v) { for (let i = 0; i < 9; i++) ww(out + i * 2, v[i]); }
// vals order: _11 _21 _31 _12 _22 _32 _13 _23 _33
export function mat_rot_x(out, angle) {
  const c = cos_fast(angle), s = sin_fast(angle);
  setMat(out, [0x4000, 0, 0, 0, c, s, 0, -s, c]);
}
export function mat_rot_y(out, angle) {
  const c = cos_fast(angle), s = sin_fast(angle);
  setMat(out, [c, 0, -s, 0, 0x4000, 0, s, 0, c]);
}
export function mat_rot_z(out, angle) {
  const c = cos_fast(angle), s = sin_fast(angle);
  setMat(out, [c, s, 0, -s, c, 0, 0, 0, 0x4000]);
}

// Rotation matrix from z, x, y angles; returns the address of the resulting matrix
// (one of several globals, exactly as the original). flag bit 0 selects multiply order.
export function mat_rot_zxy(z, x, y, flag) {
  let si = 0, di = 0;
  if (z & 0x3ff) { si = 4; mat_rot_z(A.mat_z_rot, z); }
  if (x & 0x3ff) { si |= 2; mat_rot_x(A.mat_x_rot, x); }
  if (y & 0x3ff) {
    si |= 1;
    const ya = y & 0x3ff;
    if (ya === U16(G.mat_y_rot_angle)) di = A.mat_y_rot;
    else if (ya === 0x100) di = A.mat_y100;
    else if (ya === 0x200) di = A.mat_y200;
    else if (ya === 0x300) di = A.mat_y300;
    else { mat_rot_y(A.mat_y_rot, y); G.mat_y_rot_angle = ya; di = A.mat_y_rot; }
  }
  const T = A.mat_rot_temp, X = A.mat_x_rot, Z = A.mat_z_rot;
  switch (si) {
    case 0: return A.mat_y0;
    case 1: return di;
    case 2: return X;
    case 3: if (flag & 1) mat_multiply(di, X, T); else mat_multiply(X, di, T); return T;
    case 4: return Z;
    case 5: if (flag & 1) mat_multiply(di, Z, T); else mat_multiply(Z, di, T); return T;
    case 6: if (flag & 1) mat_multiply(X, Z, T); else mat_multiply(Z, X, T); return T;
    case 7:
      if (flag & 1) { mat_multiply(di, X, T); mat_multiply(T, Z, X); return X; }
      mat_multiply(Z, X, T); mat_multiply(T, di, Z); return Z;
  }
}
const U16 = v => v & 0xffff;

export function multiply_and_scale(a, b) {
  const p = s16(a) * s16(b);
  return s16((p >> 14) + ((p >> 13) & 1));
}

// Interpolate out.x/out.y at out.z = i along the segment v2 -> v1.
export function vector_op_unk(v1, v2, out, i) {
  ww(out + 4, i);
  let v4 = u16(i - rsw(v2 + 4));
  let d = u16(rsw(v1 + 4) - rsw(v2 + 4));
  if (d & 0x8000) { v4 >>>= 1; d >>>= 1; } // logical shifts, as the original
  const vs = s16(v4), ds = s16(d);
  ww(out, idiv(s16(rsw(v1) - rsw(v2)) * vs, ds) + rsw(v2));
  ww(out + 2, idiv(s16(rsw(v1 + 2) - rsw(v2 + 2)) * vs, ds) + rsw(v2 + 2));
}

// (x, y, z) . normal / 0x2000 (normal has length 0x2000). normal is a linear address.
export function vec_normalInnerProduct(x, y, z, n) {
  const sum = (s16(x) * rsw(n) + s16(z) * rsw(n + 4) + s16(y) * rsw(n + 2)) | 0;
  return s16(Math.trunc(sum / 0x2000));
}

// PLANE: yz@0 xy@2 origin@4 normal@10 rotation@16, 34 bytes.
export const planeAddr = idx => farptrAt(A.planptr, idx * 34);
// Signed distance of (x, y, z) from plane idx (just height for the 4 flat planes).
export function plane_origin_op(idx, x, y, z) {
  const p = idx === G.planindex ? farptr(A.current_planptr) : planeAddr(idx);
  const ay = s16(y - s16(rsw(p + 6) + G.terrainHeight));
  if (idx < 4) return ay;
  const ax = s16(x - s16(rsw(p + 4) + G.elem_xCenter));
  const az = s16(z - s16(rsw(p + 8) + G.elem_zCenter));
  return vec_normalInnerProduct(ax, ay, az, p + 10);
}

// Register the verified ports with the call layer.
import { provide } from './calls.js';
provide({
  sin_fast, cos_fast, polarAngle, polarRadius2D, polarRadius3D, mat_mul_vector, mat_mul_vector2,
  mat_multiply, mat_invert, mat_rot_x, mat_rot_y, mat_rot_z, mat_rot_zxy, multiply_and_scale,
  vector_op_unk, vec_normalInnerProduct, plane_origin_op,
});
export const MATH_PORTS = ['sin_fast', 'cos_fast', 'polarAngle', 'polarRadius2D', 'polarRadius3D', 'mat_mul_vector',
  'mat_mul_vector2', 'mat_multiply', 'mat_invert', 'mat_rot_x', 'mat_rot_y', 'mat_rot_z', 'mat_rot_zxy',
  'multiply_and_scale', 'vector_op_unk', 'vec_normalInnerProduct', 'plane_origin_op'];
export const PORTS = MATH_PORTS;
