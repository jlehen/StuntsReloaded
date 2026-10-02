// Game state: per-frame update, race init, replay snapshots (cvx), camera tracking, debris,
// the kevin RNG and the replay input recorder. Ported from the original asm (seg001/seg003/seg005).
//
// GAMESTATE notes (learned from the asm):
// - game_vec1[0..1]: chase-camera position (x, y, z) for the player / opponent car, updated by
//   sub_2298C; game_vec3 / game_vec4: the same positions one frame earlier.
// - field_3F7[0..1]: index of the nearest trackside (TV) camera in trackdata9 for each car.
// - Debris pieces (24 slots, spawned by state_op_unk, moved by sub_19BA0): game_longs1/2/3 =
//   x/y/z offsets from the spawn point (32-bit, world units), field_38E = horizontal speed
//   (0 = slot free), field_3BE (words!) = vertical speed, field_35E = heading, field_2FE /
//   field_32E = spin angles, field_42B = shape index, field_443 = spawn type (0/1: crashed
//   player/opponent car, n >= 2: trackside object n-2 of td10_track_check_rel knocked by a car).
//   field_42A: any piece alive. field_3FA[48]: per-object "already knocked" flags.
// - field_3F4: snapshot-valid flag (meaningful in the cvx copies), kevinseed: RNG state saved
//   with each snapshot.
import { M, A, G, U, DS, rw, rsw, rd, rsd, ww, wd, s8, s16, u16, sdiv2, farptr, farptrAt, frame, alloca } from './mem.js';
import { GAMESTATE, CARSTATE, SIMD, gameconfig, fps } from './structs.js';
import { MS } from './version.js';
import { idiv, sin_fast, cos_fast, polarAngle, polarRadius2D, multiply_and_scale as mas, mat_rot_zxy, mat_mul_vector } from './math.js';
import { call, provide, defineSigs } from './calls.js';
import { cpu } from './engine.js';

defineSigs({
  state_op_unk: 'www', audio_carstate: '', init_unknown: '',
  locate_shape_alt: 'fn', copy_string: 'nf',
});

const S = A.state, O = GAMESTATE.offsets, C = CARSTATE.offsets;
const PLAYER = S + O.playerstate, OPPONENT = S + O.opponentstate;
const SNAP = GAMESTATE.size; // 0x460 (Mindscape: 0x430)
// Frames between replay snapshots (30 s).
const snapFrames = MS ? () => 600 : () => U.word_45A00;
// Element i of the cvx snapshot array (huge-pointer math: 32-bit add, 20-bit wrap).
// ponytail: copies use linear addresses; cvxptr is paragraph-aligned so the offset never wraps.
const cvx = i => (farptr(A.cvxptr) + Math.imul(s16(i), SNAP)) & 0xfffff;
const farRet = r => ((r >>> 16) * 16 + (r & 0xffff)) & 0xfffff; // raw dx:ax far pointer -> linear
const w = (off, i) => S + off + i * 2; // word array element in state

// --- kevin RNG (6-byte lagged adder).
export function get_kevinrandom() {
  const s = A.g_kevinrandom_seed;
  let al = M[s + 5];
  for (let i = 4; i >= 0; i--) M[s + i] = al = (al + M[s + i]) & 0xff;
  for (let i = 5; i >= 0 && !(M[s + i] = (M[s + i] + 1) & 0xff); i--);
  return M[s];
}
export function init_kevinrandom(p) { M.copyWithin(A.g_kevinrandom_seed, p, p + 6); }
export function get_kevinrandom_seed(p) { M.copyWithin(p, A.g_kevinrandom_seed, A.g_kevinrandom_seed + 6); }

