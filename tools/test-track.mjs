// Differential tests: src/track.js vs the original track_setup, load_opponent_data, init_plantrak,
// opponent_op / do_opponent_op. Tracks: DEFAULT.TRK plus generated ones (valid loops with corners,
// big corners, hills, bridges, jumps, split roads; broken variants; random garbage) so that every
// track_setup error path runs. usage: node tools/test-track.mjs [trace]
import { M, A, G, rw, ww, farptr, heapMark, heapReset } from '../src/mem.js';
import { MS } from '../src/version.js';
import { oracle, compare, rnd } from './difftest.mjs';
import { gameFile, bootWorld } from './oracle.mjs';
import { loadTrack, setupRace, step, gameconfig, state } from '../src/race.js';
import * as T from '../src/track.js';
import { SCENARIOS, traceDiff } from './trace.mjs';

let ok = true;
const report = (name, n, fails) => { console.log(`${fails ? 'FAIL' : 'ok  '} ${name}: ${n - fails}/${n}`); ok &&= !fails; };
// compare() with the far heap rewound for the original (both runs allocate the same blocks).
const cmp = (jsFn, origFn, mask) => { const h = heapMark(); return compare(jsFn, () => { heapReset(h); return origFn(); }, mask); };

// --- Track building. Grids are [row][col]; row 0 is the north edge.
const N = 0, E = 1, S = 2, W = 3, DC = [0, 1, 0, -1], DR = [-1, 0, 1, 0];
const pick = a => a[rnd(0, a.length - 1)];
const rep = (f, n) => Array.from({ length: n }, f);
const grid = () => rep(() => new Array(30).fill(0), 30);
const VSTRAIGHT = [4, 0xe, 0x18], HSTRAIGHT = [5, 0xf, 0x19];
const START = [[1, 0x86, 0x93], [0x88, 0x95, 0xb4], [0x87, 0x94, 0xb3], [0x89, 0x96, 0xb5]]; // by heading
const STARTS = START.flat();
const corner = (a, b) => { // small corner joining sides a, b
  const k = (1 << a) | (1 << b);
  const base = { [(1 << S) | (1 << E)]: 6, [(1 << S) | (1 << W)]: 7, [(1 << N) | (1 << E)]: 8, [(1 << N) | (1 << W)]: 9 }[k];
  return pick([base, base + 10, base + 20]);
};
function writeTrack({ el, te }) {
  const e = farptr(A.td14_elem_map_main), t = farptr(A.td15_terr_map_main);
  for (let r = 0; r < 30; r++) for (let c = 0; c < 30; c++) {
    M[e + rw(A.trackrows + r * 2) + c] = el[r][c];
    M[t + rw(A.terrainrows + r * 2) + c] = te[r][c];
  }
}
// Closed (or open-ended) path of cells [col, row] -> straights, corners, a start on cell 0, and
// crossings where a cell is visited twice.
function pathTrack(cells, closed = true) {
  const el = grid(), te = grid(), n = cells.length, seen = new Set();
  const side = (a, b) => b[1] < a[1] ? N : b[1] > a[1] ? S : b[0] > a[0] ? E : W;
  cells.forEach((c, i) => {
    const prev = i ? cells[i - 1] : closed ? cells[n - 1] : null, next = i < n - 1 ? cells[i + 1] : closed ? cells[0] : null;
    const inn = prev ? side(c, prev) : (side(c, next) + 2) % 4, out = next ? side(c, next) : (inn + 2) % 4;
    let e = (inn + 2) % 4 === out ? (i === 0 ? pick(START[out]) : pick(out % 2 ? HSTRAIGHT : VSTRAIGHT)) : corner(inn, out);
    const k = c + '';
    if (seen.has(k)) e = pick([0x4a, 0x7d, 0x8a]);
    seen.add(k);
    el[c[1]][c[0]] = e;
  });
  return { el, te };
}

