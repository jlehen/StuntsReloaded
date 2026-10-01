// Player car step (seg001): player_op, update_player_state (wheel/terrain/wall integration),
// detect_penalty and the path target helpers sub_18D60 / sub_18D06. Ported from the asm.
import { M, A, G, U, DS, DSEG, rb, rsb, rw, rsw, rsd, wb, ww, wd, s8, s16, u16, farptrAt, frame, alloca } from './mem.js';
import { CARSTATE, SIMD, state, gameconfig } from './structs.js';
import { call, provide, defineSigs, isEnabled, setNextReturn } from './calls.js';
import { cpu, procPtr } from './engine.js';
import { origStack, retAddr } from './stack.js';
import * as m from './math.js';
import { tweaks, crashLimit, survives } from './tweaks.js';

defineSigs({ audio_unk3: 'ww', state_op_unk: 'www', audio_op_unk2: 'wwwwwwwww', sub_18D06: 'nw' });

// --- Original stack (src/stack.js conventions: a port runs with cpu.sp = its entry sp).
// Ports leave the original's stack residue, which later code may read uninitialized: origFrame
// pushes bp/di/si where the original does and keeps the locals in a scratch copy of the frame
// ([bp-size, bp), copied in on entry and back on exit); calls go through invoke, with the
// arguments and the original call site's return address on the stack and cpu.bp = the frame's bp.
// zero: start from a zeroed frame. update_player_state reads locals it has not written (var_140
// when the speed rounds to 0, var_16 after 4 wall restarts); on DOS they held nondeterministic
// garbage (timer interrupts), so the project defines them as 0 (engine.js zero-fills the
// original's frame too).
function origFrame(proc, size, body, zero = false) {
  const st = origStack(proc), sp = cpu.sp;
  st.enter(size, cpu.di, cpu.si);
  const lo = st.bp - size;
  return frame(() => {
    const f = alloca(size);
    if (lo >= 0 && !zero) M.copyWithin(f, DS + lo, DS + st.bp);
    cpu.sp = st.sp;
    try { return body(off => f + size - off, st); } finally {
      cpu.sp = sp;
      if (lo >= 0) M.copyWithin(DS + lo, f, f + size);
    }
  });
}
// origStack().invoke for a call site in `from`, which may be a code label inside the proc (the
// call layer pushes a JS callee's args; we supply the original call site's return address).
function invoke(st, from, to, nth, ...args) {
  const [cs, ip] = retAddr(from, to, nth);
  const [sp, bp] = [cpu.sp, cpu.bp];
  cpu.sp = st.sp; cpu.bp = st.bp;
  try {
    if (isEnabled(to)) { setNextReturn(cs, ip); return call[to](...args); }
    const r = call[to](...args); // callFar pushed the args and a sentinel return address
    ww(DS + u16(st.sp - 2 * args.length - 2), cs); ww(DS + u16(st.sp - 2 * args.length - 4), ip);
    return r;
  } finally { cpu.sp = sp; cpu.bp = bp; }
}

// --- Small helpers over emulated memory.
const sar6 = a => s16(rsd(a) >> 6); // long >> 6, low word (VECTORLONG component to world units)
const setv = (a, x, y, z) => { ww(a, x); ww(a + 2, y); ww(a + 4, z); };
const cpv = (dst, src) => M.copyWithin(dst, src, src + 6);
const addlv = (l, v) => { for (let c = 0; c < 3; c++) wd(l + 4 * c, rsd(l + 4 * c) + rsw(v + 2 * c)); };
const sublv = (l, v) => { for (let c = 0; c < 3; c++) wd(l + 4 * c, rsd(l + 4 * c) - rsw(v + 2 * c)); };
const sar6v = (dst, l) => setv(dst, sar6(l), sar6(l + 4), sar6(l + 8));
// __aFldiv: signed long division. On /0 its two `div cx` fault; the game's div0 handler (intr0_handler)
// skips them with ax=0 (result 0) and records the faulting CS:IP (the second div) in word_3BE30/32.
const [LDIV_CS, LDIV_IP] = procPtr('__aFldiv');
const ldiv = (a, b) => {
  if (b !== 0) return Math.trunc(a / b) | 0;
  ww(A.word_3BE30, LDIV_CS); ww(A.word_3BE32, LDIV_IP + 0x4b);
  return 0;
};
const lmuldiv = (a, b, d) => ldiv(Math.imul(a, b), d);
const setCurrentPlane0 = () => { G.planindex = 0; ww(A.current_planptr, rw(A.planptr)); ww(A.current_planptr + 2, rw(A.planptr + 2)); };
const planeAt = (idx, off = 0) => farptrAt(A.planptr, 0x22 * idx + off);
const td01 = i => rsw(farptrAt(A.td01_track_file_cpy, 2 * i)); // next path piece
const td02 = i => rsw(farptrAt(A.td02_penalty_related, 2 * i)); // alternative (split) path piece, -1 if none

const CS = CARSTATE.offsets, SO = SIMD.offsets;
const playerstate = () => new CARSTATE(state.$playerstate);

// Speed per tick in world units: speed2 * 11/120 at 20 fps (11/60 at 10 fps).
const speedScaled = (speed2, fps10) => Math.floor(speed2 * 0x580 / (fps10 ? 0x1e00 : 0x3c00)) & 0xffff;

// ============================================================================================
// update_player_state: moves the 4 wheels by the car speed (plane_rotate_op follows the current
// road plane), collides them with walls (wallindex) and the terrain/road planes, then rebuilds the
// car position (wheel average) and orientation (from the wheel quad), and checks car-car,
// scenery and start-gate collisions. State globals: pState_lvec1_* (new position), pState_minusRotate_*_1
// (new rotation z, x=pitch from rotate.y, y=yaw from rotate.x).
export function update_player_state(pState, pSimd, oState, oSimd, mplayerFlag) {
  origFrame('update_player_state', 0x1e4, (L, st) => ups(L, st, pState, pSimd, oState, oSimd, mplayerFlag & 0xff), true);
}