// --- Race init.
export function init_carstate_from_simd(p, simd, transm, x, y, z, angle) {
  wd(p + C.car_posWorld1, x); wd(p + C.car_posWorld2, x);
  wd(p + C.car_posWorld1 + 4, y + 0x200); wd(p + C.car_posWorld2 + 4, y);
  wd(p + C.car_posWorld1 + 8, z); wd(p + C.car_posWorld2 + 8, z);
  ww(p + C.car_rotate, angle); ww(p + C.car_rotate + 2, 0); ww(p + C.car_rotate + 4, 0);
  for (const f of ['car_36MwhlAngle', 'car_pseudoGravity', 'car_steeringAngle']) ww(p + C[f], 0);
  M[p + C.car_is_braking] = 0; M[p + C.car_is_accelerating] = 0;
  const rpm = rw(simd + SIMD.offsets.idle_rpm);
  for (const f of ['car_currpm', 'car_lastrpm', 'car_idlerpm2']) ww(p + C[f], rpm);
  M[p + C.car_current_gear] = 1;
  for (const f of ['car_speeddiff', 'car_speed', 'car_speed2', 'car_lastspeed']) ww(p + C[f], 0);
  const ratio = rw(simd + SIMD.offsets.gear_ratios + 2);
  ww(p + C.car_gearratio, ratio); ww(p + C.car_gearratioshr8, ratio >> 8);
  const kx = rw(simd + SIMD.offsets.knob_points + 4), ky = rw(simd + SIMD.offsets.knob_points + 6);
  ww(p + C.car_knob_x, kx); ww(p + C.car_knob_x2, kx); ww(p + C.car_knob_y, ky); ww(p + C.car_knob_y2, ky);
  for (const f of ['car_angle_z', 'car_40MfrontWhlAngle', 'field_42', 'field_48', 'car_trackdata3_index']) ww(p + C[f], 0);
  M[p + C.car_sumSurfFrontWheels] = 2; M[p + C.car_sumSurfRearWheels] = 2; M[p + C.car_sumSurfAllWheels] = 4;
  ww(p + C.car_demandedGrip, 0); ww(p + C.car_surfacegrip_sum, 1000);
  const wx = x >> 6, wy = y >> 6, wz = z >> 6; // sar/rcr: floor, not C's truncating /64
  for (let i = 0; i < 4; i++) {
    M[p + C.car_surfaceWhl + i] = 1;
    for (const f of ['car_rc1', 'car_rc2', 'car_rc3', 'car_rc4', 'car_rc5']) ww(p + C[f] + i * 2, 0);
    if (MS) continue; // leaves the wheel positions of the previous race
    for (const f of ['car_whlWorldCrds1', 'car_whlWorldCrds2']) { const v = p + C[f] + i * 6; ww(v, wx); ww(v + 2, wy); ww(v + 4, wz); }
  }
  for (const f of ['car_engineLimiterTimer', 'car_slidingFlag', 'field_C8', 'car_crashBmpFlag', 'car_changing_gear', 'car_fpsmul2']) M[p + C[f]] = 0;
  M[p + C.car_transmission] = transm;
  M[p + C.field_CD] = 0; M[p + C.field_CE] = 0; M[p + C.field_CF] = 1;
}

