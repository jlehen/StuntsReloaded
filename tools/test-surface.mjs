// Differential tests: src/surface.js vs the original functions, on a race set up on DEFAULT.TRK
// with random element/terrain maps and random positions.
import { M, DS, G, A, rw, rsw, ww, s16 } from '../src/mem.js';
import { TRACKOBJECT } from '../src/structs.js';
import * as s from '../src/surface.js';
import { oracle, fuzz, rnd, SCRATCH_OFF as S } from './difftest.mjs';
import { gameFile } from './oracle.mjs';
import { loadTrack, setupRace, step, td, state } from '../src/race.js';
import { SCENARIOS, traceDiff } from './trace.mjs';

const o = oracle.call;
loadTrack(gameFile('DEFAULT.TRK'));
setupRace(20);
for (let f = 0; f < 50; f++) step(1); // a realistic mid-race state
const trackSnap = M.slice();

const E = td('td14_elem_map_main'), T = td('td15_terr_map_main');
const obj = e => new TRACKOBJECT(A.trkObjectList + 14 * e);
const ELEMS = [...Array(0xb6).keys()];
// Elements to test, weighted: the complex shapes (highway entrance .. buildings) 3 times.
const ELEM_CYCLE = ELEMS.flatMap(e => (obj(e).ss_physicalModel >= 0x0a && obj(e).ss_physicalModel <= 0x46 ? [e, e, e] : [e]));
const OBSTACLES = ELEMS.filter(e => [0x0b, 0x12, 0x20, 0x21, 0x22, 0x23, 0x47, 0x48, 0x49, 0x4a].includes(obj(e).ss_physicalModel));
const randTerr = () => (rnd(0, 2) ? 0 : rnd(0, 0x12));
const randElem = () => { const r = rnd(0, 9); return r < 3 ? 0 : r < 4 ? 0xfd + rnd(0, 2) : rnd(0, 0xb5); };
// Valid codes (elements 0..0xB5 and fillers, terrain 0..0x12), or any byte values.
function randomMaps(garbage = false) {
  for (let i = 0; i < 900; i++) {
    M[E + i] = garbage ? rnd(0, 255) : randElem();
    M[T + i] = garbage ? rnd(0, 255) : randTerr();
  }
}
// Places element e with its fillers at (col, row) (build_track_object's row: z >> 10).
// Returns the tiles it covers.
function place(e, col, row) {
  const flags = obj(e).ss_multiTileFlag;
  const tiles = [[col, row, e]];
  if (flags & 1) tiles.push([col, row - 1, 0xfe]);
  if (flags & 2) tiles.push([col + 1, row, 0xff]);
  if ((flags & 3) === 3) tiles.push([col + 1, row - 1, 0xfd]);
  for (const [c, r, v] of tiles) if (c >= 0 && c < 30 && r >= 0 && r < 30) M[E + 30 * r + c] = v;
  return tiles;
}
const K = +(process.env.K ?? 1); // case count scale
const setVec = (off, x, y, z) => { ww(DS + off, x); ww(DS + off + 2, y); ww(DS + off + 4, z); };
const clamp16 = v => Math.max(-32768, Math.min(32767, v));

let ok = true;

// --- subst_hillroad_track: every terrain x element pair that matters.
ok &= fuzz('subst_hillroad_track', 0x14 * 256, i => {
  const t = i >> 8, e = i & 0xff;
  return [`${t},${e}`, () => s.subst_hillroad_track(t, e), () => o('subst_hillroad_track', t, e)];
});

// --- build_track_object. Element mode: element e placed at a random tile (with its fillers) over
// random terrain; the position is drawn in element coordinates (uniformly, near the center line
// where roads, tubes and tunnels are, near a threshold, a corner arc or a slalom post) and rotated
// to world coordinates.
// Random mode: random positions over the random maps (sometimes garbage bytes).
const cover = new Map();
const heights = [[-60, 60], [0, 0x60], [0x50, 0xb0], [0x90, 0x110], [0x100, 0x200], [0x180, 0x240], [0x200, 0x300], [0x300, 0x600]];
// Thresholds compared against in element coordinates and heights, to test both sides of each.
const EDGES = [0, 0x17, 0x1f, 0x3c, 0x4b, 0x50, 0x54, 0x61, 0x64, 0x6e, 0x72, 0x73, 0x78, 0x82, 0x96, 0xa4, 0xa8, 0xaa,
  0xb4, 0xc8, 0xf1, 0x100, 0x104, 0x10e, 0x10f, 0x12c, 0x14c, 0x14e, 0x168, 0x17c, 0x188, 0x1dc, 0x200, 0x278, 0x2b4];
