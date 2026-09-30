// Differential tests: src/car.js vs the original functions, from realistic race states
// (snapshots of a few scenarios) with car state fields fuzzed around them. The ports run
// through their hook (same entry sp and registers as the original), and the stack below
// is compared too: callers read some of that residue uninitialized (see car.js).
import { M, A, G, DS, ww, wb, rb, rw } from '../src/mem.js';
import { CARSTATE, SIMD, state } from '../src/structs.js';
import { PORTS } from '../src/car.js';
import { enable, disable } from '../src/calls.js';
import { cpu } from '../src/engine.js';
import { oracle, compare, rnd } from './difftest.mjs';
import { bootWorld, gameFile } from './oracle.mjs';
import { SCENARIOS, traceDiff } from './trace.mjs';
import { loadTrack, setupRace, step, gameconfig } from '../src/race.js';

const o = oracle.call;
const CS = CARSTATE.offsets;
const pick = a => a[rnd(0, a.length - 1)];
const w16 = () => rnd(0, 0xffff);

// Car-car collisions (rare in the stock scenarios): straight for 60 frames, then zig-zag into
// the opponent alongside; both end with a hard impact that crashes the two cars.
function setCars(player, opp, oppType) {
  for (let i = 0; i < 4; i++) { gameconfig.game_playercarid[i] = player.charCodeAt(i); gameconfig.game_opponentcarid[i] = opp.charCodeAt(i); }
  gameconfig.game_playertransmission = 1;
  gameconfig.game_opponenttype = oppType;
}
const zigzag = () => { let f = 0; return () => { f++; return 1 | (f > 60 ? (f % 12 < 8 ? 8 : 4) : 0); }; };
export const CAR_SCENARIOS = [['ANSX', 6], ['COUN', 5]].map(([player, opp]) => ({
  name: `car-bump-${player}`, frames: 300,
  setup() { loadTrack(gameFile('DEFAULT.TRK')); setCars(player, 'LM02', opp); this.input = zigzag(); },
}));
SCENARIOS.push(...CAR_SCENARIOS);

// Realistic snapshots: a few scenarios run with the original code.
const snaps = [];
for (const name of ['random-opp3', 'random-manual', 'random-10fps', 'random-opp6']) {
  const sc = SCENARIOS.find(s => s.name === name);
  bootWorld();
  sc.setup();
  setupRace(sc.fps ?? 20);
  for (let f = 0; f < 700; f++) {
    step(sc.input());
    if (f % 35 === 3) snaps.push(M.slice());
  }
}
const restore = () => M.set(pick(snaps));

const PLAYER = state.playerstate.addr, OPP = state.opponentstate.addr;
const cars = [[PLAYER, A.simd_player], [OPP, A.simd_opponent]];
const f16 = (c, name, v) => ww(c + CS[name], v);
const f8 = (c, name, v) => wb(c + CS[name], v);
// Mostly small perturbations, sometimes anything.
const near = (v, spread) => (rnd(0, 9) ? v + rnd(-spread, spread) : w16());

const STACK = [DS + 0xfc00, DS + 0xfff0];
const viaHook = (name, args) => { enable([name]); try { return o(name, ...args); } finally { disable([name]); } };
// Like difftest's fuzz; gen(i) returns [label, word args (near pointers as DS offsets), retMask].
// usage: node tools/test-car.mjs [function-name-filter]
function fuzz(name, n, gen) {
  if (process.argv[2] && !name.includes(process.argv[2])) return true;
  let fails = 0;
  for (let i = 0; i < n; i++) {
    const [label, args, mask = 0xffff] = gen(i);
    [cpu.bp, cpu.si, cpu.di] = [0xfff0 - rnd(0, 0x40) * 2, w16(), w16()]; // caller's registers, pushed by the frame
    let js, orig;
    let r = compare(() => { try { return viaHook(name, args); } finally { js = M.slice(...STACK); } },
      () => { const v = o(name, ...args); orig = M.slice(...STACK); return v; }, mask);
    if (!r) for (let a = 0; a < js.length; a += 2) if (js[a] !== orig[a] || js[a + 1] !== orig[a + 1]) {
      r = `stack ss:${(STACK[0] - DS + a).toString(16)} = ${js[a] | js[a + 1] << 8} vs ${orig[a] | orig[a + 1] << 8}`;
      break;
    }
    if (r && fails++ < 5) console.log(`  FAIL ${name} ${label}: ${r}`);
  }
  console.log(`${fails ? 'FAIL' : 'ok  '} ${name}: ${n - fails}/${n}`);
  return fails === 0;
}

const N = 3000;
let ok = true;

