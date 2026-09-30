// Car dynamics, ported from the original asm (seg001/seg002): engine and speed, steering,
// grip and sliding, suspension travel, car-car impacts and crash/finish events.
// Car state and SIMD arguments are linear addresses of CARSTATE / SIMD structs.
import { A, G, U, DS, M, rb, rsb, rw, rsw, ww, s8, u8, s16, u16, u32, farptrAt } from './mem.js';
import { CARSTATE, SIMD, state } from './structs.js';
import { sin_fast, cos_fast, multiply_and_scale, polarRadius2D, polarAngle } from './math.js';
import { call, provide, defineSigs, isEnabled } from './calls.js';
import { origStack } from './stack.js';
import { cpu } from './engine.js';

defineSigs({ state_op_unk: 'www', audio_function2_wrap: 'w' });

const abs16 = v => (v < 0 ? s16(-v) : v); // C abs() on an int: abs(-32768) stays -32768
const hi = v => (v >> 16) & 0xffff; // high word of a long (cwd for an int)
// __aFuldiv / __aFldiv: 32-bit divisions (a zero divisor would trap in the original).
function uldiv(a, b) { if (!b) throw new Error('divide by zero'); return Math.floor(u32(a) / u32(b)); }
function ldiv(a, b) { if (!b) throw new Error('divide by zero'); return Math.trunc((a | 0) / (b | 0)); }

const CS = CARSTATE.offsets, SD = SIMD.offsets;