// arg: -1 new race (clears the snapshot flags), 0 replay restart, -2 no path init, -3 timing only.
export function init_game_state(arg) {
  arg = u16(arg);
  if (arg === 0xffff) {
    G.elapsed_time1 = 0;
    for (let i = 0; i < 20; i++) M[cvx(i) + O.field_3F4] = 0;
  }
  if (!MS) {
    G.steerWhlRespTable_ptr = (G.framespersec === 10 ? A.steerWhlRespTable_10fps : A.steerWhlRespTable_20fps) - DS;
    G.word_45A00 = 30 * G.framespersec;
    G.word_4499C = idiv(100, G.framespersec);
    if (arg === 0xfffd) return;
  }
  call.init_unknown();
  M[S + O.field_3F4] = 1; ww(S + O.game_frames_per_sec, 1);
  M[S + O.game_inputmode] = 0; M[S + O.game_3F6autoLoadEvalFlag] = 0;
  ww(S + O.game_frame_in_sec, 0);
  if (!MS) ww(S + O.field_2F4, 0);
  M[S + O.field_3F7] = 0; M[S + O.field_3F7 + 1] = 0;
  M.fill(0, S + O.field_3FA, S + O.field_3FA + 48);
  M.fill(0, S + O.field_38E, S + O.field_38E + 48);
  const ta = G.track_angle, col = G.startcol2, row = G.startrow2, hill = rsw(A.hillHeightConsts + G.hillFlag * 2);
  const v1 = S + O.game_vec1;
  ww(v1, mas(sin_fast(ta + 0x300), 0x200) + mas(sin_fast(ta + 0x200), 0x1000) + (col << 10));
  ww(v1 + 2, hill + 0x3c0);
  ww(v1 + 4, mas(cos_fast(ta + 0x200), 0x1000) + rsw(A.trackpos + row * 2) + mas(cos_fast(ta + 0x300), 0x200));
  for (const d of [v1 + 6, S + O.game_vec3, S + O.game_vec4]) M.copyWithin(d, v1, v1 + 6);
  wd(S + O.game_travDist, 0);
  for (const f of ['game_frame', 'game_total_finish', 'field_144', 'game_pEndFrame', 'game_oEndFrame', 'game_penalty',
    'game_impactSpeed', 'game_topSpeed', 'game_jumpCount']) ww(S + O[f], 0);
  // Cars start side by side: player on the 0x100 side, opponent on the 0x300 side.
  const initCar = (p, simd, transm, side) => {
    const dc = s16(mas(sin_fast(ta + 0x200), 0xd2) + mas(sin_fast(ta + side), 0x24));
    const dr = s16(mas(cos_fast(ta + 0x200), 0xd2) + mas(cos_fast(ta + side), 0x24));
    call.init_carstate_from_simd(p, simd, transm, s16(rsw(A.trackcenterpos2 + col * 2) + dc) * 64, hill * 64,
      s16(rsw(A.trackcenterpos + row * 2) + dr) * 64, s16(-ta));
  };
  initCar(PLAYER, A.simd_player, s8(gameconfig.game_playertransmission), 0x100);
  ww(S + O.field_2F2, 0);
  for (const f of ['field_45D', 'field_45E', 'field_45B', 'field_45C']) M[S + O[f]] = 0;
  ww(S + O.game_startcol, col); ww(S + O.game_startcol2, col);
  ww(S + O.game_startrow, row); ww(S + O.game_startrow2, row);
  if (arg !== 0xfffe) {
    const ce = M[PLAYER + C.field_CE]++; // incremented before the call
    call.sub_18D60(rw(PLAYER + C.car_trackdata3_index), PLAYER + C.car_vec_unk3, ce, 0);
  }
  initCar(OPPONENT, A.simd_opponent, 1, 0x300);
  if (gameconfig.game_opponenttype && arg !== 0xfffe) {
    const ce = M[OPPONENT + C.field_CE]++;
    call.sub_18D60(rw(farptrAt(A.trackdata3, rw(OPPONENT + C.car_trackdata3_index) * 2)), OPPONENT + C.car_vec_unk3, ce, S + O.field_3F9);
  }
  M[S + O.field_42A] = 0;
}

// Loads the car's "simd" into simd_player/simd_opponent, builds its aero drag table (word per
// speed step: aero * i^2 >> 9) and copies its name.
export function setup_aero_trackdata(carres, isOpp) {
  const [simd, table, simdName, nameRes, dst] = isOpp & 0xffff
    ? [A.simd_opponent, A.td05_aerotable_op, A.aSimd_0, A.aGsna, A.gsna_string]
    : [A.simd_player, A.td04_aerotable_pl, A.aSimd, A.aGnam, A.gnam_string];
  const src = farRet(call.locate_shape_alt(carres, simdName));
  M.copyWithin(simd, src, src + SIMD.size);
  wd(simd + SIMD.offsets.aerorestable, rd(table));
  const aero = rsw(simd + SIMD.offsets.aero_resistance);
  // Broderbund shifts; Mindscape divides (__aFldiv), which rounds toward zero.
  for (let i = 0; i < 64; i++) { const d = Math.imul(Math.imul(aero, i), i); ww(farptrAt(table, i * 2), MS ? Math.trunc(d / 512) : d >> 9); }
  call.copy_string(dst, farRet(call.locate_shape_alt(carres, nameRes)));
}

// --- Replay snapshots: update_gamestate saves the state every word_45A00 (30 s) frames into cvx.
// Restores the last snapshot at or before `frame` (seeking back), or a later one when seeking
// forward past the current frame. The caller then runs update_gamestate up to the target frame.
export function restore_gamestate(target) {
  target = u16(target);
  if (target === 0 && U.elapsed_time1 === 0) call.init_game_state(0);
  let si = s16(idiv(s16(target), snapFrames()));
  if (si === 20) si--;
  if (target >= rw(S + O.game_frame)) {
    for (; ; si--) {
      if (u16(Math.imul(snapFrames(), si)) <= rw(S + O.game_frame)) return;
      if (M[cvx(si) + O.field_3F4]) break;
    }
  }
  M.copyWithin(S, cvx(si), cvx(si) + SNAP);
  call.init_kevinrandom(S + O.kevinseed);
  G.elapsed_time2 = rw(S + O.game_frame);
}