ok &= fuzz('update_rpm_from_speed', N, () => {
  const a = [w16(), w16(), w16(), rnd(0, 3) ? 0 : w16(), rnd(0, 1) ? rnd(500, 1200) : w16()];
  return [a.join(','), a];
});

ok &= fuzz('update_car_speed', N, () => {
  restore();
  const mp = rnd(0, 1), [c, simd] = cars[mp];
  const cs = new CARSTATE(c);
  G.framespersec = pick([20, 20, 10]);
  if (rnd(0, 1)) f8(c, 'car_transmission', rnd(0, 1));
  if (rnd(0, 2) === 0) {
    f8(c, 'car_changing_gear', rnd(0, 1));
    f16(c, 'car_knob_x', near(cs.car_knob_x, 20)); f16(c, 'car_knob_y', near(cs.car_knob_y, 20));
    f16(c, 'car_knob_x2', near(cs.car_knob_x2, 20)); f16(c, 'car_knob_y2', near(cs.car_knob_y2, 20));
  }
  if (rnd(0, 1)) f8(c, 'car_current_gear', rnd(0, rb(simd)));
  if (rnd(0, 1)) f16(c, 'car_currpm', rnd(0, 3) ? rnd(0, 9000) : w16());
  if (rnd(0, 1)) f16(c, 'car_speed', rnd(0, 3) ? rnd(0, 0xffff) : rnd(0xf000, 0xffff));
  if (rnd(0, 1)) f16(c, 'car_speed2', rnd(0, 3) ? cs.car_speed + rnd(-0x2000, 0x2000) : w16());
  if (rnd(0, 1)) f16(c, 'car_pseudoGravity', rnd(0, 2) ? rnd(-300, 300) : w16());
  if (rnd(0, 1)) f8(c, 'car_sumSurfRearWheels', rnd(0, 2));
  if (rnd(0, 1)) f8(c, 'car_sumSurfAllWheels', rnd(0, 4));
  if (rnd(0, 1)) f8(c, 'car_engineLimiterTimer', rnd(0, 30));
  if (rnd(0, 2) === 0) f8(c, 'car_fpsmul2', rnd(0, 30));
  if (rnd(0, 2) === 0) f16(c, 'car_gearratioshr8', rnd(0, 3) ? rnd(0, 255) : w16());
  if (rnd(0, 3) === 0) f16(c, 'car_lastrpm', w16());
  if (rnd(0, 2) === 0) wb(A.oppnentSped, rnd(0, 255));
  const input = rnd(0, 3) ? rnd(0, 0x3f) : w16();
  const mpArg = rnd(0, 5) ? mp : w16() & ~0xff | mp; // only the low byte matters
  const lbl = `in=${input} mp=${mpArg}`;
  return [lbl, [input, mpArg, c - DS, simd - DS], 0];
});

ok &= fuzz('upd_statef20_from_steer_input', N, () => {
  restore();
  G.framespersec = pick([20, 20, 10]);
  if (rnd(0, 1)) state.playerstate.car_steeringAngle = rnd(0, 5) ? rnd(-0x110, 0x110) : w16();
  if (rnd(0, 1)) state.playerstate.car_speed2 = rnd(0, 3) ? rnd(0, 0xf000) : rnd(0, 3) ? 0 : w16();
  const input = rnd(0, 5) ? rnd(0, 3) : rnd(0, 0xff);
  return [`in=${input}`, [input], 0];
});