// Straight-road segments along an edge, in axis order (top to bottom / left to right).
const RAMPV = [[0x27, 0x3b, 0x62], [0x26, 0x3a, 0x61]], RAMPH = [[0x24, 0x38, 0x5f], [0x25, 0x39, 0x60]];
const VSEG = [
  () => [0x42], () => [pick([0x40, 0x55]), 0xfe], () => [pick([0x4a, 0x7d, 0x8a, 0x66])],
  () => [pick(RAMPV[0]), ...rep(() => pick([0x22, 0x63, 0x67]), rnd(0, 3)), pick(RAMPV[1])], // bridge
  () => [pick(RAMPV[0]), ...rep(() => 0, rnd(1, 3)), pick(RAMPV[1])], // jump
  () => [pick(RAMPV[0]), 0x65, pick(RAMPV[1])],
  () => [0x47, ...rep(() => pick([0x44, 0x53]), rnd(0, 3)), 0x46], () => [0x71, ...rep(() => 0x6d, rnd(0, 3)), 0x6f],
  () => [0x2a, ...rep(() => 0x31, rnd(0, 3)), 0x2c], () => [0x2e, ...rep(() => 0x30, rnd(0, 3)), 0x28],
];
const HSEG = [
  () => [0x43], () => [pick([0x41, 0x56]), 0xff], () => [pick([0x4a, 0x7d, 0x8a, 0x65])],
  () => [pick(RAMPH[0]), ...rep(() => pick([0x23, 0x64, 0x68]), rnd(0, 3)), pick(RAMPH[1])],
  () => [pick(RAMPH[0]), ...rep(() => 0, rnd(1, 3)), pick(RAMPH[1])],
  () => [pick(RAMPH[0]), 0x66, pick(RAMPH[1])],
  () => [0x49, ...rep(() => pick([0x45, 0x54]), rnd(0, 3)), 0x48], () => [0x70, ...rep(() => 0x6e, rnd(0, 3)), 0x72],
  () => [0x29, ...rep(() => 0x32, rnd(0, 3)), 0x2f], () => [0x2d, ...rep(() => 0x33, rnd(0, 3)), 0x2b],
];
// Split-road pieces [fork/merge at the lower-index end, at the higher-index end] per edge side, and lane corners.
const SPLIT = { [W]: [[0x51, 0x84, 0x91], [0x4b, 0x7e, 0x8b]], [E]: [[0x4d, 0x80, 0x8d], [0x4f, 0x82, 0x8f]],
  [N]: [[0x4e, 0x81, 0x8e], [0x50, 0x83, 0x90]], [S]: [[0x52, 0x85, 0x92], [0x4c, 0x7f, 0x8c]] };
const LANE = { [W]: [[S, E], [N, E]], [E]: [[S, W], [N, W]], [N]: [[S, E], [S, W]], [S]: [[N, E], [N, W]] };