// --- One simulation frame.
// Original callees run at the original's stack depth (entry sp - 10: bp, 4 bytes of locals, di,
// si), so they see the same stack garbage: update_player_state reads uninitialized locals
// (var_140someWhlData when car_speed2 scales to 0). Only effective when called from original
// code (hook); a depth-0 callOrig always restarts at sp 0xfff0.
export function update_gamestate() {
  const sp = cpu.sp;
  cpu.sp = sp - 10;
  try { updateGamestate(); } finally { cpu.sp = sp; }
}
function updateGamestate() {
  const f = rw(S + O.game_frame);
  const input = M[farptrAt(A.td16_rpl_buffer, f)];
  if (input) M[S + O.game_inputmode] = 1;
  const snap = snapFrames();
  if (snap === 0) throw new Error('divide by zero'); // div word_45A00
  if (f % snap === 0) {
    call.get_kevinrandom_seed(S + O.kevinseed);
    const d = cvx(Math.floor(f / snap));
    M.copyWithin(d, S, S + SNAP);
  }
  ww(S + O.game_frame, f + 1);
  // Race-end countdown (game_frames_per_sec frames once game_3F6autoLoadEvalFlag is set).
  const fps = rsw(S + O.game_frames_per_sec);
  if (M[S + O.game_3F6autoLoadEvalFlag] && rsw(S + O.game_frame_in_sec) < fps) {
    ww(S + O.game_frame_in_sec, rsw(S + O.game_frame_in_sec) + 1);
    if (rsw(S + O.game_frame_in_sec) === fps && U.byte_449DA === 0) {
      if (M[PLAYER + C.car_crashBmpFlag] === 1 && rw(PLAYER + C.car_speed2)) ww(S + O.game_frames_per_sec, fps + 1);
      else if (U.game_replay_mode === 0) G.byte_449DA = 1;
    }
  }
  if (M[S + O.game_inputmode]) {
    call.player_op(s8(input));
    if (gameconfig.game_opponenttype) call.opponent_op();
    call.sub_2298C();
    if (M[S + O.field_42A]) call.sub_19BA0();
    call.audio_carstate();
    return;
  }
  if (U.game_replay_mode !== 1) return;
  // New race, no input yet: the car rolls from behind the start line to it (byte_4393C 1 -> 2 -> 0).
  call.audio_carstate();
  if (!U.byte_4393C) return;
  if (G.word_44DCA < 0x1c2) G.word_44DCA += 8;
  if (U.byte_4393C === 1 && G.word_44DCA > 0x180) G.byte_4393C++;
  if (U.byte_4393C !== 2) return;
  const ta = G.track_angle;
  const d = s16(mas(cos_fast(ta), rsw(A.trackcenterpos + G.startrow2 * 2) - (rsd(PLAYER + C.car_posWorld1 + 8) >> 6))
    + mas(sin_fast(ta), rsw(A.trackcenterpos2 + G.startcol2 * 2) - (rsd(PLAYER + C.car_posWorld1) >> 6)));
  const speed = rw(PLAYER + C.car_speed);
  if (d > 0xe4) call.player_op(speed < 0x500 ? 1 : 0);
  else if (speed) call.player_op(2);
  else G.byte_4393C = 0;
}