// update_car_speed: gear changes, engine torque, drag and braking, speed and rpm.
// input: bits 1 accelerate, 2 brake, 0x10/0x20 shift up/down (manual gearbox).
export function update_car_speed(input, mplayer, carState, simd) {
  const st = origStack('update_car_speed');
  st.enter(10, cpu.di, cpu.si); // locals: 2 knob step, 4 diff, 6 new speed, 8 delta, 10 torque (byte)
  const c = new CARSTATE(carState), s = new SIMD(simd);
  const fps = G.framespersec;
  const knobStep = fps === 20 ? 6 : 12;
  st.local(2, knobStep);
  const opponent = (mplayer & 0xff) !== 0;
  if (c.car_engineLimiterTimer !== 0) c.car_engineLimiterTimer--;
  c.car_speeddiff = c.car_speed2 - c.car_lastspeed;
  c.car_lastspeed = c.car_speed2;
  c.car_lastrpm = c.car_currpm;

  // Gear selection: manual from input, automatic from rpm (while the rear wheels touch ground).
  let shift = 0;
  if (c.car_transmission === 0 && c.car_changing_gear === 0) {
    if (input & 0x10) shift = 1;
    else if (input & 0x20) shift = -1;
  } else if (c.car_current_gear !== 0 && c.car_changing_gear === 0 && c.car_sumSurfRearWheels !== 0) {
    if (u16(c.car_currpm) > u16(s.upshift_rpm)) shift = 1;
    else if (u16(c.car_currpm) < u16(s.downshift_rpm)) shift = -1;
  }
  let shifted = false;
  if (shift > 0 && c.car_current_gear !== s.num_gears) { c.car_current_gear++; shifted = true; }
  if (shift < 0 && c.car_current_gear > 1) { c.car_current_gear--; shifted = true; }
  if (shifted) {
    c.car_changing_gear = 1;
    c.car_fpsmul2 = (s8(fps) >> 1) + fps;
    const knob = s.$knob_points + c.car_current_gear * 4;
    c.car_knob_x2 = rsw(knob);
    c.car_knob_y2 = rsw(knob + 2);
  }

  // Gear knob animation: back to the neutral row, across, then into the target gear.
  const approach = (v, target, absSite) => {
    const d = s16(target - v);
    st.local(4, d);
    st.call('_abs', absSite, [d], [st.bp]);
    return abs16(d) <= knobStep ? target : d > 0 ? v + knobStep : v - knobStep;
  };
  if (c.car_changing_gear !== 0) {
    const neutralY = rsw(s.$knob_points + 2);
    if (c.car_knob_x === c.car_knob_x2) {
      if (c.car_knob_y2 === c.car_knob_y) {
        st.local(4, 0);
        c.car_changing_gear = 0;
        c.car_gearratio = rw(s.$gear_ratios + c.car_current_gear * 2);
        c.car_gearratioshr8 = c.car_gearratio >> 8;
      } else c.car_knob_y = approach(c.car_knob_y, c.car_knob_y2, 0);
    } else if (neutralY === c.car_knob_y) c.car_knob_x = approach(c.car_knob_x, c.car_knob_x2, 1);
    else c.car_knob_y = approach(c.car_knob_y, neutralY, 2);
  } else if (c.car_fpsmul2 !== 0) c.car_fpsmul2--;

  // Speed change: slope gravity minus aero drag, then engine or brakes.
  let speed = c.car_speed;
  let delta = s16(c.car_pseudoGravity - rsw(farptrAt(s.$aerorestable, (speed >> 10) << 1)));
  let si = u16(simd - DS); // the original's si, pushed by __aFuldiv/__aFldiv
  if (u16(c.car_currpm) > u16(s.max_rpm)) {
    c.car_currpm = s.max_rpm - 1;
    delta = s16(delta - s.braking_eff);
  } else if ((input & 3) === 1) {
    c.car_is_braking = 0;
    c.car_is_accelerating = 1;
    if (c.car_changing_gear !== 0) {
      c.car_engineLimiterTimer = 0;
      c.car_currpm -= fps === 10 ? 80 : 40;
    } else if (c.car_sumSurfRearWheels === 0) {
      // Wheels in the air: the engine revs freely.
      if (u16(c.car_currpm) < u16(s.max_rpm) && speed < 0xfa00) delta = s16(delta + 0x300);
    } else {
      let torque;
      if (c.car_current_gear <= 1 && c.car_currpm < 0xa28) torque = u8(s.idle_torque);
      else {
        si = u16(c.car_currpm) >> 7;
        torque = rb(s.$torque_curve + si);
      }
      if (c.car_engineLimiterTimer !== 0 && c.car_currpm < 5000) torque = (u8(s.idle_torque) + torque) >> 1;
      st.localByte(10, torque);
      delta = s16(delta + (u16(c.car_gearratioshr8 * torque) >> 4));
      // delta * 25 / mass (unsigned) / 2
      const mass = u16(s.car_mass), prod = delta * 25;
      st.push(0, mass);
      st.call('__aFlmul', 0, [0, 25, hi(delta), u16(delta)], [st.bp]);
      st.call('__aFuldiv', 0, [hi(prod), u16(prod)], [st.bp, 25, si]); // bx = 25 from __aFlmul
      st.pop(2);
      delta = s16(uldiv(prod, mass)) >> 1;
      if (opponent) {
        // Opponent handicap: oppnentSped 200 is full power.
        const handicap = u8(u16(-(rb(A.oppnentSped) - 200)) >>> 1);
        st.localByte(10, handicap);
        if (handicap !== 0) {
          const p = handicap * delta, ap = Math.abs(p); // __aFldiv negates a negative dividend in place
          st.push(0, 200);
          st.call('__aFlmul', 1, [hi(delta), u16(delta), 0, handicap], [st.bp]);
          st.call('__aFldiv', 0, [hi(ap), u16(ap)], [st.bp, u16(carState - DS), si, u16(delta)]);
          st.pop(2);
          delta = s16(delta - ldiv(p, 200));
        }
      }
      if (delta > 0x128) c.car_engineLimiterTimer = 5;
    }
  } else if ((input & 3) === 2) {
    c.car_is_accelerating = 0;
    c.car_engineLimiterTimer = 0;
    c.car_is_braking = 1;
    delta = s16(delta - (opponent ? s.braking_eff << 1 : s.braking_eff));
  } else {
    c.car_is_accelerating = 0;
    c.car_is_braking = 0;
  }

  if (fps === 10) delta = s16(delta * 2);
  if (delta < 0) speed = u16(-delta) > speed ? 0 : u16(speed + delta);
  else if (speed < 0x8000) speed = u16(speed + delta);
  else {
    speed = u16(speed + delta);
    if (speed < 0x8000 || speed > 0xf500) speed = 0xf500;
  }
  st.local(6, speed);
  st.local(8, delta);
  if (c.car_sumSurfRearWheels === 0) c.car_speed = speed;
  else {
    const diff = s16(c.car_speed2 - speed);
    st.local(4, diff);
    if (abs16(diff) > 0x1400) {
      // Too big a jump against the ground speed: average them and cut the engine briefly.
      c.car_speed = (c.car_speed + c.car_speed2) >>> 1;
      c.car_speed2 = c.car_speed;
      c.car_engineLimiterTimer = 5;
    } else {
      c.car_speed = speed;
      c.car_speed2 = speed;
    }
  }

  c.car_currpm = st.invoke('update_rpm_from_speed', 0,
    [c.car_currpm, c.car_speed, c.car_gearratio, c.car_changing_gear, s.idle_rpm]);
  if (c.car_sumSurfAllWheels !== 0 && c.car_lastrpm > c.car_currpm) {
    if (s16(c.car_lastrpm - c.car_currpm) > 2000) {
      if (s16(u8(s.idle_torque) * c.car_gearratioshr8) > 12000) c.car_engineLimiterTimer = 30;
    } else if (s16(c.car_currpm - c.car_lastrpm) > 2000) { // only on 16-bit overflow
      c.car_engineLimiterTimer = 10;
      c.car_speed2 -= 0x500;
    }
  }
  if (c.car_speed2 > state.game_topSpeed) state.game_topSpeed = c.car_speed2;
}

