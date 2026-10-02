// Differential tests: src/player.js vs the original. Each function is checked from real states:
// scenarios run as original code, and at (sampled) entries of a function it is called once as the
// JS port and once as the original from the same memory, as is and with perturbed state/args.
// Then extra lockstep scenarios (wrong way, reversing, off-road) run with all ports enabled.
import { M, A, G, DS, rb, rw, rsw, rsd, ww, wd, farptrAt } from '../src/mem.js';
import { compare, rnd, SCRATCH_OFF } from './difftest.mjs';
import { bootWorld, gameFile, cpu, callOrig } from './oracle.mjs';
import { PROCS } from '../src/engine.js';
import { enable, disable } from '../src/calls.js';
import { CARSTATE } from '../src/structs.js';
import { SCENARIOS, traceDiff } from './trace.mjs';
import { PORTS } from '../src/player.js';
import { loadTrack, setupRace, step, state, gameconfig } from '../src/race.js';

const ARGS = { update_player_state: 5, player_op: 1, detect_penalty: 2, sub_18D60: 4 };
const EVERY = { update_player_state: 24, player_op: 24, detect_penalty: 16, sub_18D60: 2 }; // sampling
const MASK = { update_player_state: 0, player_op: 0, detect_penalty: 0xffff, sub_18D60: 0xffff, sub_18D06: 0 };
const viaHook = (name, words) => { enable([name]); try { return callOrig(name, ...words); } finally { disable([name]); } };

// JS vs original from the current memory. Cases where the original hits its div0 handler inside a
// math routine (it resumes mid-instruction; math.js throws instead) are skipped, not failures.
const stats = {};
function check(name, words, label) {
  const s = stats[name] ??= { n: 0, fail: 0, skip: 0 };
  const div0 = rw(A.word_3BE32);
  const r = compare(() => viaHook(name, words), () => callOrig(name, ...words), MASK[name]);
  if (r && /overflow/.test(r) && rw(A.word_3BE32) !== div0) { s.skip++; return; }
  s.n++;
  if (r) { if (s.fail++ < 5) console.log(`  FAIL ${name} ${label}: ${r}`); }
}

const car = a => new CARSTATE(a);
const piece = () => rnd(0, Math.max(0, G.track_pieces_counter - 1));
// Random state changes that reach other paths (walls, landing, crashes, penalties...).
const PERTURB = {
  update_player_state: ([p]) => {
    const c = car(p);
    for (let k = rnd(1, 3); k > 0; k--) {
      switch (rnd(0, 12)) {
        case 0: c.car_speed2 = rnd(0, 2) ? rnd(0, 0x7000) : rnd(0, 12); break;
        case 1: ww(c.$car_rotate + 2 * rnd(0, 2), rnd(0, 1) ? rnd(-40, 40) : rnd(-512, 512)); break;
        case 2: for (let w = 0; w < 4; w++) ww(c.$car_rc1 + 2 * w, rnd(-50, 0x6000)); break;
        case 3: c.car_angle_z = rnd(-300, 300); break;
        case 4: c.car_sumSurfAllWheels = rnd(0, 1) ? 0 : 4; break;
        case 5: wd(c.$car_posWorld1 + 4, rsd(c.$car_posWorld1 + 4) + rnd(-6000, 6000)); break;
        case 6: for (const o of [0, 8]) wd(c.$car_posWorld1 + o, rsd(c.$car_posWorld1 + o) + rnd(-40000, 40000)); break;
        case 7: c.car_36MwhlAngle = rnd(-200, 200); c.car_40MfrontWhlAngle = rnd(-200, 200); break;
        case 8: for (let w = 0; w < 4; w++) ww(c.$car_rc2 + 2 * w, rnd(-200, 200)); break;
        case 9: c.field_C8 = rnd(0, 1); break;
        case 10: gameconfig.game_opponenttype = rnd(0, 1) ? 0 : 1; break;
        case 11: state.game_inputmode = 2; break;
        case 12: { // onto the other car
          const o = car(p === state.$playerstate ? state.$opponentstate : state.$playerstate);
          for (const k of [0, 4, 8]) wd(c.$car_posWorld1 + k, rsd(o.$car_posWorld1 + k) + rnd(-3000, 3000));
          c.field_C8 = 0; gameconfig.game_opponenttype = 1;
          break;
        }
      }
    }
  },
  player_op: () => {
    const c = state.playerstate;
    for (let k = rnd(1, 3); k > 0; k--) {
      switch (rnd(0, 10)) {
        case 0: state.field_2F2 = piece(); break;
        case 1: state.field_2F4 = piece(); break;
        case 2: state.field_45B = rnd(0, 2); state.field_45C = rnd(0, 3); break;
        case 3: c.car_trackdata3_index = rnd(0, 1) ? -1 : piece(); c.field_CE = rnd(0, 6); break;
        case 4: c.car_crashBmpFlag = rnd(0, 1); c.car_speed2 = rnd(0, 1) ? 0 : c.car_speed2; break;
        case 5: for (const o of [0, 8]) wd(c.$car_posWorld1 + o, rsd(c.$car_posWorld1 + o) + rnd(-3000, 3000) * 64); break;
        case 6: c.car_rotate.x = rnd(0, 1023); break;
        case 7: c.field_CD = rnd(0, 1); break;
        case 8: c.field_B6 = rnd(0, 1); break;
        case 9: G.show_penalty_counter = rnd(0, 3); break;
        case 10: { // k pieces further along the path, 45C primed: settles there (penalty if k > 3)
          let from = state.field_2F2, to = from;
          for (let k = rnd(1, 8); k > 0; k--) { from = to; to = rsw(farptrAt(A.td01_track_file_cpy, 2 * to)); }
          if (to < 0) break;
          wd(c.$car_posWorld1, (rb(farptrAt(A.td21_col_from_path, to)) << 16) + 0x8000);
          wd(c.$car_posWorld1 + 8, ((29 - rb(farptrAt(A.td22_row_from_path, to))) << 16) + 0x8000);
          state.field_2F4 = from; state.field_45B = 0; state.field_45C = rnd(0, 2);
          break;
        }
      }
    }
  },
  detect_penalty: () => {
    const c = state.playerstate;
    if (rnd(0, 1)) { ww(c.$car_posWorld1 + 2, rnd(-1, 30)); ww(c.$car_posWorld1 + 10, rnd(-1, 30)); }
    if (rnd(0, 3) === 0) { state.game_startcol = rnd(0, 29); state.game_startrow = rnd(0, 29); }
  },
};
// Random args instead of the real ones.
const RANDARGS = {
  detect_penalty: () => { ww(DS + SCRATCH_OFF, piece()); return [SCRATCH_OFF, SCRATCH_OFF + 2]; },
  sub_18D60: () => [piece(), SCRATCH_OFF, rnd(0, 1) ? rnd(0, 8) : rnd(0, 255), rnd(0, 1) ? SCRATCH_OFF + 0x20 : 0],
};