const HEIGHT_EDGES = [0x58, 0x64, 0x90, 0x97, 0xab, 0x109, 0x15e, 0x186, 0x20c];
const nearEdge = list => (rnd(0, 1) ? 1 : -1) * list[rnd(0, list.length - 1)] + rnd(-3, 3);
// Corner, split and corkscrew arcs: centers and radius thresholds.
const ARC_CENTERS = [[-0x400, -0x400], [-0x200, -0x200], [0x200, -0x200], [0x400, -0x400], [0, 0]];
const RADII = [0x188, 0x278, 0x588, 0x678, 0x56a, 0x696, 0x594, 0x66c, 0x588, 0x666, 0x67e, 0x14c, 0x2b4, 0x1a6, 0x25a];
function nearArc() {
  const [cx, cz] = ARC_CENTERS[rnd(0, ARC_CENTERS.length - 1)], r = RADII[rnd(0, RADII.length - 1)] + rnd(-3, 3);
  const a = rnd(0, 1023) * Math.PI / 512;
  return [Math.round(cx + r * Math.sin(a)), Math.round(cz + r * Math.cos(a))];
}
function btoCase(i, mode) {
  if (i % 200 === 0) { M.set(trackSnap); randomMaps(mode === 'random' && rnd(0, 3) === 0); }
  state.game_inputmode = rnd(0, 1);
  let x, z, e = -1, hill = false;
  if (mode === 'element') {
    e = ELEM_CYCLE[i % ELEM_CYCLE.length];
    const col = rnd(0, 28), row = rnd(1, 29);
    const terr = randTerr();
    M[T + 30 * (29 - row) + col] = terr; // terrain map rows are flipped (trackrows)
    hill = terr === 6;
    place(e, col, row);
    const flags = obj(e).ss_multiTileFlag;
    const halfX = flags & 2 ? 1024 : 512, halfZ = flags & 1 ? 1024 : 512;
    const xc = flags & 2 ? (col + 1) * 1024 : col * 1024 + 512, zc = flags & 1 ? row * 1024 : row * 1024 + 512;
    const kind = rnd(0, 4); // uniform, near the center line, near a threshold, near an arc, near a slalom post
    let ex = kind === 0 ? rnd(-halfX, halfX - 1) : kind === 1 ? rnd(-0xb0, 0xb0) : nearEdge(EDGES);
    let ez = kind === 2 ? nearEdge(EDGES) : rnd(-halfZ, halfZ - 1);
    if (kind === 3) [ex, ez] = nearArc();
    if (kind === 4) [ex, ez] = [(rnd(0, 1) ? 1 : -1) * rnd(0x10, 0x68), (rnd(0, 1) ? 1 : -1) * rnd(0xe8, 0x118)];
    const [dx, dz] = { 0: [ex, ez], 0x100: [ez, -ex], 0x200: [-ex, -ez], 0x300: [-ez, ex] }[obj(e).ss_rotY];
    x = xc + dx; z = zc + dz;
  } else {
    x = rnd(-2000, 32767); z = rnd(-2000, 32767);
  }
  const [hlo, hhi] = heights[rnd(0, heights.length - 1)];
  const y = (rnd(0, 2) ? rnd(hlo, hhi) : nearEdge(HEIGHT_EDGES)) + (hill || !rnd(0, 9) ? 450 : 0);
  const d = [40, 40, 150, 1500][rnd(0, 3)];
  setVec(S, x, y, z);
  setVec(S + 6, clamp16(x + rnd(-d, d)), y + rnd(-d, d), clamp16(z + rnd(-d, d)));
  return [`${mode} e=${e.toString(16)} pos=${x},${y},${z}`, () => s.build_track_object(DS + S, DS + S + 6), () => {
    o('build_track_object', S, S + 6);
    const row = z >> 10, col = x >> 10;
    if (row >= 0 && row < 30 && col >= 0 && col < 30) {
      let t = M[E + 30 * row + col];
      if (t >= 0xfd) t = M[E + 30 * (t === 0xff ? row : row + 1) + (t === 0xfe ? col : col - 1)];
      const pm = obj(t).ss_physicalModel;
      if (!cover.has(pm)) cover.set(pm, [new Set(), new Set()]);
      cover.get(pm)[0].add(G.planindex >> 2);
      cover.get(pm)[1].add(G.wallindex);
    }
    return 0;
  }, 0];
}
ok &= fuzz('build_track_object element', 20000 * K, i => btoCase(i, 'element'));
ok &= fuzz('build_track_object random', 5000 * K, i => btoCase(i, 'random'));
// Coverage: per physical model, the planes (planindex / 4) and walls the original returned.
const hex = set => [...set].sort((a, b) => a - b).map(v => v.toString(16)).join(',');
if (process.env.COVER) for (const [k, [planes, walls]] of [...cover].sort((a, b) => a[0] - b[0])) console.log(`  model ${k.toString(16)}: planes ${hex(planes)} walls ${hex(walls)}`);

let points = 0;
// --- bto_auxiliary1: obstacle points (its row is counted as trackrows: 29 - z index).
ok &= fuzz('bto_auxiliary1', 5000 * K, i => {
  if (i % 200 === 0) { M.set(trackSnap); randomMaps(); }
  const col = rnd(0, 20) ? rnd(0, 29) : rnd(-1, 30), row = rnd(0, 20) ? rnd(0, 29) : rnd(-1, 30);
  if (rnd(0, 1)) place(rnd(0, 3) ? OBSTACLES[rnd(0, OBSTACLES.length - 1)] : rnd(0, 0xb5), col, 29 - row);
  if (col >= 0 && col < 30 && row >= 0 && row < 30) M[T + 30 * row + col] = randTerr();
  return [`${col},${row}`, () => s.bto_auxiliary1(col, row, DS + S), () => { const n = o('bto_auxiliary1', col, row, S) & 0xffff; points += n; return n; }];
});
console.log(`  (${points} obstacle points)`);