// update_rpm_from_speed: rpm = speed * gearratio >> 16 (unless changing gear), at least idle.
export function update_rpm_from_speed(currpm, speed, gearratio, changingGear, idleRpm) {
  const st = origStack('update_rpm_from_speed');
  st.enter(0);
  st.push(st.bp);
  let rpm = u16(currpm);
  if (u16(changingGear) === 0) rpm = Math.floor(u16(speed) * u16(gearratio) / 0x10000);
  return rpm < u16(idleRpm) ? u16(idleRpm) : rpm;
}

// upd_statef20_from_steer_input: player steering angle from the steering input (1 left, 2 right),
// through the speed-dependent steering response table.
export function upd_statef20_from_steer_input(input) {
  const st = origStack('upd_statef20_from_steer_input');
  st.enter(6, cpu.di, cpu.si);
  const p = state.playerstate;
  let angle = p.car_steeringAngle;
  const speedRow = (p.car_speed2 >> 10) & 0xfc;
  st.localByte(4, speedRow);
  const entry = DS + u16(speedRow + s8(input) + U.steerWhlRespTable_ptr);
  let d = rsb(entry);
  if ((d > 0 && angle < -1) || (d < 0 && angle > 1)) d <<= 2; // counter-steering is 4x faster
  if (d === 0 && p.car_speed2 !== 0 && angle !== 0) {
    // No input: return toward center.
    const ret = rsb(DS + u16(speedRow + U.steerWhlRespTable_ptr + 1)) * 2;
    d = abs16(angle) <= ret ? s16(-angle) : angle > 0 ? -ret : ret;
  }
  const maxd = G.framespersec === 10 ? 0xa0 : 0x50;
  d = Math.max(-maxd, Math.min(maxd, d));
  angle = Math.max(-0xf0, Math.min(0xf0, s16(angle + d)));
  if (rb(entry) === 0) {
    st.call('_abs', 0, [angle], [st.bp]);
    if (abs16(angle) < 8) angle = 0;
  }
  p.car_steeringAngle = angle;
}