// Rectangular loop: small or 2x2 corners, segments on the edges, optional hill band, split road, scenery.
function rectTrack(o = {}) {
  const el = grid(), te = grid();
  const w = rnd(4, 26), h = rnd(4, 26), c0 = rnd(1, 28 - w), r0 = rnd(1, 28 - h), c1 = c0 + w, r1 = r0 + h;
  const big = rep(() => rnd(0, 2) === 0, 4), sz = big.map(b => b ? 2 : 1); // TL TR BR BL
  const put2x2 = (c, r, e) => { el[r][c] = e; el[r][c + 1] = 0xff; el[r + 1][c] = 0xfe; el[r + 1][c + 1] = 0xfd; };
  if (big[0]) put2x2(c0, r0, pick([0xa, 0x14, 0x1e])); else el[r0][c0] = corner(S, E);
  if (big[1]) put2x2(c1 - 1, r0, pick([0xb, 0x15, 0x1f])); else el[r0][c1] = corner(S, W);
  if (big[2]) put2x2(c1 - 1, r1 - 1, pick([0xd, 0x17, 0x21])); else el[r1][c1] = corner(N, W);
  if (big[3]) put2x2(c0, r1 - 1, pick([0xc, 0x16, 0x20])); else el[r1][c0] = corner(N, E);
  const range = (a, b) => rep((_, i) => a + i, Math.max(0, b - a + 1));
  const edges = [
    { cells: range(c0 + sz[0], c1 - sz[1]).map(c => [c, r0]), vert: false, out: N },
    { cells: range(r0 + sz[1], r1 - sz[2]).map(r => [c1, r]), vert: true, out: E },
    { cells: range(c0 + sz[3], c1 - sz[2]).map(c => [c, r1]), vert: false, out: S },
    { cells: range(r0 + sz[0], r1 - sz[3]).map(r => [c0, r]), vert: true, out: W },
  ];
  // Hill band across the map: rows (crossed by the vertical edges) or columns.
  const slope = (c, r) => [7, 8, 9, 10].includes(te[r][c]);
  if (o.hill ?? rnd(0, 2) === 0) {
    if (rnd(0, 1)) {
      const lo = r0 + Math.max(sz[0], sz[1]), hi = r1 - Math.max(sz[2], sz[3]);
      if (hi - lo >= 1) {
        const a = rnd(lo, hi - 1), b = rnd(a + 1, hi);
        for (let c = 0; c < 30; c++) { te[a][c] = 9; te[b][c] = 7; for (let r = a + 1; r < b; r++) te[r][c] = 6; }
      }
    } else {
      const lo = c0 + Math.max(sz[0], sz[3]), hi = c1 - Math.max(sz[1], sz[2]);
      if (hi - lo >= 1) {
        const a = rnd(lo, hi - 1), b = rnd(a + 1, hi);
        for (let r = 0; r < 30; r++) { te[r][a] = 10; te[r][b] = 8; for (let c = a + 1; c < b; c++) te[r][c] = 6; }
      }
    }
  }
  for (const ed of edges) {
    const cells = ed.cells;
    for (let i = 0; i < cells.length;) {
      let run = 0;
      while (i + run < cells.length && !slope(...cells[i + run])) run++;
      let seg = [pick(ed.vert ? VSTRAIGHT : HSTRAIGHT)];
      if (run && rnd(0, 1)) { const s = pick(ed.vert ? VSEG : HSEG)(); if (s.length <= run) seg = s; }
      seg.forEach((e, k) => { const [c, r] = cells[i + k]; el[r][c] = e; });
      i += seg.length;
    }
  }
  const plain = ([c, r], ed) => (ed.vert ? VSTRAIGHT : HSTRAIGHT).includes(el[r][c]) && !slope(c, r);
  const candidates = edges.flatMap(ed => ed.cells.filter(c => plain(c, ed)).map(c => [c, ed]));
  if (candidates.length) {
    const [[c, r], ed] = pick(candidates);
    el[r][c] = pick(START[ed.vert ? pick([N, S]) : pick([E, W])]);
  }
  // Split road: fork and merge on an edge, lane outside it (same piece at both ends: wrong way).
  if (o.split ?? rnd(0, 1)) {
    const ed = pick(edges), idx = ed.cells.map((c, i) => plain(c, ed) ? i : -1).filter(i => i >= 0);
    if (idx.length >= 2) {
      let a = pick(idx), b = pick(idx);
      if (a > b) [a, b] = [b, a];
      if (a !== b) {
        const [fa, fb] = SPLIT[ed.out], bad = rnd(0, 7) === 0;
        const at = i => ed.cells[i], lane = i => [at(i)[0] + DC[ed.out], at(i)[1] + DR[ed.out]];
        el[at(a)[1]][at(a)[0]] = pick(bad ? fb : fa);
        el[at(b)[1]][at(b)[0]] = pick(fb);
        for (let i = a; i <= b; i++) {
          const [c, r] = lane(i);
          el[r][c] = i === a ? corner(...LANE[ed.out][0]) : i === b ? corner(...LANE[ed.out][1]) : pick(ed.vert ? VSTRAIGHT : HSTRAIGHT);
        }
      }
    }
  }
  // Scenery: loose pieces (ids >= 0xB6 are reset to 4 by track_setup) and flat terrain kinds.
  for (let k = rnd(0, 6); k--;) { const c = rnd(0, 29), r = rnd(0, 29); if (!el[r][c] && !slope(c, r)) el[r][c] = pick([rnd(0x22, 0x85), rnd(0xb6, 0xfc)]); }
  for (let k = rnd(0, 20); k--;) { const c = rnd(0, 29), r = rnd(0, 29); if (!slope(c, r) && te[r][c] !== 6) te[r][c] = rnd(0, 5); }
  return { el, te };
}

