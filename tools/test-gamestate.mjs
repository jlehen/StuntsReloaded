// Differential tests: src/gamestate.js vs the original, from realistic race states, plus lockstep
// integration runs (replay seeking with restore_gamestate, live recording with replay_unk2).
import { M, A, G, U, DS, rw, rsw, ww } from '../src/mem.js';
import { MS } from '../src/version.js';
import { GAMESTATE, CARSTATE } from '../src/structs.js';
import { loadResfile } from '../src/files.js';
import { enable, disable } from '../src/calls.js';
import { oracle, fuzz, compare, diffMemory, rnd, SCRATCH_OFF as SC } from './difftest.mjs';
import { bootWorld, gameFile, hook, unhook } from './oracle.mjs';
import { SCENARIOS } from './trace.mjs';
import { loadReplay, setupRace, step, state, gameconfig } from '../src/race.js';
import * as g from '../src/gamestate.js';

const o = oracle.call;
const S = A.state, O = GAMESTATE.offsets, C = CARSTATE.offsets;
const PL = S + O.playerstate, OP = S + O.opponentstate;
const pick = a => a[rnd(0, a.length - 1)];
// Runs a JS port the way original code reaches it (hooked), so its callees see the original's stack.
const viaHook = (name, ...args) => { enable([name]); try { return o(name, ...args); } finally { disable([name]); } };
let ok = true;

// --- Realistic states: snapshots along several scenarios (every 60 frames, and while debris flies).
const snaps = [];
for (const name of ['default-replay', 'random-opp5', 'random-opp1', 'random-manual', 'random-10fps'].filter(n => SCENARIOS.some(s => s.name === n))) {
  const sc = SCENARIOS.find(s => s.name === name);
  bootWorld();
  const rec = sc.setup();
  setupRace(sc.fps);
  snaps.push(M.slice());
  const frames = Math.min(sc.frames ?? rec, name === 'random-10fps' ? 800 : 1300);
  for (let f = 0; f < frames; f++) {
    step(sc.input ? sc.input() : undefined);
    if (f % 60 === 59 || (state.field_42A && f % 4 === 0)) snaps.push(M.slice());
  }
}
console.log(`${snaps.length} snapshots`);
const load = () => { const s = pick(snaps); M.set(s); return s; };

// --- RNG.
ok &= fuzz('get_kevinrandom', 3000, i => {
  load();
  for (let k = 0; k < 6; k++) M[A.g_kevinrandom_seed + k] = rnd(0, 3) ? rnd(0, 255) : 255 * (i & 1);
  return ['', () => g.get_kevinrandom(), () => o('get_kevinrandom')];
});
ok &= fuzz('init_kevinrandom', 200, () => {
  for (let k = 0; k < 6; k++) M[DS + SC + k] = rnd(0, 255);
  return ['', () => g.init_kevinrandom(DS + SC), () => o('init_kevinrandom', SC), 0];
});
ok &= fuzz('get_kevinrandom_seed', 200, () => {
  load();
  for (let k = 0; k < 6; k++) M[A.g_kevinrandom_seed + k] = rnd(0, 255);
  return ['', () => g.get_kevinrandom_seed(S + O.kevinseed), () => o('get_kevinrandom_seed', S + O.kevinseed - DS), 0];
});

// --- Init.
ok &= fuzz('init_carstate_from_simd', 1000, () => {
  load();
  const [p, simd] = pick([[PL, A.simd_player], [OP, A.simd_opponent]]);
  const x = rnd(-0x800000, 0x800000), y = rnd(-0x100000, 0x100000), z = rnd(-0x800000, 0x800000), t = rnd(0, 255), ang = rnd(0, 0xffff);
  const w32 = v => [v & 0xffff, (v >>> 16) & 0xffff];
  return [`${x},${y},${z}`, () => g.init_carstate_from_simd(p, simd, t, x, y, z, ang),
    () => o('init_carstate_from_simd', p - DS, simd - DS, t, ...w32(x), ...w32(y), ...w32(z), ang), 0];
});
{
  load();
  const cars = ['ANSX', 'AUDI', 'COUN', 'FGTO', 'JAGU', 'LANC', 'LM02', 'P962', 'PC04', 'PMIN', 'VETT'].map(id => loadResfile('car' + id));
  ok &= fuzz('setup_aero_trackdata', 44, i => {
    const r = cars[i >> 2], opp = i & 1 ? (i & 2 ? 0x100 : 1) : 0;
    return [`${i >> 2},${opp}`, () => g.setup_aero_trackdata(r, opp), () => o('setup_aero_trackdata', r & 15, r >> 4, opp), 0];
  });
}
ok &= fuzz('init_game_state', 300, () => {
  load();
  if (rnd(0, 2) === 0) { G.track_angle = rnd(0, 3) * 0x100; G.hillFlag = rnd(0, 1); }
  if (!MS && rnd(0, 3) === 0) G.framespersec = pick([10, 20]);
  if (rnd(0, 3) === 0) gameconfig.game_playertransmission = rnd(0, 1);
  const arg = pick([0xffff, 0, 0xfffe, 0xfffd]);
  return [arg, () => g.init_game_state(arg), () => o('init_game_state', arg), 0];
});