// update_grip: grass drag, demanded vs available grip, sliding and yaw (car_angle_z),
// wheel angles. detailed = 0 is the simplified model (no sliding computation).
export function update_grip(carState, simd, detailed) {
  const st = origStack('update_grip');
  // locals: 2 speed>>8, 4 demanded, 6 grip, 8 scratch, 10 tile x (byte), 12 angle, 14 tile z (byte), 16 initial
  st.enter(16, cpu.di, cpu.si);
  const c = new CARSTATE(carState), s = new SIMD(simd);
  if (c.car_sumSurfAllWheels === 0) {
    c.car_40MfrontWhlAngle = 0;
    c.car_slidingFlag = 0;
    return;
  }
  const surface = i => rsb(carState + CS.car_surfaceWhl + i);
  let onGrass = 0;
  for (let i = 0; i < 4; i++) if (surface(i) === 4) onGrass++;
  st.local(8, onGrass);
  if (onGrass) {
    const div = rw(A.grassDecelDivTab + onGrass * 2);
    if (!div) throw new Error('divide by zero');
    c.car_speed2 -= Math.floor(c.car_speed2 / div);
    c.car_speed = c.car_speed2;
  }

  const initial = s16(c.car_steeringAngle + c.car_36MwhlAngle);
  let angle = initial;
  const speedHi = c.car_speed >> 8;
  const demanded = s16(((speedHi * speedHi) >>> 6) * (abs16(angle) >> 3));
  // Available grip: car grip times the sum of each wheel's surface factor (5 entries from 'sliding').
  const factor = i => rsw(simd + SD.sliding + surface(i) * 2);
  const g2 = s16(s.grip * 2), gripSum = s16(factor(0) + factor(1) + factor(2) + factor(3));
  const grip = s16((g2 * gripSum) >> 10);
  st.local(16, initial);
  st.local(2, speedHi);
  st.local(8, abs16(angle) >> 3);
  st.local(4, demanded);
  st.local(6, grip);
  st.call('__aFlmul', 0, [hi(g2), u16(g2), hi(gripSum), u16(gripSum)], [st.bp]);
  c.car_demandedGrip = demanded;
  c.car_surfacegrip_sum = grip;

  if (s16(detailed) !== 0) {
    if (c.car_steeringAngle === 0) {
      // Straighten a small residual heading (low byte of rotate.x).
      const r = s8(rb(c.$car_rotate));
      st.local(8, r);
      if (r !== 0 && abs16(r) < 8) ww(c.$car_rotate, rsw(c.$car_rotate) + (r > 0 ? -1 : 1));
    }
    if (demanded > grip) {
      c.car_slidingFlag = 1;
      // Sliding: the angle the grip can hold, grip * 256 / (speed>>8)^2.
      const v2 = speedHi * speedHi, g8 = grip * 256;
      st.call('__aFlmul', 1, [0, speedHi, 0, speedHi], [st.bp]);
      st.call('__aFldiv', 0, [0, v2, hi(Math.abs(g8)), u16(Math.abs(g8))],
        [st.bp, u16(surface(2) * 2), u16(surface(0) * 2), speedHi]); // di, si, bx as left by the grip sum
      angle = s16(ldiv(g8, v2));
      if (initial < 0) angle = s16(-angle);
      angle = s16(angle * 3 + initial) >> 2;
      c.field_42 = initial - angle;
    } else {
      c.car_slidingFlag = 0;
      if (c.field_42 !== 0) {
        c.field_42 -= c.field_42 >> 4;
        if (abs16(c.field_42) < 16) c.field_42 >>= 1;
      }
    }
    st.local(12, angle);
    c.car_40MfrontWhlAngle = c.car_angle_z === 0 && c.car_crashBmpFlag !== 1 ? angle : 0;

    const rotZ = rsw(c.$car_rotate + 4);
    if (rotZ !== 0 && abs16(rotZ) > 4) {
      // Banked elements 0x34..0x37 (resolving multi-tile filler 0xFD..0xFF to the main tile).
      let x = rb(c.$car_posWorld1 + 2), z = rb(c.$car_posWorld1 + 10);
      const elemAt = () => rb(farptrAt(A.td14_elem_map_main, rw(A.terrainrows + z * 2) + x));
      const e = elemAt();
      if (e === 0xfd || e === 0xff) x = u8(x - 1);
      if (e === 0xfd || e === 0xfe) z = u8(z + 1);
      st.localByte(10, x);
      st.localByte(14, z);
      const main = elemAt();
      if (main >= 0x34 && main <= 0x37) c.car_40MfrontWhlAngle += Math.trunc(rotZ / 5);
    }

    const yaw = () => {
      c.car_angle_z += Math.trunc(s16(angle - initial) / 14);
      c.car_angle_z = Math.trunc(c.car_angle_z / 2);
    };
    if (s16(grip + 1000) < demanded) yaw();
    else if (c.car_angle_z !== 0) {
      yaw();
      if (c.car_angle_z === 0) {
        // Yaw settled: keep the speed component along the heading.
        const whl = c.car_36MwhlAngle, cos = cos_fast(whl);
        st.push(c.car_speed2);
        st.call('cos_fast', 0, [whl], [st.bp]);
        st.call('multiply_and_scale', 0, [cos], [st.bp]);
        st.pop(1);
        st.call('cos_fast', 1, [whl], [st.bp]);
        c.car_speed2 = multiply_and_scale(cos, c.car_speed2);
        if (cos < 0) c.car_speed2 = 0;
        c.car_36MwhlAngle = 0;
      }
    }
  } else {
    c.car_40MfrontWhlAngle = c.car_steeringAngle * 4;
    if (c.car_angle_z !== 0) c.car_angle_z = s16(c.car_angle_z * 15) >> 4;
    st.local(12, angle);
  }

  if (c.car_36MwhlAngle !== 0 && c.car_angle_z === 0) c.car_36MwhlAngle = s16(c.car_36MwhlAngle * 15) >> 4;
  if (c.car_angle_z !== 0) c.car_36MwhlAngle -= c.car_angle_z;
  if (c.car_slidingFlag !== 0) {
    const loss = u16(abs16(c.field_42) * 2);
    st.local(8, loss);
    if (c.car_speed > loss) {
      if (c.car_speed2 > loss) {
        c.car_speed -= loss;
        c.car_speed2 -= loss;
      } else {
        c.car_speed = 0;
        c.car_speed2 = 0;
      }
      if (c.car_crashBmpFlag === 0) {
        let paved = false; // any wheel on surface 1
        for (let i = 0; i < 4; i++) if (surface(i) === 1) paved = true;
        c.field_CF |= paved ? 2 : 4; // skid marks
      }
    } else {
      c.car_speed = 0;
      c.car_speed2 = 0;
    }
  }
  c.field_42 = 0;
}