// Breaks a track in one random way.
function mutate({ el, te }) {
  const road = [];
  for (let r = 0; r < 30; r++) for (let c = 0; c < 30; c++) if (el[r][c]) road.push([c, r]);
  const [c, r] = road.length ? pick(road) : [rnd(1, 29), rnd(1, 29)];
  const interior = c > 0 && r > 0; // fillers on the first row/column would read outside the map
  switch (rnd(0, 6)) {
    case 0: el[r][c] = 0; break;
    case 1: { const e = rnd(0, 255); if (e < 0xfd || interior) el[r][c] = e; break; }
    case 2: el[rnd(0, 29)][rnd(0, 29)] = pick(STARTS); break;
    case 3: for (const row of el) row.forEach((e, i) => { if (STARTS.includes(e)) row[i] = 4; }); break;
    case 4: te[rnd(0, 29)][rnd(0, 29)] = rnd(0, 18); break;
    case 5: if (interior) el[r][c] = pick([0xfd, 0xfe, 0xff]); break;
    default: for (const row of el) row.forEach((e, i) => { const k = STARTS.indexOf(e); if (k >= 0) row[i] = STARTS[(k + 3 + 3 * rnd(0, 2)) % 12]; }); // turn the start
  }
  return { el, te };
}

function garbageTrack() {
  const el = grid(), te = grid();
  const flat = rnd(0, 3) > 0;
  for (let r = 0; r < 30; r++) for (let c = 0; c < 30; c++) {
    if (rnd(0, 9) < 5) el[r][c] = rnd(0, 20) ? rnd(1, 0xfc) : (c && r ? rnd(0xfd, 0xff) : 0);
    if (STARTS.includes(el[r][c])) el[r][c] = 0;
    if (!flat && rnd(0, 20) === 0) te[r][c] = rnd(0, 18);
  }
  for (let k = pick([0, 1, 1, 1, 1, 2]); k--;) el[rnd(0, 29)][rnd(0, 29)] = pick(STARTS);
  return { el, te };
}

// Special cases: 900-piece serpentine (camera index wrap), crossings until 901 pieces, 65 forks,
// jumps, a filler entered sideways, the wrong way through split roads.
function serpentine() {
  const cells = [];
  for (let c = 0; c < 30; c++) cells.push([c, 0]);
  for (let r = 1; r < 30; r++) for (let k = 0; k < 29; k++) cells.push([r % 2 ? 29 - k : 1 + k, r]);
  for (let r = 29; r > 0; r--) cells.push([0, r]);
  const s = rnd(1, 28);
  return pathTrack([...cells.slice(s), ...cells.slice(0, s)]);
}
function crossings() {
  const cells = [[0, 1]];
  for (let r = 1; r <= 28; r++) for (let k = 0; k < 28; k++) cells.push([r % 2 ? 1 + k : 28 - k, r]);
  cells.push([1, 29]);
  for (let c = 2; c <= 27; c++) for (let k = 0; k < 30; k++) cells.push([c, c % 2 ? k : 29 - k]);
  return pathTrack(cells, false);
}
function forks(n) {
  const t = serpentine(), FORK = [[0x4b], [0x4e, 0x52], [0x51, 0x4d], [0x4c, 0x50]]; // by heading
  const heading = { 4: [N, S], 0xe: [N, S], 0x18: [N, S], 5: [E, W], 0xf: [E, W], 0x19: [E, W] };
  let k = 0;
  for (let r = 0; r < 30 && k < n; r++) for (let c = 1; c < 29 && k < n; c++) {
    const hd = heading[t.el[r][c]];
    if (hd) { t.el[r][c] = pick(FORK[r === 0 ? E : r % 2 ? W : E]); k++; } // rows alternate direction
  }
  return t;
}
// Loop with a jump on the top edge, heading east: `run` straights after the corner, a ramp,
// `gap` empty tiles, a ramp down.
function jump(gap, run) {
  const cells = [];
  for (let r = 25; r >= 5; r--) cells.push([5, r]);
  for (let c = 6; c <= 20; c++) cells.push([c, 5]);
  for (let r = 6; r <= 26; r++) cells.push([20, r]);
  for (let c = 19; c >= 5; c--) cells.push([c, 26]);
  const t = pathTrack(cells), c = 6 + run;
  t.el[5][c] = pick(RAMPH[0]);
  for (let g = 1; g <= gap; g++) t.el[5][c + g] = 0;
  t.el[5][c + gap + 1] = pick(RAMPH[1]);
  return t;
}

