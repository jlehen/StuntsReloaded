// Differential tests: src/math.js vs the original functions.
import { DS, ww, wd, setFarptr, farAlloc, G, A } from '../src/mem.js';
import * as m from '../src/math.js';
import { oracle, fuzz, rnd, SCRATCH_OFF as S } from './difftest.mjs';

const o = oracle.call;
const vec = (off, x, y, z) => { ww(DS + off, x); ww(DS + off + 2, y); ww(DS + off + 4, z); };
const rv = () => rnd(0, 1) ? rnd(-400, 400) : rnd(-32000, 32000);
const rmat = off => { for (let i = 0; i < 9; i++) ww(DS + off + i * 2, rnd(0, 3) ? rnd(-16384, 16384) : 0); };
const ang = () => rnd(0, 4) === 0 ? rnd(0, 3) * 256 : rnd(-2048, 2048);
const N = 3000;
let ok = true;


ok &= fuzz('sin_fast', 1024, i => [i, () => m.sin_fast(i), () => o('sin_fast', i)]);
ok &= fuzz('cos_fast', 1024, i => [i, () => m.cos_fast(i * 7), () => o('cos_fast', i * 7)]);
ok &= fuzz('polarAngle', N, () => { const z = rv(), y = rv(); return [`${z},${y}`, () => m.polarAngle(z, y, z), () => o('polarAngle', z, y)]; });
ok &= fuzz('polarRadius2D', N, () => { const z = rnd(-20000, 20000), y = rnd(-20000, 20000); return [`${z},${y}`, () => m.polarRadius2D(z, y), () => o('polarRadius2D', z, y)]; });
ok &= fuzz('polarRadius3D', N, () => { const v = [rnd(-9000, 9000), rnd(-9000, 9000), rnd(-9000, 9000)]; vec(S, ...v); return [v.join(','), () => m.polarRadius3D(DS + S), () => o('polarRadius3D', S)]; });
ok &= fuzz('mat_mul_vector', N, () => { rmat(S); vec(S + 18, rv(), rv(), rv()); return ['', () => m.mat_mul_vector(DS + S + 18, DS + S, DS + S + 24), () => o('mat_mul_vector', S + 18, S, S + 24), 0]; });
ok &= fuzz('mat_mul_vector aliased', N, () => { rmat(S); vec(S + 18, rv(), rv(), rv()); return ['', () => m.mat_mul_vector(DS + S + 18, DS + S, DS + S + 18), () => o('mat_mul_vector', S + 18, S, S + 18), 0]; });
ok &= fuzz('mat_multiply', N, () => { rmat(S); rmat(S + 18); return ['', () => m.mat_multiply(DS + S, DS + S + 18, DS + S + 36), () => o('mat_multiply', S, S + 18, S + 36), 0]; });
ok &= fuzz('mat_invert', 200, i => { rmat(S); const d = i & 1 ? S : S + 18; return ['', () => m.mat_invert(DS + S, DS + d), () => o('mat_invert', S, d), 0]; });
for (const f of ['mat_rot_x', 'mat_rot_y', 'mat_rot_z']) ok &= fuzz(f, 500, () => { const a = ang(); return [a, () => m[f](DS + S, a), () => o(f, S, a), 0]; });
ok &= fuzz('mat_rot_zxy', N, () => {
  const z = rnd(0, 2) ? ang() : 0, x = rnd(0, 2) ? ang() : 0, y = rnd(0, 2) ? ang() : 0, f = rnd(0, 1);
  if (rnd(0, 3) === 0) G.mat_y_rot_angle = y & 0x3ff; // exercise the cache
  return [`${z},${x},${y},${f}`, () => m.mat_rot_zxy(z, x, y, f) - DS, () => o('mat_rot_zxy', z, x, y, f)];
});
ok &= fuzz('multiply_and_scale', N, () => { const a = rv(), b = rv(); return [`${a},${b}`, () => m.multiply_and_scale(a, b), () => o('multiply_and_scale', a, b)]; });
ok &= fuzz('vector_op_unk', N, () => {
  const v1 = [rnd(-2000, 2000), rnd(-2000, 2000), rnd(-2000, 2000)], v2 = [rnd(-2000, 2000), rnd(-2000, 2000), rnd(-2000, 2000)];
  const i = rnd(Math.min(v1[2], v2[2]), Math.max(v1[2], v2[2]));
  if (v1[2] === v2[2]) v1[2]++;
  vec(S, ...v1); vec(S + 6, ...v2);
  return [`${v1} ${v2} ${i}`, () => m.vector_op_unk(DS + S, DS + S + 6, DS + S + 12, i), () => o('vector_op_unk', S, S + 6, S + 12, i), 0];
});
// plane_origin_op needs planptr: a small fake plane table in the far heap.
const planes = farAlloc(34 * 16);
setFarptr(A.planptr, planes);
for (let i = 0; i < 16 * 17; i++) ww(planes + i * 2, rnd(-8192, 8192));
ok &= fuzz('plane_origin_op', N, () => {
  const idx = rnd(0, 15); G.planindex = rnd(0, 15); setFarptr(A.current_planptr, planes + 34 * rnd(0, 15));
  G.terrainHeight = rnd(0, 1) * 450; G.elem_xCenter = rnd(0, 29) * 1024 + 512; G.elem_zCenter = rnd(0, 29) * 1024 + 512;
  const x = G.elem_xCenter + rnd(-600, 600), y = rnd(-100, 1500), z = G.elem_zCenter + rnd(-600, 600);
  return [`${idx}`, () => m.plane_origin_op(idx, x, y, z), () => o('plane_origin_op', idx, x, y, z)];
});
process.exit(ok ? 0 : 1);