function ups(L, st, pState, pSimd, oState, oSimd, flag) {
  const p = new CARSTATE(pState);
  const fl = u16(s8(flag)); // cbw'd flag, as passed to update_crash_state
  // Calls by original call site: c1 before the code_update_rotCoords label, c2 after it.
  const c1 = (to, nth, ...a) => invoke(st, 'update_player_state', to, nth, ...a);
  const c2 = (to, nth, ...a) => invoke(st, 'code_update_rotCoords', to, nth, ...a);
  const crash = (n, c, nth) => c('update_crash_state', nth, n, fl);
  // Fragility tweak, for the player's car only (the opponent keeps the original's limits): scaled
  // crash thresholds, and whether the car survives a hit that always wrecks the original. If so,
  // it climbs the edge of a deck (wheels) or passes through its surface (roof); it bounces back
  // from an obstacle or a corner (this tick is undone, the car put 16 units back and stopped); on
  // its roof, it lands back on its wheels.
  const limit = t0 => (flag === 0 ? crashLimit(t0) : t0);
  const tough = () => flag === 0 && survives(p.car_speed2);
  const before = flag === 0 && tweaks.fragility < 100 ? M.slice(pState, pState + CARSTATE.size) : null;
  const bounceBack = () => {
    M.set(before, pState);
    setv(V1C6, 0, 0, -0x400);
    m.mat_mul_vector(V1C6, A.mat_unk, VFC);
    addlv(p.$car_posWorld1, VFC);
    p.car_speed = p.car_speed2 = 0;
    p.field_CF |= 0x30; // scrape and thud sounds
  };
  // Locals at their original frame offsets.
  const V1E4 = L(0x1e4), V1DE = L(0x1de), V1C6 = L(0x1c6), L1C0 = L(0x1c0), V18E = L(0x18e), V182 = L(0x182),
    V17C = L(0x17c), L176 = L(0x176), WHL = L(0x140), MAT134 = L(0x134), V122 = L(0x122), V11A = L(0x11a),
    MATZ = L(0x10e), VFC = L(0xfc), VE4 = L(0xe4), VDC = L(0xdc), V1C = L(0x1c), W16 = L(0x16), VC = L(0xc);
  const rc1 = p.$car_rc1, rc2 = p.$car_rc2, surf = p.$car_surfaceWhl;
  const inputmode2 = () => state.game_inputmode === 2;

  // Start from the current position and rotation.
  const pos = p.$car_posWorld1;
  G.pState_lvec1_x = rsd(pos); wd(pos + 12, rsd(pos));
  G.pState_lvec1_y = rsd(pos + 4); wd(pos + 16, rsd(pos + 4));
  G.pState_lvec1_z = rsd(pos + 8); wd(pos + 20, rsd(pos + 8));
  const rot = p.$car_rotate;
  G.pState_minusRotate_z_1 = G.pState_minusRotate_z_2 = rsw(rot + 4);
  G.pState_minusRotate_x_1 = G.pState_minusRotate_x_2 = rsw(rot + 2);
  G.pState_minusRotate_y_1 = G.pState_minusRotate_y_2 = rsw(rot);
  const f40sar2 = p.car_sumSurfAllWheels !== 0 ? p.car_40MfrontWhlAngle >> 2 : 0;
  const spd = speedScaled(p.car_speed2, G.framespersec === 10);

  const z1 = () => G.pState_minusRotate_z_1, x1 = () => G.pState_minusRotate_x_1, y1 = () => G.pState_minusRotate_y_1;
  let mat = m.mat_rot_zxy(s16(-z1()), s16(-x1()), s16(-y1()), 0);
  M.copyWithin(A.mat_unk, mat, mat + 18);
  if (x1() !== 0 || z1() !== 0) {
    setv(V1C6, 0, 0, 0x82);
    m.mat_mul_vector(V1C6, A.mat_unk, VFC);
    p.car_pseudoGravity = -rsw(VFC + 2);
  } else p.car_pseudoGravity = 0;
  const angleZ = (p.car_angle_z & 0x3ff) !== 0;
  if (angleZ) { mat = m.mat_rot_zxy(0, 0, s16(-p.car_angle_z), 0); M.copyWithin(MATZ, mat, mat + 18); }

  // F0 != 0: on the ground with the car's up axis pointing down (upside down).
  setv(V1C6, 0, 30000, 0);
  m.mat_mul_vector(V1C6, A.mat_unk, VFC);
  let F0 = 0;
  if (p.car_sumSurfAllWheels !== 0 && rsw(VFC + 2) < 0) {
    if (p.car_speed2 > 0x1e00) { F0 = 0xc0; ww(V1C6 + 2, -192); m.mat_mul_vector(V1C6, A.mat_unk, VE4); }
    else F0 = -192;
  }

  // Wheel positions: L176 = where they are, L1C0 = where they move to.
  ww(A.vec_unk2, 0); ww(A.vec_unk2 + 2, 0);
  G.planindex_copy = -1;
  for (let w = 0; w < 4; w++) {
    const l1 = L1C0 + 12 * w;
    cpv(V1C6, pSimd + SO.wheel_coords + 6 * w);
    ww(V1C6 + 2, -(rsw(rc2 + 2 * w) + 0x180));
    if (F0 < 0) ww(V1C6 + 2, rsw(V1C6 + 2) - F0);
    if (angleZ) { m.mat_mul_vector(V1C6, MATZ, VFC); cpv(V1C6, VFC); }
    m.mat_mul_vector(V1C6, A.mat_unk, VFC);
    wd(l1, rsw(VFC) + G.pState_lvec1_x);
    wd(l1 + 4, rsw(VFC + 2) + G.pState_lvec1_y);
    wd(l1 + 8, rsw(VFC + 4) + G.pState_lvec1_z);
    M.copyWithin(L176 + 12 * w, l1, l1 + 12);
    if (spd !== 0) {
      ww(A.vec_unk2 + 4, spd);
      const a = f40sar2 !== 0 && w < 2 ? p.car_36MwhlAngle - f40sar2 : p.car_36MwhlAngle; // front wheels steer
      G.pState_f36Mminf40sar2 = a;
      ww(WHL + 2 * w, a);
      c1('plane_rotate_op', 0);
      addlv(l1, A.vec_planerotopresult);
    }
  }

  // Wall hit by wheel w: pushes all wheels back and returns true (the pass restarts).
  const wallHit = w => {
    const l1 = L1C0 + 12 * w, wc = p.$car_whlWorldCrds1 + 6 * w;
    setv(V182, rsw(wc) - G.wallStartX, 0, rsw(wc + 4) - G.wallStartZ);
    setv(V1E4, sar6(l1) - G.wallStartX, 0, sar6(l1 + 8) - G.wallStartZ);
    m.mat_rot_y(MAT134, s16(-G.wallOrientation - 0x100));
    m.mat_mul_vector(V182, MAT134, VC);
    m.mat_mul_vector(V1E4, MAT134, V1C);
    if ((rsw(V1C + 4) > 0 && rsw(VC + 4) > 0) || (rsw(V1C + 4) < 0 && rsw(VC + 4) < 0)) return false; // same side
    let swapped = 0;
    if (rsw(V1C + 4) > rsw(VC + 4)) { swapped = 1; cpv(VFC, V1C); cpv(V1C, VC); cpv(VC, VFC); }
    let f4, f2; // spd split at the wall crossing
    if (rsw(V1C + 4) === 0) { f4 = spd; f2 = 0; }
    else if (rsw(VC + 4) === 0) { f4 = 0; f2 = spd; }
    else {
      m.vector_op_unk(V1C, VC, VFC, 0);
      setv(V17C, (rsw(V1C) - rsw(VFC)) << 6, (rsw(V1C + 2) - rsw(VFC + 2)) << 6, (rsw(V1C + 4) - rsw(VFC + 4)) << 6);
      f2 = m.polarRadius3D(V17C);
      f4 = s16(spd - f2);
    }
    let ee = (-y1() - G.wallOrientation) & 0x3ff;
    ww(VFC + 4, f2); ww(VFC + 2, 0);
    if (ee < 0x100 || ee > 0x300) { ee = G.wallOrientation; ww(VFC, 0x300); }
    else { ee = (G.wallOrientation + 0x200) & 0x3ff; ww(VFC, -0x300); }
    if (swapped) ww(VFC, -rsw(VFC));
    m.mat_mul_vector(VFC, m.mat_rot_zxy(s16(-z1()), s16(-x1()), ee, 0), V1C); // bounce vector
    let a = (-y1() - ee) & 0x3ff, neg = false;
    if (a > 0x100) { a = 0x400 - a; neg = true; }
    const maxSpeed = ((0x64 - (s16(0x46 * a) >> 8)) & 0xff) << 8; // head-on hits crash at lower speed
    if (p.car_speed2 > limit(maxSpeed)) {
      p.car_36MwhlAngle = (neg ? -a : a) << 1;
      crash(1, c1, 2);
    } else if (p.car_speed2 > maxSpeed) p.car_speed = p.car_speed2 = maxSpeed; // tougher car: the wall takes the excess speed
    p.field_CF |= 0x10;
    for (let i = 0; i < 4; i++) {
      const a1 = L1C0 + 12 * i, a0 = L176 + 12 * i;
      if (f4 === 0) setv(VC, 0, 0, 0);
      else for (let c = 0; c < 3; c++) ww(VC + 2 * c, lmuldiv(rsd(a1 + 4 * c) - rsd(a0 + 4 * c), f4, spd));
      for (let c = 0; c < 3; c++) wd(a1 + 4 * c, rsd(a0 + 4 * c) + s16(rsw(VC + 2 * c) + rsw(V1C + 2 * c)));
    }
    return true;
  };

  // Wheel w below its plane (nextPosAndNormalIP < 0): moves it onto the plane. Returns true when it
  // switched to the ground plane instead (fell through a road), to be checked again.
  const belowPlane = w => {
    const l1 = L1C0 + 12 * w, l0 = L176 + 12 * w;
    const plane = planeAt(G.planindex);
    setv(V122, rsw(plane + 4) + G.elem_xCenter, rsw(plane + 6) + G.terrainHeight, rsw(plane + 8) + G.elem_zCenter);
    setv(V182, sar6(l0) - rsw(V122), sar6(l0 + 4) - rsw(V122 + 2), sar6(l0 + 8) - rsw(V122 + 4));
    setv(V1E4, sar6(l1) - rsw(V122), sar6(l1 + 4) - rsw(V122 + 2), sar6(l1 + 8) - rsw(V122 + 4));
    M.copyWithin(MAT134, plane + 0x10, plane + 0x22);
    m.mat_invert(MAT134, MATZ);
    m.mat_mul_vector(V182, MATZ, VC); // old and new position in plane space (y = height)
    m.mat_mul_vector(V1E4, MATZ, V1C);
    let deep = 0;
    if (G.byte_4392C === 0 && rsw(VC + 2) < -12 && rsw(V1C + 2) < -12) {
      if (rsw(V1C + 2) <= -24) {
        setCurrentPlane0();
        G.byte_4392C = 1;
        sar6v(V1C6, l1);
        G.nextPosAndNormalIP = m.plane_origin_op(0, rsw(V1C6), rsw(V1C6 + 2), rsw(V1C6 + 4));
        return true;
      }
      if (!tough()) { crash(5, c1, 3); deep = 1; } // the edge of a deck
    }
    const plRot = (z, whl, nth) => {
      setv(A.vec_unk2, 0, 0, z);
      G.planindex_copy = G.planindex;
      G.pState_f36Mminf40sar2 = rsw(WHL + 2 * whl);
      c1('plane_rotate_op', nth);
    };
    if (rsw(V1C + 2) === 0) {
      plRot(0x40, w, 1);
      sublv(l1, A.vec_planerotopresult);
      return false;
    }
    if (rsw(VC + 2) > 0 && rsw(V1C + 2) < 0) {
      // Crossed the plane: move to the crossing point, then along the plane for the rest.
      let t = rsw(VC + 4); ww(VC + 4, -rsw(VC + 2)); ww(VC + 2, t);
      t = rsw(V1C + 4); ww(V1C + 4, -rsw(V1C + 2)); ww(V1C + 2, t);
      m.vector_op_unk(V1C, VC, VFC, 0);
      setv(V17C, (rsw(V1C) - rsw(VFC)) << 6, (rsw(V1C + 2) - rsw(VFC + 2)) << 6, (rsw(V1C + 4) - rsw(VFC + 4)) << 6);
      const ee = m.polarRadius3D(V17C);
      const f4 = s16(rsw(rc1 + 2 * w) + spd), f2 = s16(f4 - ee);
      for (let c = 0; c < 3; c++) ww(VC + 2 * c, lmuldiv(rsd(l1 + 4 * c) - rsd(l0 + 4 * c), f2, f4));
      plRot(ee, w, 3);
      for (let c = 0; c < 3; c++) wd(l1 + 4 * c, rsd(l0 + 4 * c) + rsw(VC + 2 * c) + rsw(A.vec_planerotopresult + 2 * c));
    } else {
      plRot(spd, w, 2);
      for (let c = 0; c < 3; c++) wd(l1 + 4 * c, rsd(l0 + 4 * c) + rsw(A.vec_planerotopresult + 2 * c));
    }
    sar6v(V1C6, l1);
    let np = m.plane_origin_op(G.planindex, rsw(V1C6), rsw(V1C6 + 2), rsw(V1C6 + 4));
    G.nextPosAndNormalIP = np;
    if (np < 0) { // still below: push out along the plane normal
      if (deep) { np = s16(-np + 6); G.nextPosAndNormalIP = np; }
      setv(V1C6, 0, -np << 6, 0);
      m.mat_mul_vector2(V1C6, planeAt(G.planindex, 0x10), VFC);
      addlv(l1, VFC);
    }
    return false;
  };

  // Wheel w against the current plane (after the wall check): gravity when in the air, landing.
  const ground = w => {
    const l1 = L1C0 + 12 * w;
    for (;;) {
      if (G.nextPosAndNormalIP > 0) {
        if (F0 > 0 && G.nextPosAndNormalIP < 0x18) addlv(l1, VE4);
        else {
          for (let i = G.framespersec === 10 ? 2 : 1; i > 0; i--) {
            ww(rc1 + 2 * w, rsw(rc1 + 2 * w) + rsw(A.word_3BD72 + 2 * w));
            wd(l1 + 4, rsd(l1 + 4) - rsw(rc1 + 2 * w));
          }
          ww(V1C6 + 2, sar6(l1 + 4));
          G.nextPosAndNormalIP = inputmode2() ? rsw(V1C6 + 2) : m.plane_origin_op(G.planindex, rsw(V1C6), rsw(V1C6 + 2), rsw(V1C6 + 4));
          if (G.nextPosAndNormalIP > 12) wb(surf + w, 0);
        }
      }
      const np = G.nextPosAndNormalIP;
      ww(W16 + 2 * w, np);
      if (np > 0) return;
      if (np < 0 && belowPlane(w)) continue;
      // On the ground: rc1 is the vertical speed it landed with.
      if (rsw(rc1 + 2 * w) > 0xfa) p.field_CF |= 0x20;
      if (rsw(rc1 + 2 * w) > limit(0x5aeb)) crash(1, c1, 4);
      ww(rc1 + 2 * w, 0);
      return;
    }
  };

  // Passes over the 4 wheels, restarted after each wall hit; the 5th restart gives up (crash).
  for (let pass = 1; ; pass++) {
    wb(L(2), pass); // var_2
    if (pass === 5) {
      if (tough()) return bounceBack();
      p.car_36MwhlAngle = 0x200; crash(1, c1, 0); break;
    }
    let restart = false;
    for (let w = 0; w < 4 && !restart; w++) {
      const l1 = L1C0 + 12 * w;
      sar6v(V1C6, l1);
      if (!inputmode2()) c1('build_track_object', 0, V1C6, p.$car_whlWorldCrds1 + 6 * w);
      else { G.wallindex = -1; G.current_surf_type = 1; setCurrentPlane0(); }
      wb(surf + w, U.current_surf_type);
      sar6v(V1C6, l1);
      G.nextPosAndNormalIP = inputmode2() ? rsw(V1C6 + 2) : m.plane_origin_op(G.planindex, rsw(V1C6), rsw(V1C6 + 2), rsw(V1C6 + 4));
      if (G.wallindex !== -1 && G.nextPosAndNormalIP > G.elRdWallRelated && G.nextPosAndNormalIP < G.wallHeight) restart = wallHit(w);
      if (!restart) ground(w);
    }
    if (!restart) break;
  }
  if ([0, 1, 2, 3].every(w => rb(surf + w) === 5)) crash(2, c1, 1);

  // Suspension (carState_rc_op) and the new wheel world coordinates.
  for (let w = 0; w < 4; w++) {
    const l1 = L1C0 + 12 * w;
    sar6v(p.$car_whlWorldCrds1 + 6 * w, l1);
    const ee = s16(c1('carState_rc_op', 0, pState, rw(W16 + 2 * w), w)) + 0x180;
    if (z1() === 0 && x1() === 0) wd(l1 + 4, rsd(l1 + 4) + s16(ee));
    else {
      setv(V1C6, 0, ee, 0);
      m.mat_mul_vector(V1C6, A.mat_unk, V182);
      addlv(l1, V182);
    }
  }

  // New position: wheel average, clamped to the track area.
  const avg = c => { let s = 0; for (let w = 0; w < 4; w++) s = (s + rsd(L1C0 + 12 * w + 4 * c)) | 0; return s >> 2; };
  G.pState_lvec1_x = avg(0); G.pState_lvec1_y = avg(1); G.pState_lvec1_z = avg(2);
  for (let w = 0; w < 4; w++) {
    const l1 = L1C0 + 12 * w;
    setv(V1DE + 6 * w, rsd(l1) - G.pState_lvec1_x, rsd(l1 + 4) - G.pState_lvec1_y, rsd(l1 + 8) - G.pState_lvec1_z);
  }
  if (G.pState_lvec1_y < 0) G.pState_lvec1_y = 0;
  const clamp = v => v > 0x1df100 ? 0x1df0ff : v < 0xf00 ? 0xf00 : v;
  G.pState_lvec1_x = clamp(G.pState_lvec1_x);
  G.pState_lvec1_z = clamp(G.pState_lvec1_z);

  // New orientation from the wheel quad (0,1 front; 2,3 rear): yaw, then pitch, then roll.
  const q = (i, c) => rsw(V1DE + 6 * i + 2 * c); // wheel i, component c
  const rotateQuad = () => { for (let w = 0; w < 4; w++) { cpv(VFC, V1DE + 6 * w); m.mat_mul_vector(VFC, MATZ, V1DE + 6 * w); } };
  let e = s16(q(3, 0) + q(2, 0) - q(0, 0) - q(1, 0)), f2 = s16(q(3, 2) + q(2, 2) - q(0, 2) - q(1, 2));
  G.pState_minusRotate_y_1 = m.polarAngle(e, s16(-f2), s16(-f2)) & 0x3ff;
  m.mat_rot_y(MATZ, y1());
  rotateQuad();
  f2 = s16(q(3, 2) + q(2, 2) - q(0, 2) - q(1, 2));
  let f4 = s16(q(3, 1) + q(2, 1) - q(0, 1) - q(1, 1));
  const small = a => (a < 0 ? s16(-a) : a) < 2;
  if (f4 === 0 && f2 < 0) G.pState_minusRotate_x_1 = 0;
  else {
    G.pState_minusRotate_x_1 = m.polarAngle(s16(-f2), f4, s16(-f2)) - 0x100;
    if (small(x1())) G.pState_minusRotate_x_1 = 0;
  }
  if (x1() !== 0) { m.mat_rot_x(MATZ, x1()); rotateQuad(); }
  f2 = s16(q(1, 0) + q(2, 0) - q(0, 0) - q(3, 0));
  f4 = s16(q(1, 1) + q(2, 1) - q(0, 1) - q(3, 1));
  if (f4 === 0 && f2 > 0) G.pState_minusRotate_z_1 = 0;
  else {
    G.pState_minusRotate_z_1 = m.polarAngle(f2, f4, f4) - 0x100;
    if (small(z1())) G.pState_minusRotate_z_1 = 0;
  }
  p.car_sumSurfFrontWheels = rb(surf) + rb(surf + 1);
  p.car_sumSurfRearWheels = rb(surf + 2) + rb(surf + 3);

  if (!inputmode2()) {
    if (U.is_in_replay === 0) c2('audio_unk3', 0, p.field_CF & 0xff, flag ? U.word_4408C : U.word_43964);
    // Wheel-to-wheel check against plane changes (e.g. going through a road surface): crash.
    // roofPoint: V1C6 = the point above wheel w at the car's height.
    const roofPoint = (w, mat) => {
      cpv(V1C6, pSimd + SO.wheel_coords + 6 * w);
      ww(V1C6 + 2, rsw(pSimd + SO.collide_points + 2) << 6);
      m.mat_mul_vector(V1C6, mat, VFC);
      setv(V1C6, (rsw(VFC) + G.pState_lvec1_x) >> 6, (rsw(VFC + 2) + G.pState_lvec1_y) >> 6, (rsw(VFC + 4) + G.pState_lvec1_z) >> 6);
    };
    // The roof hit the ground or went through a road surface: crash, unless the car is tough
    // enough. If it is upside down, it then lands on its wheels.
    let roll = false;
    const roofHit = () => {
      if (!roll && !tough()) return crash(5, c2, 0);
      if (G.planindex < 4 || (m.cos_fast(z1()) < 0) !== (m.cos_fast(x1()) < 0)) roll = true;
    };
    const ea = m.mat_rot_zxy(s16(-z1()), s16(-x1()), s16(-y1()), 0);
    for (let w = 0; w < 4; w++) {
      const wc2 = p.$car_whlWorldCrds2 + 6 * w;
      roofPoint(w, ea);
      cpv(V17C, V1C6);
      c2('build_track_object', 1, V1C6, wc2);
      const h = m.plane_origin_op(G.planindex, rsw(V1C6), rsw(V1C6 + 2), rsw(V1C6 + 4));
      if (G.planindex >= 4) {
        const pi = G.planindex;
        cpv(V1C6, wc2);
        c2('build_track_object', 0, V1C6, V17C);
        if (G.planindex === pi) {
          const h0 = m.plane_origin_op(G.planindex, rsw(V1C6), rsw(V1C6 + 2), rsw(V1C6 + 4));
          if (U.game_replay_mode !== 1 && ((h < 0 && h0 > 0) || (h > 0 && h0 < 0))) roofHit();
        }
      } else if (h <= 0) roofHit();
      cpv(wc2, V17C);
    }
    if (roll) {
      // Upright, heading the way the car is moving, at half the speed.
      const dx = G.pState_lvec1_x - rsd(pos), dz = G.pState_lvec1_z - rsd(pos + 8);
      if (Math.abs(dx) + Math.abs(dz) > 64) G.pState_minusRotate_y_1 = m.polarAngle(s16(-dx), s16(dz), 0) & 0x3ff;
      G.pState_minusRotate_z_1 = G.pState_minusRotate_x_1 = 0;
      p.car_speed = p.car_speed2 = p.car_speed2 >> 1;
      p.car_36MwhlAngle = p.car_angle_z = 0;
      const up = m.mat_rot_zxy(0, 0, s16(-y1()), 0);
      for (let w = 0; w < 4; w++) { roofPoint(w, up); cpv(p.$car_whlWorldCrds2 + 6 * w, V1C6); }
    }

    const all = s8(p.car_sumSurfFrontWheels + p.car_sumSurfRearWheels);
    if (flag === 0 && all === 0 && p.car_sumSurfAllWheels !== 0) state.game_jumpCount = state.game_jumpCount + 1;
    p.car_sumSurfAllWheels = all;
    setv(V11A, s16(G.pState_lvec1_x >> 6), s16(G.pState_lvec1_y >> 6), s16(G.pState_lvec1_z >> 6));
    setv(V11A + 6, z1(), x1(), y1());
    const coll = (nth, shape, target) => c2('car_car_coll_detect_maybe', nth, pSimd + SO.collide_points, V11A, shape, target) & 0xff;
    if (gameconfig.game_opponenttype !== 0) {
      const o = new CARSTATE(oState);
      sar6v(V18E, o.$car_posWorld1);
      setv(V18E + 6, rsw(o.$car_rotate + 4), rsw(o.$car_rotate + 2), rsw(o.$car_rotate));
      if (coll(0, oSimd + SO.collide_points, V18E)) {
        if (p.field_C8 !== 0) return;
        if ((c2('car_car_speed_adjust_maybe', 0, pState, oState) & 0xff) === 0) return;
        crash(1, c2, 1);
        c2('update_crash_state', 2, 1, (fl & 0xff00) | ((fl & 0xff) ^ 1)); // the other car
        return;
      }
    }
    // Scenery objects and checkpoints of the car's tile, and the start gate posts.
    const tx = rsw(V11A) >> 10, tz = s16(0x1d - (rsw(V11A + 4) >> 10));
    setv(V18E + 6, 0, 0, 0);
    if (tx >= 0 && tx < 30 && tz >= 0 && tz < 30) {
      const n = c2('bto_auxiliary1', 0, tx, tz, VDC) & 0xff;
      for (let i = 0; i < n; i++) {
        cpv(V18E, VDC + 6 * i);
        if (coll(1, A.unk_3BD6A, V18E)) {
          if (tough()) return bounceBack();
          p.car_36MwhlAngle = p.car_36MwhlAngle - 0x200; crash(1, c2, 2); return;
        }
      }
      const cp = rsb(farptrAt(A.trackdata19, rw(A.trackrows + 2 * tz) + tx));
      if (cp !== -1 && rsb(state.$field_3FA + cp) === 0) {
        cpv(V18E, farptrAt(A.td10_track_check_rel, cp * 6));
        if (coll(2, A.unk_3BD5A, V18E)) {
          wb(state.$field_3FA + cp, 1);
          c2('state_op_unk', 0, cp + 2, u16(-rsw(rot)), speedScaled(p.car_speed2, false));
        }
      }
      if (tx === G.startcol2 && tz === G.startrow2) {
        const post = (a, nth) => {
          ww(V18E, rsw(A.trackcenterpos2 + 2 * G.startcol2) + m.multiply_and_scale(m.sin_fast(u16(G.track_angle + a)), 0x7e));
          ww(V18E + 4, m.multiply_and_scale(m.cos_fast(u16(G.track_angle + a)), 0x7e) + rsw(A.trackcenterpos + 2 * G.startrow2));
          return coll(nth, A.unk_3BD62, V18E);
        };
        ww(V18E + 2, rsw(A.hillHeightConsts + 2 * G.hillFlag));
        if (post(0x100, 3) || post(0x300, 4)) {
          if (tough()) return bounceBack();
          crash(1, c2, 2); return;
        }
      }
    }
  }
  // Commit.
  wd(pos, G.pState_lvec1_x); wd(pos + 4, G.pState_lvec1_y); wd(pos + 8, G.pState_lvec1_z);
  ww(rot + 4, z1()); ww(rot + 2, x1()); ww(rot, y1());
  p.field_C8 = 0;
}