// --- track_setup
const codes = {};
let n = 0, fails = 0;
function testSetup(label, t) {
  if (t) writeTrack(t);
  const snap = M.slice(), h = heapMark();
  let code;
  const r = compare(() => T.track_setup(), () => { heapReset(h); return code = oracle.call('track_setup') << 16 >> 16; });
  M.set(snap); heapReset(h);
  n++;
  if (r) { if (fails++ < 8) console.log(`  FAIL track_setup ${label}: ${r}`); return -1; }
  codes[code] = (codes[code] ?? 0) + 1;
  return code;
}
loadTrack(gameFile('DEFAULT.TRK'));
testSetup('DEFAULT.TRK');
const valid = [];
for (let i = 0; i < 600; i++) {
  const t = rectTrack();
  if (testSetup('rect ' + i, t) === 0 && valid.length < 40) valid.push(t);
}
for (let i = 0; i < 400; i++) testSetup('mutated ' + i, mutate(rectTrack()));
for (let i = 0; i < 300; i++) testSetup('garbage ' + i, garbageTrack());
for (let i = 0; i < 4; i++) testSetup('serpentine ' + i, serpentine());
testSetup('crossings', crossings());
testSetup('forks 64', forks(64));
testSetup('forks 65', forks(65));
for (const [g, run] of [[1, 3], [1, 0], [2, 3], [3, 3], [0, 3]]) testSetup(`jump ${g} ${run}`, jump(g, run));
for (let i = 0; i < 40; i++) { // filler entered from a side (internal error), start of edge
  const t = rectTrack({ hill: false });
  for (let c = 2; c < 28; c++) for (let r = 2; r < 28; r++) if (HSTRAIGHT.includes(t.el[r][c]) && rnd(0, 3) === 0) t.el[r][c] = pick([0xfd, 0xff]);
  testSetup('filler ' + i, t);
}
report('track_setup', n, fails);
console.log('     return codes:', JSON.stringify(codes));
for (let e = 0; e <= 11; e++) if (e !== 2 && !codes[e]) { console.log('  missing return code', e); ok = false; }

// --- load_opponent_data after a successful track_setup, all opponents
n = fails = 0;
for (const [i, t] of [null, ...valid, serpentine()].entries()) {
  if (t) writeTrack(t); else loadTrack(gameFile('DEFAULT.TRK'));
  const h = heapMark();
  oracle.call('track_setup');
  for (let o = 1; o <= 6; o++) {
    gameconfig.game_opponenttype = o;
    const snap = M.slice(), h1 = heapMark();
    const r = cmp(() => T.load_opponent_data(), () => oracle.call('load_opponent_data'), 0);
    M.set(snap); heapReset(h1);
    n++;
    if (r && fails++ < 5) console.log(`  FAIL load_opponent_data track ${i} opp ${o}: ${r}`);
  }
  heapReset(h);
}
report('load_opponent_data', n, fails);