// --- Chase cameras (game_vec1[car]) and nearest trackside camera (field_3F7[car]).
export function sub_2298C() {
  const n = gameconfig.game_opponenttype ? 2 : 1;
  for (let si = 0; si < n; si++) {
    const cam = S + O.game_vec1 + si * 6;
    M.copyWithin(S + O.game_vec3 + si * 6, cam, cam + 6);
    const car = si ? OPPONENT : PLAYER;
    const pos = k => s16(rsd(car + C.car_posWorld1 + k * 4) >> 6);
    const cx = pos(0), cy = pos(1), cz = pos(2);
    // Aim at the car's path point ahead, or at the car itself when off-path/crashed/facing away.
    let tx = rsw(car + C.car_vec_unk3), tz = rsw(car + C.car_vec_unk3 + 4);
    const e = rsw(car + C.field_48);
    if ((si === 0 && (M[S + O.field_45B] || M[S + O.field_45C])) || rw(car + C.field_B6) || M[car + C.car_crashBmpFlag]
      || rw(car + C.car_trackdata3_index) === 0xffff || (e > 0x80 && e < 0x380)) { tx = cx; tz = cz; }
    // Height: car + 270, at most 30 per frame.
    const dy = s16(rsw(cam + 2) - s16(cy + 0x10e));
    if (dy) ww(cam + 2, rsw(cam + 2) - Math.max(-30, Math.min(30, dy)));
    const ax = s16(tx - rsw(cam));
    const ang = polarAngle(ax, s16(tz - rsw(cam + 4)), ax);
    let dist = polarRadius2D(s16(cx - rsw(cam)), s16(cz - rsw(cam + 4)));
    // Horizontal: stay within 450 of the car, moving at most 120 (20 fps) / 240 per frame.
    if (dist > 0x1c2) {
      dist = Math.min(s16(dist - 0x1c2), fps() === 20 ? 0x78 : 0xf0);
      ww(cam, rsw(cam) + mas(dist, sin_fast(ang)));
      ww(cam + 4, rsw(cam + 4) + mas(dist, cos_fast(ang)));
    }
    const div = (fps() >> 1) & 0xffff;
    if (div === 0) throw new Error('divide by zero');
    if (rw(S + O.game_frame) % div) continue;
    let best = 10000;
    for (let i = 0; i < G.byte_4616E; i++) {
      const p = farptrAt(A.trackdata9, i * 6);
      const dx = rsw(p) - cx, dz = rsw(p + 4) - cz;
      if (Math.abs(dx) >= best || Math.abs(dz) >= best) continue;
      const r = polarRadius2D(s16(dx), s16(dz));
      if (r < best) { M[S + O.field_3F7 + si] = i; best = r; }
    }
  }
}

// --- Debris / particles: 24 slots, positions relative to the car that spawned them.
export function sub_19BA0() {
  let any = 0;
  for (let i = 0; i < 24; i++) {
    const speed = rw(w(O.field_38E, i));
    if (!speed) continue;
    frame(() => {
      const m = mat_rot_zxy(0, 0, rw(w(O.field_35E, i)), 1);
      const v = alloca(6), out = alloca(6);
      ww(v + 4, speed);
      mat_mul_vector(v, m, out);
      const L = (off, d) => wd(S + off + i * 4, rsd(S + off + i * 4) + d);
      L(O.game_longs1, rsw(out));
      L(O.game_longs3, rsw(out + 4));
      const vy = w(O.field_3BE, i);
      for (let k = fps() === 10 ? 2 : 1; k > 0; k--) { ww(vy, rsw(vy) - 0x13); L(O.game_longs2, rsw(vy)); }
    });
    // Alive while above the player's height (even for opponent debris).
    if ((rsd(S + O.game_longs2 + i * 4) + rsd(PLAYER + C.car_posWorld1 + 4) | 0) >= 0) {
      any = 1;
      ww(w(O.field_2FE, i), rw(w(O.field_2FE, i)) + 0x10);
      ww(w(O.field_32E, i), rw(w(O.field_32E, i)) + 0x10);
    } else ww(w(O.field_38E, i), 0);
  }
  M[S + O.field_42A] = any;
}

// Spawns debris. type 0/1: crash explosion of player/opponent (up to 18 pieces over a full
// circle, shapes type*4+4..+7); type >= 2: up to 8 particles fanned over 0xC0 around angle-0x60.
export function state_op_unk(type, angle, speed) {
  const t = s16(type);
  const [base, spread, max, shape, vmul] = t < 2 ? [angle, 0x400, 18, t * 4 + 4, 6] : [angle - 0x60, 0xc0, 8, 0, 1];
  M[S + O.field_42A] = 1;
  let free = 0;
  for (let i = 0; i < 24; i++) if (!rw(w(O.field_38E, i))) free++;
  if (free > max) free = max;
  let k = 0;
  for (let i = 0; i < 24; i++) {
    if (rw(w(O.field_38E, i))) continue;
    M[S + O.field_443 + i] = type;
    M[S + O.field_42B + i] = (k & 3) + shape;
    for (const off of [O.game_longs1, O.game_longs2, O.game_longs3]) wd(S + off + i * 4, 0);
    ww(w(O.field_2FE, i), (call.get_kevinrandom() & 0xffff) << 2);
    ww(w(O.field_32E, i), (call.get_kevinrandom() & 0xffff) << 2);
    ww(w(O.field_35E, i), (Math.trunc(spread * k / free) + base) & 0x3ff);
    const r = call.get_kevinrandom() & 0xffff;
    const di = s16((MS ? sdiv2((r * 0x18) << 6, 8) : s16(r * 6) >> 2) + speed + 0x180);
    ww(w(O.field_38E, i), di);
    ww(w(O.field_3BE, i), MS ? sdiv2(vmul * di, 2) : s16(vmul * di) >> 2);
    if (++k === free) break;
  }
}