// --- Snapshots.
ok &= fuzz('restore_gamestate', 600, () => {
  load();
  const f = rw(S + O.game_frame);
  if (rnd(0, 3) === 0) G.elapsed_time1 = rnd(0, 1) * rnd(1, 600);
  const t = pick([0, rnd(0, f), rnd(0, f + 1300), f, rnd(0, 20) * (MS ? 600 : U.word_45A00), rnd(0, 0x3000)]);
  return [`${t} from ${f}`, () => g.restore_gamestate(t), () => o('restore_gamestate', t), 0];
});

// --- Per-frame update, including the paused drive-in branch and the end-of-race countdown.
ok &= fuzz('update_gamestate', 800, i => {
  load();
  const mode = i % 4;
  if (mode === 1) {
    M[S + O.game_inputmode] = 0; G.game_replay_mode = pick([0, 1, 1, 2]);
    G.byte_4393C = rnd(0, 3); G.word_44DCA = pick([rnd(0, 0x1d0), rnd(-100, 0x200)]);
    if (rnd(0, 1)) ww(PL + C.car_speed, pick([0, rnd(0, 0x600)]));
  } else if (mode === 2) {
    M[S + O.game_3F6autoLoadEvalFlag] = rnd(0, 2);
    const fps = rnd(1, 30);
    ww(S + O.game_frames_per_sec, fps); ww(S + O.game_frame_in_sec, fps - rnd(0, 2));
    G.byte_449DA = rnd(0, 1) * rnd(0, 1); G.game_replay_mode = pick([0, 0, 2]);
    M[PL + C.car_crashBmpFlag] = rnd(0, 2); ww(PL + C.car_speed2, rnd(0, 1) * rnd(0, 3000));
  } else if (mode === 3) {
    ww(S + O.game_frame, rnd(0, 18) * (MS ? 600 : U.word_45A00));
  }
  return [`mode ${mode}`, () => viaHook('update_gamestate'), () => o('update_gamestate'), 0];
});

ok &= fuzz('sub_2298C', 1500, () => {
  load();
  const car = pick([PL, OP]);
  if (rnd(0, 2) === 0) ww(car + C.field_48, rnd(0, 0x400));
  if (rnd(0, 5) === 0) ww(car + C.field_B6, rnd(0, 1));
  if (rnd(0, 5) === 0) M[car + C.car_crashBmpFlag] = rnd(0, 3);
  if (rnd(0, 5) === 0) ww(car + C.car_trackdata3_index, 0xffff);
  if (rnd(0, 5) === 0) { M[S + O.field_45B] = rnd(0, 1); M[S + O.field_45C] = rnd(0, 1); }
  if (rnd(0, 2) === 0) for (let k = 0; k < 3; k++) ww(S + O.game_vec1 + rnd(0, 1) * 6 + k * 2, rsw(S + O.game_vec1 + k * 2) + rnd(-3000, 3000));
  if (rnd(0, 1)) ww(S + O.game_frame, rnd(0, 200) * 10);
  return ['', () => g.sub_2298C(), () => o('sub_2298C'), 0];
});

// Debris: spawn with the original, let it fly a few frames, then compare one physics step.
ok &= fuzz('sub_19BA0', 800, () => {
  load();
  if (rnd(0, 1)) o('state_op_unk', rnd(0, 3), rnd(0, 0x3ff), rnd(0, 1) * rnd(0, 2000));
  for (let k = rnd(0, 40); k > 0 && M[S + O.field_42A]; k--) o('sub_19BA0');
  if (!MS && rnd(0, 3) === 0) G.framespersec = pick([10, 20]);
  return ['', () => g.sub_19BA0(), () => o('sub_19BA0'), 0];
});
ok &= fuzz('state_op_unk', 1000, () => {
  load();
  for (let i = 0; i < 24; i++) if (rnd(0, 3) === 0) ww(S + O.field_38E + i * 2, rnd(0, 1) * rnd(1, 0x800));
  const t = pick([0, 1, 2, 3, 4, 5, rnd(0, 0xffff)]), a = rnd(0, 0xffff), sp = pick([0, rnd(0, 3000), rnd(0, 0xffff)]);
  return [`${t},${a},${sp}`, () => g.state_op_unk(t, a, sp), () => o('state_op_unk', t, a, sp), 0];
});