// ============================================================================================
// player_op: one tick of the player car, then the path tracking. state.field_2F2 is the path piece
// the car is on (td01: next piece, td02: split alternative), field_2F4 the piece seen last tick.
// field_45B: 0 on the path, 1 off the track (detect_penalty found no piece), 2 driving the wrong way.
// field_45C counts consecutive ticks on an unexpected piece; after 3 the car is placed there and
// skipped pieces cost 3 s each (penalty_time). field_45D is the arrow shown: 0 none, 1/2 turn
// hints from field_48 (angle to the next target point car_vec_unk3), 3 wrong way.
export function player_op(input) {
  origFrame('player_op', 0x52, (L, st) => {
    const P2 = L(0x2), P1E = L(0x1e), V1A = L(0x1a), V28 = L(0x28), V32 = L(0x32), V38 = L(0x38), V52 = L(0x52);
    const ps = playerstate(), pos = ps.$car_posWorld1, target = ps.$car_vec_unk3;
    if (U.show_penalty_counter !== 0) G.show_penalty_counter = U.show_penalty_counter - 1;
    ps.field_CF = 1;
    if (ps.car_crashBmpFlag !== 0) {
      state.field_45D = 0;
      input = 2; wb(DS + u16(st.bp + 6), 2);
      if (ps.car_speed2 === 0) {
        ps.field_CF = 0;
        if (ps.car_speed === 0 && [0, 2, 4, 6].every(o => rsw(ps.$car_rc1 + o) === 0)) return;
      }
    }
    const inp = s8(input);
    const c = (to, nth, ...a) => invoke(st, 'player_op', to, nth, ...a);
    c('update_car_speed', 0, u16(inp), 0, ps.addr, A.simd_player);
    c('upd_statef20_from_steer_input', 0, ((inp >> 2) & 3) | (tweaks.assist ? inp & 0xc0 : 0)); // assist: stick deflection
    c('update_grip', 0, ps.addr, A.simd_player, 1);
    c('update_player_state', 0, ps.addr, A.simd_player, state.$opponentstate, A.simd_opponent, 0);
    state.game_travDist = state.game_travDist + ps.car_speed2;

    const was45B = state.field_45B;
    wb(L(0x1c), was45B);
    ww(P2, state.field_2F2);
    if (s8(c('detect_penalty', 0, P2, P1E))) {
      const skipped = rsw(P1E);
      if (skipped === -2) { state.field_45B = 1; state.field_45C = 0; }
      else if (state.field_45B === 1) { state.field_45B = 0; state.field_45C = 0; }
      if (state.field_45B === 0) {
        const piece = rsw(P2), last = state.field_2F4;
        let settle = false;
        if (piece === 0 && last !== 0) { ps.field_CD = ps.field_CD + 1; settle = true; } // crossed the finish
        else if (skipped >= 0 && skipped < 3) { state.field_45C = 0; state.field_2F2 = piece; }
        else if (skipped === -1 || skipped > 3) {
          if (td01(last) === piece || td02(last) === piece) state.field_45C = state.field_45C + 1;
          else {
            if (td01(piece) === last || td02(piece) === last) state.field_45B = 2;
            state.field_45C = 1;
          }
          settle = state.field_45C >= 3;
        }
        if (settle) {
          state.field_2F2 = piece;
          state.field_45C = 0;
          if (skipped > 0) {
            G.penalty_time = s16(u16(skipped * G.framespersec) * 3);
            G.show_penalty_counter = (G.framespersec << 2) & 0xff;
            state.game_penalty = state.game_penalty + G.penalty_time;
          }
        }
      }
      state.field_2F4 = rsw(P2);
    }

    state.field_45D = 0;
    if (state.field_45B === 1) return;
    const rotMat = () => { // var_matptr
      const mat = m.mat_rot_zxy(rsw(ps.$car_rotate + 4), rsw(ps.$car_rotate + 2), rsw(ps.$car_rotate), 1);
      ww(L(0x20), mat - DS);
      return mat;
    };
    // v -= car position (y -1: no height, replaced by noY), then V38 = v in car space.
    const toCar = (v, mat, noY) => {
      ww(v, rsw(v) - sar6(pos));
      ww(v + 2, rsw(v + 2) === -1 ? noY : rsw(v + 2) - sar6(pos + 4));
      ww(v + 4, rsw(v + 4) - sar6(pos + 8));
      m.mat_mul_vector(v, mat, V38);
    };
    const mat = rotMat();
    // Target point tracking: the car steers towards car_vec_unk3, point field_CE of path piece
    // car_trackdata3_index (-1: none). When it is near (or none), the next point is taken.
    let piece = null, advance = false, hint = true;
    if (state.field_45B === 2) {
      if (ps.car_crashBmpFlag === 0) state.field_45D = 3;
      piece = state.field_2F4;
    } else {
      let ahead = 0;
      if (ps.car_trackdata3_index !== -1) {
        const f = state.field_2F2, idx = ps.car_trackdata3_index;
        if ((was45B !== 0 && state.field_45B === 0) || !(idx === f || td01(f) === idx || td02(f) === idx)) ps.car_trackdata3_index = -1;
        else { cpv(V32, target); toCar(V32, mat, 0); ahead = rsw(V38 + 4); }
      }
      if (ahead < 0x113) {
        if (ps.car_trackdata3_index === -1) piece = state.field_2F2;
        else advance = true;
      }
    }
    if (piece !== null) {
      ww(P2, piece);
      if (td02(piece) !== -1) hint = false; // split piece
      else {
        // Nearest point ahead of the car on the piece.
        let best = 0, done = 0;
        for (let i = 0; !done; i = (i + 1) & 0xff) {
          done = c('sub_18D60', 0, u16(piece), target, i, 0) & 0xff;
          wb(L(0x2a), done); wb(L(0x2c), i + 1); // var_2A, var_2C (after the loop's inc)
          cpv(V28, target);
          toCar(V28, mat, s16(-sar6(pos + 4)));
          if (i === 0 || (rsw(V38 + 4) < rsw(V32 + 4) && rsw(V38 + 4) > 0)) { best = i; wb(L(0x3a), i); ww(V32 + 4, rsw(V38 + 4)); }
        }
        let found = true;
        if (state.field_45B === 2) {
          // Wrong way: back on track once heading along the piece segment again.
          if (best === 0) c('sub_18D60', 1, u16(piece), V52, 0, 0);
          else c('sub_18D60', 2, u16(piece), V52, u16(s8(best - 1)), 0);
          c('sub_18D60', 3, u16(piece), V1A, best === 0 ? 1 : best, 0);
          const dz = s16(rsw(V52) - rsw(V1A));
          const d = (rsw(ps.$car_rotate) - (m.polarAngle(dz, s16(rsw(V1A + 4) - rsw(V52 + 4)), dz) & 0x3ff)) & 0x3ff;
          if (d > 0x380 || d < 0x80) { state.field_45B = 0; state.field_45C = 1; ps.car_trackdata3_index = piece; }
          else found = false;
        } else ps.car_trackdata3_index = state.field_2F2;
        if (found) ps.field_CE = best;
        advance = true;
      }
    }
    if (advance) {
      const ce = ps.field_CE;
      ps.field_CE = ce + 1;
      if (c('sub_18D60', 4, u16(ps.car_trackdata3_index), target, ce & 0xff, 0) & 0xff) { // last point: next piece
        ps.car_trackdata3_index = td02(state.field_2F2) !== -1 ? -1 : td01(state.field_2F2);
        ps.field_CE = 0;
      }
    }
    if (hint) {
      // Turn hint (field_48: angle to the target in car space).
      cpv(V28, target);
      if (ps.car_trackdata3_index !== -1 && state.field_45B === 0) {
        toCar(V28, rotMat(), 0);
        const a = m.polarAngle(s16(-rsw(V38)), rsw(V38 + 4), s16(-rsw(V38))) & 0x3ff;
        ps.field_48 = a;
        if (ps.car_crashBmpFlag === 0) {
          const dir = ((a + 0x80) & 0x3ff) >> 8;
          state.field_45D = dir === 1 ? 1 : dir === 3 && ps.field_B6 === 0 ? 2 : 0;
        }
      }
    }
    if (ps.field_CD !== 0) {
      // Behind the start line after crossing it backwards: crash.
      const ta = G.track_angle;
      const d = s16(m.multiply_and_scale(m.cos_fast(ta), s16(rsw(A.trackcenterpos + 2 * G.startrow2) - sar6(pos + 8)))
        + m.multiply_and_scale(m.sin_fast(ta), s16(rsw(A.trackcenterpos2 + 2 * G.startcol2) - sar6(pos))));
      if (d < 0) c('update_crash_state', 0, 3, 0);
    }
  });
}