// --- plane_rotate_op: random plane, vectors, headings and cache states.
M.set(trackSnap);
ok &= fuzz('plane_rotate_op', 5000 * K, () => {
  const idx = rnd(0, 3) ? rnd(0, 535) : -1;
  G.planindex_copy = idx;
  setVec(A.vec_unk2 - DS, rnd(-2000, 2000), rnd(-2000, 2000), rnd(-2000, 2000));
  for (let k = 0; k < 9; k++) ww(A.mat_unk + 2 * k, rnd(0, 3) ? rnd(-16384, 16384) : 0);
  const a = rnd(0, 2) ? rnd(-512, 512) : 0;
  G.pState_f36Mminf40sar2 = a;
  if (rnd(0, 2) === 0) G.f36f40_whlData = a;
  if (idx >= 0) {
    const p = (rw(A.planptr + 2) << 4) + rw(A.planptr) + 34 * idx;
    if (rnd(0, 2) === 0) { G.pState_minusRotate_x_2 = rsw(p + 2); G.pState_minusRotate_z_2 = rsw(p); }
    else { G.pState_minusRotate_x_2 = rnd(-512, 512); G.pState_minusRotate_z_2 = rnd(-512, 512); }
    G.pState_minusRotate_y_2 = rnd(-1024, 1024);
    if (rnd(0, 2) === 0) G.word_3BE16 = s16(G.pState_minusRotate_y_2 + a);
  }
  return [`${idx} ${a}`, () => s.plane_rotate_op(), () => o('plane_rotate_op'), 0];
});

// --- car_car_coll_detect_maybe: two boxes near each other, random orientations.
let collisions = 0;
ok &= fuzz('car_car_coll_detect_maybe', 5000 * K, () => {
  const coll = off => { ww(DS + off, rnd(20, 200)); ww(DS + off + 2, rnd(20, 200)); ww(DS + off + 4, rnd(20, 300)); ww(DS + off + 6, rnd(50, 450)); };
  coll(S); coll(S + 8);
  const r = rnd(0, 3) ? 400 : 3000;
  const px = rnd(0, 30000), py = rnd(0, 500), pz = rnd(0, 30000);
  setVec(S + 16, px, py, pz);
  setVec(S + 22, rnd(0, 3) ? rnd(-64, 64) : rnd(0, 1023), rnd(0, 3) ? rnd(-64, 64) : rnd(0, 1023), rnd(0, 1023));
  setVec(S + 28, clamp16(px + rnd(-r, r)), py + rnd(-r / 4, r / 4), clamp16(pz + rnd(-r, r)));
  setVec(S + 34, rnd(0, 3) ? rnd(-64, 64) : rnd(0, 1023), rnd(0, 3) ? rnd(-64, 64) : rnd(0, 1023), rnd(0, 1023));
  return ['', () => s.car_car_coll_detect_maybe(DS + S, DS + S + 16, DS + S + 8, DS + S + 28),
    () => { const r = o('car_car_coll_detect_maybe', S, S + 16, S + 8, S + 28); collisions += r & 1; return r; }];
});
console.log(`  (${collisions} collisions)`);

// --- Lockstep race: the player is teleported onto each element type of DEFAULT.TRK in turn
// (random offset, height and heading) and driven for 30 frames, so the lookup runs under real
// physics on loops, pipes, corks, ramps, bridges, buildings...
SCENARIOS.push({
  name: 'surface-teleport',
  setup() {
    const trk = gameFile('DEFAULT.TRK');
    loadTrack(trk);
    const first = new Map();
    for (let i = 0; i < 900; i++) if (trk[i] && trk[i] < 0xfd && !first.has(trk[i])) first.set(trk[i], i);
    this.targets = [...first.values()];
    this.frames = this.targets.length * 30;
    this.f = 0;
  },
  input() {
    const ps = state.playerstate;
    if (this.f % 30 === 0) {
      const t = this.targets[this.f / 30];
      const x = (t % 30) * 1024 + 512 + rnd(-200, 200), z = Math.floor(t / 30) * 1024 + 512 + rnd(-200, 200), y = rnd(0, 600);
      for (const p of [ps.car_posWorld1, ps.car_posWorld2]) { p.lx = x * 64; p.ly = y * 64; p.lz = z * 64; }
      ps.car_rotate.x = rnd(0, 1023);
      ps.car_crashBmpFlag = 0;
    }
    this.f++;
    return 1 | [0, 0, 4, 8][rnd(0, 3)];
  },
});
ok &= traceDiff(s.PORTS, 'surface-teleport');

process.exit(ok ? 0 : 1);