// car_car_speed_adjust_maybe: speed loss and deflection when the two cars collide.
// Returns 1 when the impact is hard (relative velocity > 30), which crashes both cars.
export function car_car_speed_adjust_maybe(oState, pState) {
  const st = origStack('car_car_speed_adjust_maybe');
  st.enter(0x18, cpu.si);
  const o = new CARSTATE(oState), p = new CARSTATE(pState);
  o.field_C8 = 1;
  p.field_C8 = 1;
  const oSpeed2 = o.car_speed2, pSpeed2 = p.car_speed2;
  const oAngle = rsw(o.$car_rotate), pAngle = rsw(p.$car_rotate);
  // Velocity components: speed>>8 times sin/cos of the heading.
  const component = (trig, n, angle, speed2) => {
    const t = trig === 'sin_fast' ? sin_fast(angle) : cos_fast(angle);
    st.call(trig, n, [angle], [st.bp]);
    st.call('multiply_and_scale', n + (trig === 'cos_fast' ? 2 : 0), [t, speed2 >> 8], [st.bp]);
    return multiply_and_scale(speed2 >> 8, t);
  };
  const ox = component('sin_fast', 0, oAngle, oSpeed2);
  const px = component('sin_fast', 1, pAngle, pSpeed2);
  const oz = component('cos_fast', 0, oAngle, oSpeed2);
  const pz = component('cos_fast', 1, pAngle, pSpeed2);
  // Relative speed: polarRadius2D(px - ox, pz - oz), with its polarAngle and sin/cos frames.
  const z = s16(px - ox), y = s16(pz - oz);
  st.call('polarRadius2D', 0, [y, z], () => {
    st.push(st.bp);
    const bp = st.sp;
    st.call('polarAngle', 0, [y, z], [bp, cpu.di], 'polarRadius2D');
    let a = polarAngle(z, y, z);
    if (a < 0) a = s16(-a);
    if (a >= 0x100) a = s16(-(a - 0x200));
    st.call(a <= 0x80 ? 'cos_fast' : 'sin_fast', 0, [a], [bp], 'polarRadius2D');
  });
  const impact = Math.max(10, polarRadius2D(z, y));
  const loss = u16(s16(0x300 * impact) >> 2);
  st.local(2, oAngle); st.local(4, pAngle); st.local(6, oSpeed2); st.local(12, pSpeed2);
  st.local(16, ox); st.local(20, px); st.local(18, oz); st.local(22, pz);
  st.local(10, impact);
  st.local(8, (oAngle - pAngle) & 0x3ff);
  st.local(14, (impact & 0xff) << 8);
  st.local(24, loss);
  o.car_speed2 = o.car_speed2 < loss ? 0 : o.car_speed2 - loss;
  const deflect = (c, a) => {
    c.car_36MwhlAngle = a;
    if (c.car_36MwhlAngle >= 0x200) c.car_36MwhlAngle -= 0x400;
    if (c.car_36MwhlAngle <= -0x200) c.car_36MwhlAngle += 0x400;
  };
  deflect(o, pAngle - oAngle);
  deflect(p, oAngle - pAngle);
  o.car_speed = o.car_speed2;
  p.car_speed = p.car_speed2;
  return impact > 30 ? 1 : 0;
}