// ============================================================================================
// detect_penalty: finds the car's tile on the path, walking from piece *pPiece along td01 (and the
// td02 alternatives). Returns 0 on the start tile, else 1 with *pSkipped = pieces skipped (0: same
// or next, -1: went past the finish, -2: not on the path) and *pPiece = the piece found. Also sets
// game_startcol/row(2) to the found (or off-path) tile.
export function detect_penalty(pPiece, pSkipped) {
  return origFrame('detect_penalty', 0x5a4, (L, st) => {
    const VISITED = L(0x5a2), STACK_PIECE = L(0x216), STACK_SKIP = L(0x10e);
    const W = (off, v) => ww(L(off), v), B = (off, v) => wb(L(off), v); // scalar locals, as residue
    const pos = state.$playerstate + CS.car_posWorld1;
    const col = rsb(pos + 2), row = s8(0x1d - rb(pos + 10));
    B(4, col); B(0xa, row); W(0x5a4, col);
    if (col === state.game_startcol || col === state.game_startcol2) {
      W(0x5a4, row);
      if (row === state.game_startrow || row === state.game_startrow2) { ww(pSkipped, 0); return 0; }
    }
    const offPath = () => { ww(pSkipped, -2); return 1; };
    if (col < 0 || col > 29 || row < 0 || row > 29) return offPath();
    let best = 0, bestPiece = 0, sp = 0, skipped = 0;
    W(6, 0); W(0x21a, 0);
    for (let i = 0; i < G.track_pieces_counter; i++) wb(VISITED + i, 0);
    let si = rsw(pPiece);
    for (;;) {
      let piece = rsw(farptrAt(A.td01_track_file_cpy, 2 * si));
      W(2, piece);
      if (rb(VISITED + piece) !== 0) {
        if (sp !== 0) {
          sp--; W(0x21a, sp); W(0x5a4, st.bp + 2 * sp);
          si = rsw(STACK_PIECE + 2 * sp); skipped = rsw(STACK_SKIP + 2 * sp);
          continue;
        }
        if (best !== 0) { ww(pPiece, bestPiece); ww(pSkipped, best); return 1; }
        state.game_startcol = state.game_startcol2 = col;
        state.game_startrow = state.game_startrow2 = row;
        return offPath();
      }
      wb(VISITED + piece, 1);
      const r0 = rb(farptrAt(A.td22_row_from_path, piece)), c0 = rb(farptrAt(A.td21_col_from_path, piece));
      const multi = rb(A.trkObjectList + 14 * rb(farptrAt(A.td17_trk_elem_ordered, piece)) + 11);
      const r1 = multi & 1 ? (r0 + 1) & 0xff : r0, c1 = multi & 2 ? (c0 + 1) & 0xff : c0;
      B(0xe, r0); B(0x116, multi); B(0x218, r1); B(0xc, c0); B(0x114, c1);
      if ((c0 === (col & 0xff) || c1 === (col & 0xff)) && (r0 === (row & 0xff) || r1 === (row & 0xff))) {
        if (td02(si) !== -1) { piece = si; W(2, piece); }
        state.game_startcol = s8(c0); state.game_startcol2 = s8(c1);
        state.game_startrow = s8(r0); state.game_startrow2 = s8(r1);
        if (skipped <= 0) { ww(pPiece, piece); ww(pSkipped, skipped); return 1; }
        if (best === 0 || best > skipped) { bestPiece = piece; best = skipped; W(0x110, piece); W(6, skipped); }
      }
      const alt = td02(si);
      W(8, alt);
      if (alt !== -1) { ww(STACK_SKIP + 2 * sp, skipped); ww(STACK_PIECE + 2 * sp, alt); sp++; W(0x21a, sp); }
      if (piece === 0) skipped = -1;
      else if (skipped !== -1) skipped = s16(skipped + 1);
      si = piece;
    }
  });
}