ok &= fuzz('update_grip', N * 2, () => {
  restore();
  const [c, simd] = cars[rnd(0, 1)];
  const cs = new CARSTATE(c);
  const detailed = rnd(0, 3) ? rnd(0, 1) : w16();
  if (rnd(0, 1)) f8(c, 'car_sumSurfAllWheels', rnd(0, 4));
  if (rnd(0, 1)) for (let i = 0; i < 4; i++) f8(c + i, 'car_surfaceWhl', rnd(0, 4) ? rnd(0, 4) : rnd(0, 5));
  if (rnd(0, 1)) f16(c, 'car_speed', rnd(0, 0xffff));
  if (rnd(0, 1)) f16(c, 'car_speed2', rnd(0, 2) ? cs.car_speed : rnd(0, 0xffff));
  if (rnd(0, 1)) f16(c, 'car_steeringAngle', rnd(0, 5) ? rnd(-0xf0, 0xf0) : w16());
  if (rnd(0, 1)) f16(c, 'car_36MwhlAngle', rnd(0, 5) ? rnd(-0x200, 0x200) : w16());
  if (rnd(0, 1)) f16(c, 'car_angle_z', rnd(0, 2) ? 0 : rnd(0, 5) ? rnd(-0x100, 0x100) : w16());
  if (rnd(0, 1)) f16(c, 'field_42', rnd(0, 2) ? rnd(-0x40, 0x40) : w16());
  if (rnd(0, 1)) f8(c, 'car_slidingFlag', rnd(0, 1));
  if (rnd(0, 2) === 0) f8(c, 'car_crashBmpFlag', rnd(0, 3));
  if (rnd(0, 1)) ww(c + CS.car_rotate, rnd(0, 1) ? rnd(-12, 12) : w16());
  if (rnd(0, 1)) ww(c + CS.car_rotate + 4, rnd(0, 5) ? rnd(-40, 40) : w16());
  if (rnd(0, 1)) {
    // Place the car on a random tile and put a bank/filler element under it.
    const x = rnd(0, 29), z = rnd(0, 29);
    wb(c + CS.car_posWorld1 + 2, x); wb(c + CS.car_posWorld1 + 10, z);
    const map = ((rw(A.td14_elem_map_main + 2) << 4) + rw(A.td14_elem_map_main));
    const at = (x, z) => map + rw(A.terrainrows + z * 2) + x;
    if (x > 0 && z < 29 && rnd(0, 1)) { wb(at(x, z), pick([0xfd, 0xfe, 0xff])); wb(at(x - 1, z + 1), rnd(0x33, 0x38)); wb(at(x, z + 1), rnd(0x33, 0x38)); wb(at(x - 1, z), rnd(0x33, 0x38)); }
    else wb(at(x, z), rnd(0x33, 0x38));
  }
  if (rnd(0, 3) === 0) ww(simd + SIMD.offsets.grip, rnd(0, 3) ? rnd(0, 400) : w16()); // grip
  // Avoid the original's divide by zero (sliding at speed < 256 needs negative grip; grass
  // copies speed2 into speed first).
  if (cs.car_speed < 0x100) f16(c, 'car_speed', cs.car_speed | 0x100);
  if (cs.car_speed2 < 0x200) f16(c, 'car_speed2', cs.car_speed2 | 0x200);
  return [`d=${detailed}`, [c - DS, simd - DS, detailed], 0];
});

ok &= fuzz('car_car_speed_adjust_maybe', N, () => {
  restore();
  for (const [c] of cars) {
    if (rnd(0, 3)) f16(c, 'car_speed2', rnd(0, 0xffff));
    if (rnd(0, 3)) ww(c + CS.car_rotate, rnd(0, 3) ? rnd(0, 0x3ff) : w16());
  }
  const [a, b] = rnd(0, 1) ? [OPP, PLAYER] : [PLAYER, OPP];
  return ['', [a - DS, b - DS]];
});

ok &= fuzz('carState_rc_op', N, () => {
  restore();
  const c = pick(cars)[0], wheel = rnd(0, 3);
  const cs = new CARSTATE(c);
  if (rnd(0, 1)) cs.car_rc2[wheel] = rnd(0, 5) ? rnd(-0x200, 0x200) : w16();
  if (rnd(0, 1)) cs.car_rc5[wheel] = rnd(0, 5) ? rnd(-0x100, 0x100) : w16();
  if (rnd(0, 1)) cs.car_rc4[wheel] = w16();
  const push = rnd(0, 2) === 0 ? 0 : rnd(0, 5) ? rnd(-0x300, 0x300) : w16();
  return [`${push} ${wheel}`, [c - DS, push, wheel]];
});

ok &= fuzz('update_crash_state', N, () => {
  restore();
  const mp = rnd(0, 1), c = cars[mp][0];
  f8(c, 'car_crashBmpFlag', rnd(0, 3) ? 0 : rnd(1, 3));
  G.framespersec = pick([20, 10]);
  if (rnd(0, 2) === 0) state.game_3F6autoLoadEvalFlag = rnd(0, 3);
  if (rnd(0, 2) === 0) wb(A.byte_43966, rnd(0, 255));
  if (rnd(0, 1)) G.elapsed_time1 = w16();
  if (rnd(0, 1)) state.game_penalty = rnd(0, 300);
  if (rnd(0, 3) === 0) wb(A.is_in_replay, 1);
  if (rnd(0, 1)) wb(A.byte_459D8, 1); // sound on
  const ev = rnd(0, 6), mpArg = rnd(0, 20) ? mp : 2; // 2: the original uses an uninitialized pointer
  return [`${ev} ${mpArg}`, [ev, mpArg], 0];
});

// Lockstep traces of the extra scenarios (the stock ones: node tools/trace.mjs '' src/car.js).
if (!process.argv[2]) ok &= traceDiff(PORTS, 'car-bump');
process.exit(ok ? 0 : 1);