// Runs a scenario as original code; at sampled entries of the named functions, checks them.
function runChecks(sc, frames, perturbed) {
  let busy = false;
  const hooks = Object.keys(ARGS).map(name => {
    const addr = PROCS[name];
    let calls = 0;
    const h = c => {
      cpu.hooks.delete(addr);
      if (!busy && calls++ % EVERY[name] === 0) {
        busy = true;
        const words = [...Array(ARGS[name])].map((_, i) => rw(DS + ((c.sp + 4 + 2 * i) & 0xffff)));
        const snap = M.slice();
        check(name, words, `${sc.name} call ${calls}`);
        for (let k = 0; k < perturbed; k++) {
          M.set(snap);
          if (RANDARGS[name] && rnd(0, 1)) check(name, RANDARGS[name](), `${sc.name} call ${calls} random args`);
          else if (PERTURB[name]) { PERTURB[name](words.map(w => DS + w)); check(name, words, `${sc.name} call ${calls} perturbed ${k}`); }
        }
        M.set(snap);
        busy = false;
      }
      c.step();
      cpu.hooks.set(addr, h);
    };
    cpu.hooks.set(addr, h);
    return addr;
  });
  bootWorld();
  const rec = sc.setup();
  setupRace(sc.fps);
  for (let f = 0; f < (frames ?? sc.frames ?? rec); f++) step(sc.input ? sc.input() : undefined);
  for (const a of hooks) cpu.hooks.delete(a);
}

// Scripted drivers for the path tracking / penalty code.
const script = parts => { let f = 0; return () => { let t = f++; for (const [n, b] of parts) { if (t < n) return b; t -= n; } return parts.at(-1)[1]; }; };
const setCars = (p, o, oppType) => {
  for (let i = 0; i < 4; i++) { gameconfig.game_playercarid[i] = p.charCodeAt(i); gameconfig.game_opponentcarid[i] = o.charCodeAt(i); }
  gameconfig.game_playertransmission = 1;
  gameconfig.game_opponenttype = oppType;
};
const trk = () => loadTrack(gameFile('DEFAULT.TRK'));
const EXTRA = [
  { name: 'player-uturn', frames: 900, setup: () => { trk(); setCars('COUN', 'PMIN', 0); }, input: script([[30, 1], [28, 5], [400, 1], [20, 9], [500, 1]]) },
  { name: 'player-reverse', frames: 700, setup: () => { trk(); setCars('LANC', 'AUDI', 2); }, input: script([[10, 0], [300, 2], [40, 6], [400, 1]]) },
  { name: 'player-circles', frames: 900, setup: () => { trk(); setCars('P962', 'JAGU', 0); }, input: script([[60, 1], [300, 5], [200, 9], [400, 1]]) },
  { name: 'player-offroad', frames: 900, setup: () => { trk(); setCars('FGTO', 'COUN', 3); }, input: script([[25, 1], [12, 9], [200, 1], [30, 5], [250, 1], [15, 9], [400, 1]]) },
];
SCENARIOS.push(...EXTRA);

let ok = true;
const t0 = Date.now();
for (const sc of SCENARIOS) runChecks(sc, Math.min(sc.frames ?? 1800, 600), 4);
for (const [name, s] of Object.entries(stats)) {
  console.log(`${s.fail ? 'FAIL' : 'ok  '} ${name}: ${s.n - s.fail}/${s.n}` + (s.skip ? ` (${s.skip} skipped: original div0 in math)` : ''));
  ok &&= !s.fail;
}

// sub_18D06 (replay sound update): random records.
{
  let fails = 0;
  bootWorld();
  for (let i = 0; i < 300; i++) {
    const p = 0x97dc + 0x22 * rnd(0, 39);
    for (let k = 0; k < 0x22; k += 2) ww(DS + p + k, rnd(-3000, 3000));
    gameconfig.game_opponenttype = rnd(0, 1);
    const t = rnd(1, 30);
    const r = compare(() => viaHook('sub_18D06', [p, t]), () => callOrig('sub_18D06', p, t), 0);
    if (r && fails++ < 5) console.log('  FAIL sub_18D06', r);
  }
  console.log(`${fails ? 'FAIL' : 'ok  '} sub_18D06: ${300 - fails}/300`);
  ok &&= !fails;
}
console.log(`entry checks ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// Lockstep traces of the extra scenarios with all ports.
ok &&= traceDiff(PORTS, 'player-');
process.exit(ok ? 0 : 1);