// Recorder: the original's hardware reads are hooked to return the same input byte.
let hwInput = 0;
hook('get_kb_or_joy_flags', () => hwInput);
hook('kb_get_key_state', () => 0);
ok &= fuzz('replay_unk2', 2000, i => {
  load();
  hwInput = rnd(0, 0x3f);
  if (rnd(0, 1)) G.game_replay_mode = pick([0, 0, 1, 2]);
  if (rnd(0, 2) === 0) G.byte_449DA = 1;
  if (rnd(0, 2) === 0) M[S + O.game_3F6autoLoadEvalFlag] = 1;
  G.passed_security = rnd(0, 1); G.byte_4393C = rnd(0, 3) === 0 ? 1 : 0;
  if (!MS && rnd(0, 3) === 0) G.framespersec = pick([10, 20]);
  const e2 = pick([rnd(0, 0x2ee0), 0x2ee0, 0x2ee0, 0x2edf, U.elapsed_time2]);
  G.elapsed_time2 = e2;
  G.elapsed_time1 = pick([0, 0, rnd(0, 20000), 30000 - e2 - rnd(0, 1)]);
  gameconfig.game_recordedframes = pick([e2, e2 + rnd(0, 5), rnd(0, 0x2ee0)]);
  M[A.word_45D3E] = rnd(0, 1);
  const arg = i % 5 === 0 ? 1 : 0;
  return [`${arg} e2=${e2}`, () => g.replay_unk2(arg, hwInput), () => o('replay_unk2', arg), 0];
});

// --- Integration: lockstep ops with every port enabled vs the original (memory compared after each).
const PORTS = Object.keys(g).filter(k => typeof g[k] === 'function');
let fails = 0;
function lockstep(label, jsFn, oFn = jsFn) {
  const snap = M.slice();
  enable(PORTS);
  let err = null;
  try { jsFn(); } catch (e) { err = e; }
  disable(PORTS);
  const js = M.slice();
  M.set(snap);
  oFn();
  const d = diffMemory(js, M, 8);
  if (!err && !d.length) return true;
  if (fails++ < 5) console.log(`  FAIL ${label}: ` + (err ? err.stack.split('\n').slice(0, 3).join(' | ') : d.map(a => `${(a - DS).toString(16)}=${js[a]}/${M[a]}`).join(' ')));
  return false;
}
// Replay playback and seeking, as run_game and the replay bar do it.
{
  bootWorld();
  const rec = loadReplay(gameFile('DEFAULT.RPL'));
  let good = lockstep('setup', () => setupRace());
  G.game_replay_mode = 2;
  const seek = t => {
    good &= lockstep(`restore ${t}`, () => o('restore_gamestate', t));
    G.elapsed_time2 = t;
    for (let n = 0; rw(S + O.game_frame) !== t && n < 3000; n++) good &= lockstep(`update to ${t}`, () => o('update_gamestate'));
    if (rw(S + O.game_frame) !== t) { console.log(`  seek ${t}: stuck at ${rw(S + O.game_frame)}`); good = false; }
  };
  good &= lockstep('restore 0', () => o('restore_gamestate', 0));
  seek(rec);
  for (const t of [100, 1500, 700, 0, rec, 1234, 601, 600, 599, 1200, 30, rec - 1]) seek(t);
  console.log(`${good ? 'ok  ' : 'FAIL'} replay seek (${rec} frames)`);
  ok &= good;
}
// Live recording at 20 and 10 fps: timer tick = replay_unk2(0), then catch up with update_gamestate.
for (const fps of [20, 10]) {
  bootWorld();
  const sc = SCENARIOS.find(s => s.name === 'random-opp1');
  sc.setup();
  let good = lockstep('setup', () => setupRace(fps));
  G.passed_security = fps === 20 ? 1 : 0; // 0: copy protection crashes the car after 4 s
  for (let tick = 0; tick < 700 && !U.byte_449DA; tick++) {
    hwInput = sc.input();
    good &= lockstep(`tick ${tick}`, () => g.replay_unk2(0, hwInput), () => o('replay_unk2', 0));
    while (rw(S + O.game_frame) !== U.elapsed_time2) good &= lockstep(`frame ${rw(S + O.game_frame)}`, () => o('update_gamestate'));
  }
  console.log(`${good ? 'ok  ' : 'FAIL'} recording ${fps} fps: ${gameconfig.game_recordedframes} frames, crash ${state.playerstate.car_crashBmpFlag}`);
  ok &= good;
}
unhook('get_kb_or_joy_flags'); unhook('kb_get_key_state');
process.exit(ok ? 0 : 1);