// --- Race: opponent_op / do_opponent_op at every frame, init_plantrak, then the intro loop.
// Random situations for opponent_op: player right around the opponent, crash/wheelie/sliding
// flags, wheels in the air, intro input mode, 10 fps, waypoint without height, lap done.
function perturb() {
  const o = state.opponentstate, p = state.playerstate;
  if (rnd(0, 2)) for (const k of ['lx', 'ly', 'lz']) p.car_posWorld1[k] = o.car_posWorld1[k] + rnd(k === 'ly' ? -100 : -700, k === 'ly' ? 100 : 700) * 64;
  o.car_crashBmpFlag = pick([0, 0, 0, 1]); o.car_speed2 = rnd(0, 0x6000);
  o.car_36MwhlAngle = pick([0, 0, 0, rnd(1, 100)]); o.car_slidingFlag = pick([0, 0, 1]);
  o.car_sumSurfFrontWheels = pick([0, 2, 2]); o.car_sumSurfRearWheels = pick([0, 2, 2]);
  o.car_demandedGrip = rnd(0, 400); o.car_surfacegrip_sum = rnd(0, 400); o.car_steeringAngle = rnd(-0x60, 0x60);
  state.game_inputmode = pick([0, 0, 2]); if (!MS) G.framespersec = pick([20, 20, 10]); state.field_3F9 = rnd(0, 255);
  p.car_crashBmpFlag = pick([0, 0, 1]); o.field_CD = pick([0, 0, 1]);
  if (!rnd(0, 4)) ww(o.$car_vec_unk3 + 2, -1);
}
let pf = 0, pn = 0;
function race(t, opp, frames) {
  bootWorld();
  if (t) writeTrack(t); else loadTrack(gameFile('DEFAULT.TRK'));
  const setCar = (arr, id) => { for (let i = 0; i < 4; i++) arr[i] = id.charCodeAt(i); };
  setCar(gameconfig.game_playercarid, 'COUN'); setCar(gameconfig.game_opponentcarid, pick(['PMIN', 'AUDI', 'JAGU', 'LM02', 'PC04', 'COUN']));
  gameconfig.game_playertransmission = 1;
  gameconfig.game_opponenttype = opp;
  setupRace(20);
  let f1 = 0, f2 = 0;
  for (let f = 0; f < frames; f++) {
    const input = rnd(0, 9) < 8 ? 1 | pick([0, 0, 4, 8]) : 2;
    const snap = M.slice();
    const r1 = cmp(() => T.opponent_op(), () => oracle.call('opponent_op'), 0);
    if (r1 && f1++ < 3) console.log(`  FAIL opponent_op opp ${opp} frame ${f}: ${r1}`);
    M.set(snap);
    const r2 = f % 50 ? null : cmp(() => T.do_opponent_op(), () => oracle.call('do_opponent_op'), 0);
    if (r2 && f2++ < 3) console.log(`  FAIL do_opponent_op opp ${opp} frame ${f}: ${r2}`);
    M.set(snap);
    perturb();
    const r3 = cmp(() => T.opponent_op(), () => oracle.call('opponent_op'), 0);
    pn++; if (r3 && pf++ < 3) console.log(`  FAIL opponent_op perturbed opp ${opp} frame ${f}: ${r3}`);
    M.set(snap);
    step(input);
  }
  return [f1, f2];
}
n = fails = 0;
let n2 = 0, fails2 = 0;
for (const [i, t] of [null, ...valid.slice(0, 6)].entries()) {
  const [a, b] = race(t, (i % 6) + 1, 600);
  n += 600; fails += a; n2 += 12; fails2 += b;
}
report('opponent_op (race frames)', n, fails);
report('opponent_op (perturbed)', pn, pf);
report('do_opponent_op', n2, fails2);

// Intro: init_plantrak with the intro's car, then do_opponent_op each frame on the plan track.
n = fails = 0;
bootWorld();
loadTrack(gameFile('DEFAULT.TRK'));
for (let i = 0; i < 4; i++) { gameconfig.game_playercarid[i] = 'COUN'.charCodeAt(i); gameconfig.game_opponentcarid[i] = 'COUN'.charCodeAt(i); }
gameconfig.game_opponenttype = 1;
setupRace(20);
{ // compare() leaves memory in the original's result state, so each call advances the intro.
  const r = cmp(() => T.init_plantrak(), () => oracle.call('init_plantrak'), 0);
  n++; if (r) { fails++; console.log('  FAIL init_plantrak: ' + r); }
  let fo = 0;
  for (let f = 0; f < 400; f++) {
    const r2 = cmp(() => T.do_opponent_op(), () => oracle.call('do_opponent_op'), 0);
    if (r2 && fo++ < 3) console.log(`  FAIL intro do_opponent_op frame ${f}: ${r2}`);
  }
  report('intro do_opponent_op', 400, fo);
}
report('init_plantrak', n, fails);

// Lockstep race traces on generated tracks (split roads, hills), all ports enabled.
if (process.argv[2] === 'trace') {
  SCENARIOS.length = 0;
  valid.slice(0, 6).forEach((t, i) => SCENARIOS.push({
    name: `generated-${i}-opp${i + 1}`, frames: 800,
    setup: () => { writeTrack(t); gameconfig.game_opponenttype = i + 1; for (let k = 0; k < 4; k++) { gameconfig.game_playercarid[k] = 'LANC'.charCodeAt(k); gameconfig.game_opponentcarid[k] = 'JAGU'.charCodeAt(k); } },
    input: () => (rnd(0, 9) < 8 ? 1 : 0) | pick([0, 0, 0, 4, 8]),
  }));
  ok &&= traceDiff(T.PORTS);
}
process.exit(ok ? 0 : 1);