// --- Replay recorder, called by the timer once per frame tick (20 or 10 Hz) before the main loop
// catches up with update_gamestate. Records one input byte at td16_rpl_buffer[elapsed_time2++].
// `input` replaces the original's hardware read (kb/joystick flags, | 0x10 for 'A', | 0x20 for 'Z';
// the mouse/analog steering bytes are not ported). arg != 0 records 0 (the "cop" loop).
//
// Browser loop (as run_game): set passed_security = 1 first, or the car is crashed after 4 s (copy
// protection). A new race starts with game_replay_mode 1, byte_4393C 1: update_gamestate rolls the
// car to the line; on accelerate/shift or when that ends (byte_4393C 0): game_replay_mode = 0,
// init_game_state(-1). Then per timer tick: replay_unk2(0, input); while (game_frame !==
// elapsed_time2) update_gamestate(); and while game_inputmode is 0, zero elapsed_time2,
// game_recordedframes and game_frame (the clock starts on the first input). byte_46467: buffer-
// full dialog (continue, or update_crash_state(4, 0) + byte_449DA = 1). byte_449DA != 0: race
// over; game_replay_mode 2 (playback) then only advances elapsed_time2 up to game_recordedframes.
export function replay_unk2(arg, input = 0) {
  let si = 0;
  if (!u16(arg)) {
    if (U.game_replay_mode === 2) {
      if (gameconfig.game_recordedframes > U.elapsed_time2) { G.elapsed_time2++; return; }
      if (U.byte_449DA) return;
      G.is_in_replay = 1;
      call.audio_carstate();
      G.byte_449DA = 1;
      return;
    }
    if (!U.byte_449DA && !M[S + O.game_3F6autoLoadEvalFlag] && U.game_replay_mode !== 1) {
      if (!U.passed_security && !U.byte_4393C && u16(fps() * 4) < rw(S + O.game_frame)) call.update_crash_state(1, 0);
      si = input;
    }
  }
  // Time limit: 1500 s.
  if (u16(1500 * fps()) <= u16(U.elapsed_time2 + U.elapsed_time1)) {
    call.update_crash_state(4, 0);
    G.byte_449DA = 1;
    return;
  }
  if (U.elapsed_time2 === 0x2ee0) {
    // Buffer full (12000 frames): the first time, ask (byte_46467); then slide the window by
    // 30 s: drop the oldest snapshot and 30*fps input bytes, elapsed_time1 counts dropped frames.
    if (U.elapsed_time1 === 0 && M[A.word_45D3E] === 0) { M[A.word_45D3E] = 1; G.byte_46467 = 1; return; }
    const step = s16(30 * fps());
    for (let i = 0; i < idiv(0x2ee0, step) - 1; i++) { // 39 at 10 fps: overruns the 20-entry cvx, as the original
      const src = cvx(i + 1);
      ww(src + O.game_frame, rw(src + O.game_frame) - step);
      M.copyWithin(cvx(i), src, src + SNAP);
    }
    for (let i = 0; i < 0x2ee0 - step; i++) M[farptrAt(A.td16_rpl_buffer, i)] = M[farptrAt(A.td16_rpl_buffer, step + i)];
    G.elapsed_time2 -= step;
    gameconfig.game_recordedframes -= step;
    G.elapsed_time1 += step;
    ww(S + O.game_frame, rw(S + O.game_frame) - step);
  }
  M[farptrAt(A.td16_rpl_buffer, U.elapsed_time2)] = si;
  G.elapsed_time2++;
  gameconfig.game_recordedframes++;
}

provide({
  get_kevinrandom, init_kevinrandom, get_kevinrandom_seed, init_carstate_from_simd, init_game_state,
  setup_aero_trackdata, restore_gamestate, update_gamestate, sub_2298C, sub_19BA0, state_op_unk, replay_unk2,
});
export const PORTS = ['get_kevinrandom', 'init_kevinrandom', 'get_kevinrandom_seed', 'init_carstate_from_simd', 'init_game_state',
  'setup_aero_trackdata', 'restore_gamestate', 'update_gamestate', 'sub_2298C', 'sub_19BA0', 'state_op_unk', 'replay_unk2'];