// carState_rc_op: suspension travel of one wheel. rc2 = current travel, rc5 = rest target
// (decays toward 0), rc4 cleared on compression. push > 0 compresses, < 0 extends.
// Returns the old travel plus the change applied (as an int).
export function carState_rc_op(pState, push, wheelIndex) {
  const st = origStack('carState_rc_op');
  st.enter(6, cpu.di, cpu.si); // locals: 2 old travel, 4 change, 6 zero
  const off = s16(wheelIndex) * 2;
  const rc2 = pState + CS.car_rc2 + off, rc4 = pState + CS.car_rc4 + off, rc5 = pState + CS.car_rc5 + off;
  const old = rsw(rc2);
  let change = 0;
  const target = rsw(rc5);
  if (target < 0) {
    ww(rc5, target + 4);
    if (rsw(rc5) > 0) ww(rc5, 0);
  } else if (target > 0) {
    ww(rc5, target - 4);
    if (rsw(rc5) < 0) ww(rc5, 0);
  }
  let a = s16(push);
  if (a < 0 && rsw(rc2) > s16(-a)) {
    a = 0;
    st.arg(1, 0);
  }
  if (a === 0) {
    // Relax toward rc5 by 0x80 per call.
    if (rsw(rc2) > rsw(rc5)) {
      ww(rc2, rsw(rc2) - 0x80);
      if (rsw(rc2) < rsw(rc5)) ww(rc2, rsw(rc5));
      change = s16(old - rsw(rc2));
    } else if (rsw(rc2) < rsw(rc5)) {
      ww(rc2, rsw(rc2) + 0x80);
      if (rsw(rc2) > rsw(rc5)) ww(rc2, rsw(rc5));
    }
  } else if (a > 0) {
    ww(rc2, rsw(rc2) + Math.min(a, 0xc0));
    if (rsw(rc2) > 0x180) ww(rc2, 0x180);
    ww(rc4, 0);
  } else {
    if (s16(a + rsw(rc2)) > -0x120) ww(rc2, rsw(rc2) + a);
    else {
      ww(rc2, rsw(rc2) + (s16(a * 3) >> 2));
      if (rsw(rc2) < -0x180) ww(rc2, -0x180);
    }
    change = s16(old - rsw(rc2) + a);
  }
  st.local(2, old);
  st.local(4, change);
  st.local(6, 0);
  return s16(old + change);
}

