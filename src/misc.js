// Small original helpers the ported code still reaches: resource lookup, string copy, the
// audio trigger in the physics, and startup init. Ported from the asm (seg001/seg008/seg012).
import { M, A, G, rw, rd, ww, wd } from './mem.js';
import { gameconfig } from './structs.js';
import { call, provide, defineSigs } from './calls.js';
import { sin_fast, cos_fast, mat_rot_y } from './math.js';
import { origStack } from './stack.js';

defineSigs({ locate_shape_alt: 'fn', locate_shape_fatal: 'fn', locate_shape_nofatal: 'fn', copy_string: 'nf', audio_unk3: 'ww',
  init_unknown: '', set_default_car: '', calc_sincos80: '', init_polyinfo: '', mmgr_alloc_resbytes: 'nl' });

// locate_resource: pads the name with spaces in place, scans count + 1 entries (one past the
// table, as the original), and returns a normalized far pointer (dx:ax, offset < 16) or 0.
function locate(res, name, fatal) {
  for (let i = 0; i < 4; i++) if (!M[name + i]) { for (; i < 4; i++) M[name + i] = 0x20; break; }
  const n = rw(res + 4);
  for (let j = 0; j <= n; j++) {
    const e = res + 6 + j * 4;
    let i = 0;
    while (i < 4 && M[e + i] === M[name + i]) i++;
    if (i === 4 || (M[e + i] === 0 && M[name + i] === 0x20)) {
      const lin = (res & ~15) + n * 8 + 6 + rd(e + n * 4); // the data sits at offset 0 of its segment
      return (((lin >>> 4) << 16) | (lin & 15)) >>> 0;
    }
  }
  if (fatal) throw new Error('locate: resource not found: ' + String.fromCharCode(...M.subarray(name, name + 4)));
  return 0;
}
export const locate_shape_fatal = (res, name) => locate(res, name, true);
export const locate_shape_nofatal = (res, name) => locate(res, name, false);
export const locate_shape_alt = (res, name) => locate(res, name, true);

// copy_string: copies the first byte unconditionally, then while the next source byte is nonzero.
export function copy_string(dst, src) {
  do M[dst++] = M[src++]; while (M[src]);
  M[dst] = 0;
}

// Sound trigger from update_player_state; only acts with audio loaded (byte_459D8), never here.
export function audio_unk3() {
  origStack('audio_unk3').enter(0); // push bp: the frame residue the physics may later read
}

// --- Startup.
export function init_unknown() {
  G.byte_44A8A = 1; G.byte_4552F = 2; G.elapsed_time2 = 0;
  G.byte_449DA = 0; G.byte_4393C = 0; G.word_44DCA = 0;
}
export function set_default_car() {
  for (let i = 0; i < 4; i++) gameconfig.game_playercarid[i] = 'COUN'.charCodeAt(i);
  gameconfig.game_playermaterial = 0; gameconfig.game_opponenttype = 0; gameconfig.game_opponentmaterial = 0;
  gameconfig.game_playertransmission = 1; gameconfig.game_opponentcarid[0] = 0xff;
}
export function calc_sincos80() {
  for (const [n, f] of [['sin80', sin_fast], ['cos80', cos_fast], ['sin80_2', sin_fast], ['cos80_2', cos_fast]]) wd(A[n], f(0x80)); // cwd: sign-extended
}
export function init_polyinfo() {
  const p = call.mmgr_alloc_resbytes(A.aPolyinfo, 0x28a0);
  ww(A.polyinfoptr, p & 0xffff); ww(A.polyinfoptr + 2, p >>> 16);
  for (const [n, a] of [['mat_y0', 0], ['mat_y100', 0x100], ['mat_y200', 0x200], ['mat_y300', 0x300]]) mat_rot_y(A[n], a);
  calc_sincos80();
}

provide({ locate_shape_fatal, locate_shape_nofatal, locate_shape_alt, copy_string, audio_unk3, init_unknown, set_default_car, calc_sincos80, init_polyinfo });
export const PORTS = ['locate_shape_fatal', 'locate_shape_nofatal', 'locate_shape_alt', 'copy_string', 'audio_unk3', 'init_unknown',
  'set_default_car', 'calc_sincos80', 'init_polyinfo'];