// ============================================================================================
// sub_18D60: target point `idx` of path piece `piece` (along the driving direction). out gets the
// midpoint (y -1: no height) and the two points of the segment, then a flag at +0x12 (piece has
// an alternative path table). oppSpeed (optional) gets the opponent speed code for the piece.
// Returns 1 for the last point of the piece.
export function sub_18D60(piece, out, idx, oppSpeed) {
  const st = origStack('sub_18D60'); // no callees: the frame only matters as stack residue
  st.enter(0x30, cpu.di, cpu.si);
  const near = off => DS + u16(off);
  const elem = rb(farptrAt(A.td17_trk_elem_ordered, piece));
  const td18 = rb(farptrAt(A.trackdata18, piece));
  const reversed = td18 & 0x10;
  const obj = A.trkObjectList + 14 * elem;           // TRACKOBJECT
  const info = u16(rw(obj) + 14 * (td18 & 0xf));      // TRKOBJINFO (near)
  const points = rb(near(info + 5));                  // si_arrowType: number of points
  idx &= 0xff;
  const k = (reversed ? (points - idx) * 2 - 2 : idx * 2) & 0xff;
  if (oppSpeed) wb(oppSpeed, rb(near(A.oppnentSped - DS + rb(near(info + 13)) + rb(obj + 9))));
  const alt = rw(near(info + 10)), hasAlt = alt !== 0 ? 1 : 0;
  const table = reversed && hasAlt ? alt : rw(near(info + 8)), base = u16(table + k * 6);
  const [a, b] = reversed && !hasAlt ? [base + 6, base] : [base, base + 6];
  st.push(DSEG); st.pop(1); // push ds / pop ds around the movsw copies
  let cx = rsw(near(a)), cy = rsw(near(a + 2)), cz = rsw(near(a + 4));
  let dx = rsw(near(b)), dy = rsw(near(b + 2)), dz = rsw(near(b + 4));
  const dx0 = dx, rotation = rw(near(info + 6));
  switch (rotation) {
    case 0x100: [cx, cz, dx, dz] = [cz, s16(-cx), dz, s16(-dx)]; break;
    case 0x200: [cx, cz, dx, dz] = [s16(-cx), s16(-cz), s16(-dx), s16(-dz)]; break;
    case 0x300: [cx, cz, dx, dz] = [s16(-cz), cx, s16(-dz), dx]; break;
  }
  const col = rb(farptrAt(A.td21_col_from_path, piece)), row = rb(farptrAt(A.td22_row_from_path, piece));
  if (cy !== -1 && rb(farptrAt(A.td15_terr_map_main, rw(A.terrainrows + 2 * row) + col)) === 6) {
    const h = rsw(A.hillHeightConsts + 2); // on a hill tile
    cy = s16(cy + h); dy = s16(dy + h);
  }
  const multi = rb(obj + 11);
  const zo = rsw((multi & 1 ? A.trackpos : A.trackcenterpos) + 2 * row);
  const xo = rsw(multi & 2 ? A.trackpos2 + 2 + 2 * col : A.trackcenterpos2 + 2 * col);
  cz = s16(cz + zo); dz = s16(dz + zo); cx = s16(cx + xo); dx = s16(dx + xo);
  setv(out, (dx + cx) >> 1, cy === -1 ? -1 : (dy + cy) >> 1, (dz + cz) >> 1);
  setv(out + 6, cx, cy, cz);
  setv(out + 12, dx, dy, dz);
  ww(out + 0x12, hasAlt);
  // Locals as the original leaves them.
  for (const [k1, v] of [[2, elem], [0x1c, td18 & 0xf], [0x28, reversed], [0x18, points], [0x10, k], [0x16, col], [0x1a, row]]) st.localByte(k1, v);
  for (const [k1, v] of [[0x26, obj - DS], [0x14, rw(obj)], [0x12, DSEG], [6, info], [4, DSEG], [0x24, hasAlt], [0x2c, table],
    [0x2a, DSEG], [0x30, base], [0x2e, DSEG], [0xc, cx], [0xa, cy], [8, cz], [0x22, dx], [0x20, dy], [0x1e, dz]]) st.local(k1, v);
  if (rotation === 0x100 || rotation === 0x300) st.local(0xe, dx0);
  return u16(points - 1) === u16(s8(idx)) ? 1 : 0;
}

// sub_18D06: replay sound update for record p (player at +6, opponent at +0x12).
export function sub_18D06(p, t) {
  let r = call.audio_op_unk2(U.word_43964, rw(p + 0x1e), rw(p + 6), rw(p + 8), rw(p + 0xa), rw(p + 0xc), rw(p + 0xe), rw(p + 0x10), t);
  if (gameconfig.game_opponenttype !== 0)
    r = call.audio_op_unk2(U.word_4408C, rw(p + 0x20), rw(p + 0x12), rw(p + 0x14), rw(p + 0x16), rw(p + 0x18), rw(p + 0x1a), rw(p + 0x1c), t);
  return r;
}

provide({ update_player_state, player_op, detect_penalty, sub_18D60, sub_18D06 });
export const PORTS = ['update_player_state', 'player_op', 'detect_penalty', 'sub_18D60', 'sub_18D06'];