// update_crash_state: crash/finish events. event 1 crash, 2 crash (stops the car),
// 3 finish, 4 (restunts: stops the frame clock), 5 crash that also stops the car.
// mplayer: 0 player, 1 opponent (other values use an uninitialized local, as the original).
export function update_crash_state(event, mplayer) {
  const st = origStack('update_crash_state');
  st.enter(4, cpu.di, cpu.si); // locals: 2 stop flag (byte), 4 car state pointer
  if (mplayer === 0 || mplayer === 1) st.local(4, (mplayer ? state.opponentstate.addr : state.playerstate.addr) - DS);
  const c = new CARSTATE(DS + st.word(st.bp - 4));
  if (c.car_crashBmpFlag !== 0) return;
  let stop = false;
  const impact = () => {
    if (mplayer === 0) {
      state.game_impactSpeed = c.car_speed2;
      state.game_frames_per_sec = G.framespersec << 2;
    }
  };
  const sound = site => {
    if (G.is_in_replay === 0 && G.byte_459D8 !== 0) st.invoke('audio_function2_wrap', site, [mplayer ? G.word_4408C : G.word_43964]);
  };
  if (event === 5) {
    event = 1;
    st.arg(0, 1);
    stop = true;
  }
  if (event === 1) {
    c.car_crashBmpFlag = 1;
    st.invoke('state_op_unk', 0, [mplayer, rw(c.$car_rotate), 0]);
    impact();
    sound(0);
  } else if (event === 2) {
    sound(1);
    c.car_crashBmpFlag = 2;
    stop = true;
    impact();
  } else if (event === 3) {
    c.car_crashBmpFlag = 3;
    if (mplayer === 0) {
      state.game_total_finish = state.game_frame + state.game_penalty + G.elapsed_time1;
      state.game_frames_per_sec = G.framespersec;
    } else state.field_144 = state.game_frame + G.elapsed_time1;
  } else if (event === 4) {
    state.game_frame_in_sec = 1;
    state.game_frames_per_sec = 1;
  }
  st.localByte(2, stop ? 1 : 0);
  if (stop) {
    c.car_speed2 = 0;
    c.car_speed = 0;
  }
  if (mplayer !== 0) state.game_oEndFrame = state.game_frame;
  else state.game_pEndFrame = state.game_frame;
  if (state.game_3F6autoLoadEvalFlag === 0 && mplayer === 0) state.game_3F6autoLoadEvalFlag = event;
  if (!(U.byte_43966 & 4)) {
    st.push(cpu.ds); // push ds; pop es; rep movsw
    M.copyWithin(A.gState_travDist, state.$game_travDist, state.$game_travDist + 22);
  }
}

provide({
  update_car_speed, update_rpm_from_speed, upd_statef20_from_steer_input, update_grip,
  car_car_speed_adjust_maybe, carState_rc_op, update_crash_state,
});
export const PORTS = [
  'update_car_speed', 'update_rpm_from_speed', 'upd_statef20_from_steer_input', 'update_grip',
  'car_car_speed_adjust_maybe', 'carState_rc_op', 'update_crash_state',
];
