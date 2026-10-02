// Track validation and path tracing (track_setup), the opponent's route (load_opponent_data),
// the opponent AI (opponent_op) and the intro's demo track (init_plantrak). Ported from the asm.
//
// Track tables filled by track_setup (far arrays, see race.js TD), indexed by path piece p (the
// order in which the trace records pieces, starting at the start/finish tile), checkpoint c or
// camera point k:
//   td17_trk_elem_ordered[p]  element id (hill roads substituted: 0xB6..0xC5)
//   td21_col_from_path[p], td22_row_from_path[p]  tile of the piece
//   trackdata18[p]            (reversed << 4) | block: which TRKOBJINFO block of the element is
//                             driven, and whether it is driven exit-to-entry
//   td01_track_file_cpy[p]    next piece (0xFFFF: none); td02_penalty_related[p]: the second
//                             successor where the road splits. 0 = back to the start (lap).
//   trackdata19[trackrows[row] + col]  checkpoint index of a tile, 0xFF = none
//   td10_track_check_rel[c]   checkpoint position (x, y, z); td08_direction_related[c]: its
//                             direction (0..0x3FF); trackdata23[c]: its kind (from si_opp3)
//   trackdata9[k]             camera position (x, y, z); trackdata7[k]: 0x1C2 on a hill, else 0;
//                             trackdata6[k] = 0
//   byte_45635 checkpoint count, byte_4616E camera count, track_pieces_counter piece count,
//   startcol2/startrow2 start tile, track_angle start direction, hillFlag start on a hill,
//   byte_45D90/byte_45E16: start tile, or the failing tile when an error is returned.
import { M, A, G, U, DS, rb, rsb, rw, rsw, wb, ww, s8, u8, s16, u16, farptrAt, setFarptr, frame, alloca } from './mem.js';
import { state, gameconfig, fps } from './structs.js';
import { MS } from './version.js';
import { cpu } from './engine.js';
import { call, provide, defineSigs } from './calls.js';
import { PROCS } from './engine.js';
import { loadResfile, locateResource } from './files.js';
import {
  idiv, mat_rot_zxy, mat_mul_vector, polarAngle, polarRadius2D, polarRadius3D, sin_fast, cos_fast, multiply_and_scale,
} from './math.js';

defineSigs({ mmgr_alloc_resbytes: 'nl', mmgr_release: 'f', copy_string: 'nf', unload_resource: 'f' });

// track_setup return codes (the track editor shows them). 0 = ok.
export const TRACK_ERRORS = {
  1: 'no start/finish', 2: 'internal error (bad filler tile, or out of memory)', 3: 'more than one start/finish',
  4: 'pieces do not connect', 5: 'road driven the wrong way', 6: 'too many pieces (901)',
  7: 'path does not return to the start/finish', 8: 'too many split roads (64 pending)',
  9: 'not enough runway before a jump', 10: 'jump too long', 11: 'terrain mismatch',
};
const NO_SF = 1, INT_ERR = 2, MANY_SF = 3, ELEM_MISM = 4, WRONG_WAY = 5, MANY_ELEM = 6, NO_PATH = 7,
  MANY_PATH = 8, NO_RUNWAY = 9, LONG_JUMP = 10, TERR_MISM = 11;

// Far track tables, indexed like the original's seg:(off + i) (the offset wraps in its segment).
const td = (name, i = 0) => farptrAt(A[name], i);
const elemAt = (row, col) => td('td14_elem_map_main', rw(A.trackrows + row * 2) + col);
const terrAt = (row, col) => td('td15_terr_map_main', rw(A.terrainrows + row * 2) + col);
// trkObjectList[elem]: TRACKOBJECT (14 bytes); +0 near pointer to its TRKOBJINFO blocks, +11 multi-tile flags
// (1: two tiles tall, 2: two tiles wide; the piece's reference point is then the tile corner).
const trkObj = elem => A.trkObjectList + elem * 14;
const blocksOf = elem => rw(trkObj(elem));
// TRKOBJINFO block n (14 bytes): +0 block count (in block 0), +1 entry point, +2 exit point, +3 entry
// connection type, +4 exit type, +5 camera/checkpoint record index, +6 direction, +8 camera data,
// +10 camera data when driven reversed (0: same), +12 checkpoint kind (0 none, -1 never), +13 speed code.
const block = (info, n) => DS + ((info + n * 14) & 0xffff);
// Tile side (entry point) through which a piece is entered, by travel direction (0 north, 0x100 east...).
const ENTRY = { 0: 2, 0x100: 4, 0x200: 1, 0x300: 3 };
// Filler tiles of multi-tile pieces: step to the main tile, then the entry point on the piece's outline.
const FILLER = {
  0xfd: [-1, -1, { 0: 12, 0x100: 0, 0x200: 0, 0x300: 9 }],
  0xfe: [0, -1, { 0: 11, 0x100: 6, 0x200: 0, 0x300: 7 }],
  0xff: [-1, 0, { 0: 10, 0x100: 0, 0x200: 5, 0x300: 8 }],
};
// Exit points 1..12: [dcol, drow, new direction] to the next tile.
const EXITS = [[0, -1, 0], [0, 1, 0x200], [1, 0, 0x100], [-1, 0, 0x300], [1, -1, 0], [-1, 1, 0x300],
  [1, 1, 0x100], [2, 0, 0x100], [2, 1, 0x100], [1, 1, 0x200], [0, 2, 0x200], [1, 2, 0x200]];
const START_ANGLE = { 0x01: 0, 0x86: 0, 0x93: 0, 0x87: 0x200, 0x94: 0x200, 0xb3: 0x200,
  0x88: 0x100, 0x95: 0x100, 0xb4: 0x100, 0x89: 0x300, 0x96: 0x300, 0xb5: 0x300 };

// Camera/checkpoint offset (x, z) rotated by a piece direction.
function rotate(x, z, dir) {
  if (dir === 0x100) return [z, s16(-x)];
  if (dir === 0x200) return [s16(-x), s16(-z)];
  if (dir === 0x300) return [s16(-z), x];
  return [x, z];
}
// World z / x of a piece's reference point: the tile center, or the tile edge for multi-tile pieces.
const pieceZ = (elem, row) => rw((rb(trkObj(elem) + 11) & 1 ? A.trackpos : A.trackcenterpos) + row * 2);
const pieceX = (elem, col) => rw(rb(trkObj(elem) + 11) & 2 ? A.trackpos2 + 2 + col * 2 : A.trackcenterpos2 + col * 2);

export function track_setup() {
  const r = call.mmgr_alloc_resbytes(A.aTcomp, 0x380);
  if (!r) return 2;
  const tcomp = ((r >>> 16) << 4) + (r & 0xffff); // 64 saved branch states (split roads), 14 bytes each
  let col = 0, row = 0; // current tile, signed bytes; on error, the failing tile

  const run = () => {
    U.track_pieces_counter = 0;
    for (let i = 0; i < 0x385; i++) wb(td('trackdata19', i), 0xff);

    // Terrain edges must match their neighbours' (0x63: first tile of a line).
    for (row = 0; row < 30; row++) {
      let prev = 0x63;
      for (col = 0; col < 30; col++) {
        const t = rb(terrAt(row, col));
        if (rb(A.terrConnDataEtoW + t) !== prev && prev !== 0x63) return TERR_MISM;
        prev = rb(A.terrConnDataWtoE + t);
      }
    }
    for (col = 0; col < 30; col++) {
      let prev = 0x63;
      for (row = 0; row < 30; row++) {
        const t = rb(terrAt(row, col));
        if (rb(A.terrConnDataNtoS + t) !== prev && prev !== 0x63) return TERR_MISM;
        prev = rb(A.terrConnDataStoN + t);
      }
    }

    // Exactly one start/finish. Hill-road ids in the map are reset to a plain road.
    let starts = 0;
    for (row = 0; row < 30; row++) {
      for (col = 0; col < 30; col++) {
        const p = elemAt(row, col);
        let e = rb(p);
        if (e >= 0xfd) e = 0;
        if (e >= 0xb6) { e = 4; wb(p, 4); }
        if (START_ANGLE[e] === undefined) continue;
        G.track_angle = START_ANGLE[e];
        if (starts) return MANY_SF;
        U.startcol2 = col; U.startrow2 = row;
        U.hillFlag = rb(terrAt(row, col)) === 6 ? 1 : 0;
        starts++;
      }
    }
    if (!starts) return NO_SF;

    // Trace the road from the start/finish, depth first through split roads.
    U.track_pieces_counter = 0;
    U.byte_45635 = 0; U.byte_4616E = 0;
    let branches = 0; // saved states in tcomp
    let runway = 0; // pieces without a checkpoint mark since the last marked one
    let gap = 0; // empty tiles jumped over after a ramp
    let closed = 0; // the path returned to the start
    // ponytail: the original's visited maps are stack arrays; a filler on row/column 0 (garbage
    // tracks only) indexes outside them and reads stack garbage, which is not emulated (reads 0).
    const visited = new Uint8Array(0x385); // by trackrows[row] + col
    const pathBlock = new Uint8Array(0x385), pathRev = new Int8Array(0x385); // per recorded piece
    for (let i = 0; i < 0x385; i++) { ww(td('td01_track_file_cpy', i * 2), -1); ww(td('td02_penalty_related', i * 2), -1); }
    col = s8(U.startcol2); row = s8(U.startrow2);
    let dir = U.track_angle;
    let conn = 0; // connection type at the current tile's entry
    let prevPiece = 0xffff;
    let elem = 0, blk = 0, rev = 0, entry = 0; // current piece: element, block, driven reversed, entry point
    let prevCol = 0, prevRow = 0, prevElem = 0, prevBlk = 0, prevRev = 0;
    // Link piece `from` to its successor `to` (second link: split road).
    const link = (from, to) => {
      let p = td('td01_track_file_cpy', from * 2);
      if (rw(p) !== 0xffff) p = td('td02_penalty_related', from * 2);
      ww(p, to);
    };

    for (;;) {
      let matches = 0;
      if (col >= 0 && row >= 0 && col <= 29 && row <= 29) {
        elem = rb(elemAt(row, col));
        const terr = rb(terrAt(row, col));
        if (elem && terr >= 7 && terr < 11) elem = call.subst_hillroad_track(terr, elem) & 0xff;
        if (elem >= 0xfd) {
          const [dc, dr, entries] = FILLER[elem];
          col = s8(col + dc); row = s8(row + dr);
          entry = entries[dir] ?? entry;
          elem = rb(elemAt(row, col));
        } else entry = ENTRY[dir] ?? entry;
        if (gap === 0 && entry === 0) return INT_ERR;

        // Blocks of the piece that connect to where we come from. The first one is followed, the
        // others are split roads saved for later.
        const info = blocksOf(elem);
        for (let si = 0; info && si < rb(DS + info); si++) {
          const b = block(info, si);
          let cc; // 0: driven entry to exit, 1: exit to entry
          if (rb(b + 1) === entry) { if (rb(b + 3) !== conn) return ELEM_MISM; cc = 0; }
          else if (rb(b + 2) === entry) { if (rb(b + 4) !== conn) return ELEM_MISM; cc = 1; }
          else continue;
          if (visited[rw(A.trackrows + row * 2) + col]) {
            // Already on the path: link to it (the loop is closed if it is the start).
            const tpc = s16(U.track_pieces_counter);
            for (let di = 0; di < tpc; di++) {
              if (rb(td('td21_col_from_path', di)) !== u8(col) || rb(td('td22_row_from_path', di)) !== u8(row) || pathBlock[di] !== si) continue;
              if (pathRev[di] !== cc) return WRONG_WAY;
              cc = -1;
              link(prevPiece, di);
              if (di === 0) closed = 1;
            }
          }
          if (cc < 0) continue;
          if (!matches) { blk = si; rev = cc; }
          else {
            if (branches === 0x40) return MANY_PATH;
            const e = tcomp + branches * 14;
            wb(e, col); wb(e + 1, row); wb(e + 2, elem); wb(e + 3, si); wb(e + 4, cc); wb(e + 5, runway);
            wb(e + 6, prevCol); wb(e + 7, prevRow); wb(e + 8, prevElem); wb(e + 9, prevBlk); wb(e + 10, prevRev);
            wb(e + 11, conn); ww(e + 12, prevPiece);
            branches++;
          }
          matches++;
        }

        if (!matches && conn === 1 && gap < 2) {
          // Off a ramp: jump over up to two empty tiles.
          if (runway < 2) return NO_RUNWAY;
          runway = u8(runway + 1);
          gap++;
          if (dir === 0) { col = prevCol; row = s8(prevRow - gap - 1); }
          else if (dir === 0x100) { row = prevRow; col = s8(prevCol + gap + 1); }
          else if (dir === 0x200) { col = prevCol; row = s8(prevRow + gap + 1); }
          else if (dir === 0x300) { row = prevRow; col = s8(prevCol - gap - 1); }
          continue;
        }
      }
      if (!matches) {
        // Dead end (or back on the path): resume the last saved split road.
        if (!branches) break;
        branches--;
        const e = tcomp + branches * 14;
        col = rsb(e); row = rsb(e + 1); elem = rb(e + 2); blk = rb(e + 3); rev = rsb(e + 4); runway = rb(e + 5);
        prevCol = rsb(e + 6); prevRow = rsb(e + 7); prevElem = rb(e + 8); prevBlk = rb(e + 9); prevRev = rsb(e + 10);
        conn = rb(e + 11); prevPiece = rw(e + 12);
      }
      if (gap > 1) return LONG_JUMP;

      // Record the piece.
      gap = 0;
      visited[rw(A.trackrows + row * 2) + col] = 1;
      const p = U.track_pieces_counter;
      pathBlock[p] = blk; pathRev[p] = rev;
      if (prevPiece !== 0xffff) link(prevPiece, p);
      prevPiece = p;
      wb(td('td21_col_from_path', p), col); wb(td('td22_row_from_path', p), row);
      wb(td('trackdata18', p), (rev << 4) + blk);
      wb(td('td17_trk_elem_ordered', p), elem);
      const cur = block(blocksOf(elem), blk);
      const kind = rsb(cur + 12);
      if (kind === 0) runway = u8(runway + 1);
      else {
        if (kind !== -1 && runway > 3 && U.byte_45635 !== 0x30) {
          // Checkpoint, placed on the previous piece.
          const c = s8(U.byte_45635);
          const pb = block(blocksOf(prevElem), prevBlk);
          const cam = prevRev && rw(pb + 10) ? rw(pb + 10) : rw(pb + 8);
          const src = DS + ((cam + rb(pb + 5) * 12 + (prevRev ? 12 : 6)) & 0xffff);
          let x = rsw(src), y = rsw(src + 2), z = rsw(src + 4);
          dir = rw(pb + 6);
          [x, z] = rotate(x, z, dir);
          ww(td('td08_direction_related', c * 2), prevRev ? dir ^ 0x200 : dir);
          wb(td('trackdata23', c), rb((rev ? A.byte_3E724 : A.byte_3E71E) + kind));
          if (rb(terrAt(prevRow, prevCol)) === 6) y += 0x1c2;
          ww(td('td10_track_check_rel', c * 6 + 2), y);
          ww(td('td10_track_check_rel', c * 6 + 4), pieceZ(prevElem, prevRow) + z);
          ww(td('td10_track_check_rel', c * 6), pieceX(prevElem, prevCol) + x);
          wb(td('trackdata19', rw(A.trackrows + prevRow * 2) + prevCol), U.byte_45635);
          U.byte_45635++;
        }
        runway = 0;
      }
      U.track_pieces_counter = p + 1;
      if (p + 1 === 0x385) return MANY_ELEM;

      // Next tile, through the exit (or the entry when driven reversed).
      const exit = rev ? rb(cur + 1) : rb(cur + 2);
      conn = rev ? rb(cur + 3) : rb(cur + 4);
      prevCol = col; prevRow = row; prevRev = rev; prevBlk = blk; prevElem = elem;
      const step = EXITS[exit - 1];
      if (step) { col = s8(col + step[0]); row = s8(row + step[1]); dir = step[2]; }
    }
    if (!closed) return NO_PATH;
    U.byte_45D90 = U.startcol2; U.byte_45E16 = U.startrow2;

    // Camera points: up to 64 pieces spread along the path, one per tile.
    const pieces = U.track_pieces_counter;
    U.byte_4616E = Math.min(idiv(s16(pieces), 3), 64);
    const n = s8(U.byte_4616E);
    const seen = new Uint8Array(0x385); // by terrainrows[row] + col
    let cams = 0;
    for (let i = 0; i < n; i++) {
      // The product wraps to 16 bits on long tracks (the original's cwd), as do the indices.
      const p = idiv(s16(pieces * i), n);
      col = rsb(td('td21_col_from_path', p)); row = rsb(td('td22_row_from_path', p));
      const k = u16(rw(A.terrainrows + row * 2) + col);
      if (seen[k]) continue;
      seen[k] = 1;
      const e = rb(td('td17_trk_elem_ordered', p));
      const t18 = rb(td('trackdata18', p));
      const b = block(blocksOf(e), t18 & 15);
      const cam = t18 & 0x10 && rw(b + 10) ? rw(b + 10) : rw(b + 8);
      const src = DS + ((cam + rb(b + 5) * 12) & 0xffff);
      let x = rsw(src), y = rsw(src + 2), z = rsw(src + 4);
      [x, z] = rotate(x, z, rw(b + 6));
      const h = rb(terrAt(row, col)) === 6 ? 0x1c2 : 0;
      ww(td('trackdata7', cams * 2), h);
      ww(td('trackdata6', cams * 2), 0);
      ww(td('trackdata9', cams * 6 + 2), h + y);
      ww(td('trackdata9', cams * 6 + 4), pieceZ(e, row) + z);
      ww(td('trackdata9', cams * 6), pieceX(e, col) + x);
      cams++;
    }
    U.byte_4616E = cams;
    return 0;
  };

  const err = run();
  if (err) {
    if (col === -1) col = 0; else if (col === 30) col = 29;
    if (row === -1) row = 0; else if (row === 30) row = 29;
    U.byte_45D90 = col; U.byte_45E16 = row;
  }
  call.mmgr_release(tcomp);
  return err;
}

// Opponent route: the cheapest path from the start back to it through the split roads, where a
// piece costs sped[element] + 1. Written to trackdata3 as piece indices, then 0, 0, 1.
export function load_opponent_data() {
  wb(A.aOpp1 + 3, gameconfig.game_opponenttype + 0x30); // "oppN"
  const res = loadResfile(cstr(A.aOpp1));
  call.copy_string(A.unk_46464, locateResource(res, String.fromCharCode(U.textresprefix) + 'nam')); // opponent name
  // (the original also locates "path", unused)
  const sped = locateResource(res, 'sped');
  M.copyWithin(A.oppnentSped, sped, sped + 16);

  let best = 999999;
  const path = [], pending = []; // pending splits: [piece, path length, cost]
  let len = 0, cost = 0, p = 0;
  for (;;) {
    const next = rw(td('td01_track_file_cpy', p * 2));
    let end = false, lap = false;
    if (next === 0) end = lap = true;
    else if (next === 0xffff) end = true;
    else if (path.slice(0, len).includes(p)) end = true; // loop without the start
    path[len++] = p;
    cost = (cost + rb(sped + rb(td('td17_trk_elem_ordered', p))) + 1) >>> 0;
    if (!end) {
      const alt = rw(td('td02_penalty_related', p * 2));
      if (alt !== 0xffff) pending.push([alt, len, cost]);
      p = next;
      continue;
    }
    if (lap && cost < best) {
      path[len++] = 0;
      best = cost;
      for (let i = 0; i < len; i++) ww(td('trackdata3', i * 2), path[i]);
      ww(td('trackdata3', len * 2), 0);
      ww(td('trackdata3', len * 2 + 2), 1);
    }
    if (!pending.length) break;
    [p, len, cost] = pending.pop();
  }
  call.unload_resource(res);
}
const cstr = a => { let s = ''; while (M[a]) s += String.fromCharCode(M[a++]); return s; };

// Intro: the opponent car driving around a 4-piece loop on the flat plan_memres plane.
export function init_plantrak() {
  if (!MS) call.init_game_state(0xfffd); // timing globals, which the Mindscape build does not have
  state.game_inputmode = 2;
  setFarptr(A.planptr, PROCS.plan_memres); // in the code, at the start of its own segment
  U.startcol2 = 1; U.startrow2 = 0x1c;
  const r = U.startrow2;
  [[7, 1, r], [6, 0, r], [8, 0, r + 1], [9, 1, r + 1], [7, 1, r]].forEach(([e, c, rr], i) => {
    wb(td('td17_trk_elem_ordered', i), e); wb(td('td21_col_from_path', i), c);
    wb(td('td22_row_from_path', i), rr); wb(td('trackdata18', i), 0);
  });
  [0, 1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 3, 4, 0, 1, 2, 3, 0].forEach((v, i) => ww(td('trackdata3', i * 2), v));
  U.oppnentSped = 200;
  const opp = state.opponentstate;
  call.init_carstate_from_simd(opp.addr, A.simd_opponent, 1, 0x17700, 0, s16(rw(A.trackpos + 0x38) + 0x12e) * 64, 0);
  nextWaypoint(opp);
}

// Ask sub_18D60 to place the next waypoint (car_vec_unk3, with the road edges in unk4/unk5) along
// trackdata3; when it reports the piece done, move to the next piece (field_CD counts laps).
function nextWaypoint(opp) {
  const n = opp.field_CE;
  opp.field_CE = n + 1;
  if (!(call.sub_18D60(rw(td('trackdata3', opp.car_trackdata3_index * 2)), opp.$car_vec_unk3, u8(n), state.$field_3F9) & 0xff)) return;
  opp.car_trackdata3_index = opp.car_trackdata3_index + 1;
  if (rw(td('trackdata3', opp.car_trackdata3_index * 2)) === 0) {
    opp.field_CD = opp.field_CD + 1;
    opp.car_trackdata3_index = 0;
  }
  opp.field_CE = 0;
}

const abs16 = v => v < 0 ? s16(-v) : v;
const pos6 = v => s16(v >> 6); // world position (1/64 units) to track units
// AX left by mat_mul_vector (its last product term); polarAngle(0, 0) returns it.
function matMulAx(mat, v) {
  const m33 = rsw(mat + 16), z = rsw(v + 4);
  return m33 === 0 ? 0 : z === 0 ? m33 : ((m33 * z) << 2) & 0xffff;
}

// Opponent AI, once per frame: steer toward the current waypoint (or beside the player's car
// when about to hit it from behind), keep the speed near sped's target (field_3F9 << 8), then
// run the car physics. Crossing the start line after a lap (field_CD) ends its race.
export function opponent_op() {
  // Callees run at the original's depth: push bp; sub sp, 40h (Mindscape: 3Ah); push di; push si.
  const sp = cpu.sp;
  cpu.sp = (sp - (MS ? 0x40 : 0x46)) & 0xffff;
  try { opponentOp(); } finally { cpu.sp = sp; }
}
function opponentOp() {
  frame(() => {
    const opp = state.opponentstate, pl = state.playerstate;
    const [steerStep, brakeStep] = fps() === 20 ? [8, 1] : [16, 2];
    const ox = pos6(opp.car_posWorld1.lx), oy = pos6(opp.car_posWorld1.ly), oz = pos6(opp.car_posWorld1.lz);
    const px = pos6(pl.car_posWorld1.lx), py = pos6(pl.car_posWorld1.ly), pz = pos6(pl.car_posWorld1.lz);
    const w = opp.$car_vec_unk3, left = opp.$car_vec_unk5, right = opp.$car_vec_unk4;
    const v = alloca(6), rel = alloca(6), aim = alloca(6), tmp = alloca(6), target = alloca(6);
    const rotMat = () => mat_rot_zxy(opp.car_rotate.z, opp.car_rotate.y, opp.car_rotate.x, 1);
    // Distance to the waypoint (flat when it has no height).
    const waypointDist = () => {
      M.copyWithin(rel, w, w + 6);
      if (rsw(rel + 2) === -1) return polarRadius2D(s16(rsw(rel) - ox), s16(rsw(rel + 4) - oz));
      ww(tmp, rsw(rel) - ox); ww(tmp + 2, rsw(rel + 2) - oy); ww(tmp + 4, rsw(rel + 4) - oz);
      return polarRadius3D(tmp);
    };
    // The point to steer at: the waypoint, or, with the player just ahead, halfway between the
    // waypoint and the road edge on the other side (field_45E: which side, for the player's view).
    // half: the builds halve differently (Broderbund shifts, Mindscape divides).
    const pickTarget = (mat, half) => {
      M.copyWithin(target, w, w + 6);
      if (state.game_inputmode === 2) return;
      ww(v, px - ox); ww(v + 2, py - oy); ww(v + 4, pz - oz);
      mat_mul_vector(v, mat, aim);
      const ax = rsw(aim), ay = rsw(aim + 2), az = rsw(aim + 4); // player in the opponent's frame
      if (ay > 90 || abs16(ax) > 180 || az > 600 || az < -180) return;
      ww(v, px - rsw(w)); ww(v + 2, rsw(w + 2) === -1 ? 0 : py - rsw(w + 2)); ww(v + 4, pz - rsw(w + 4));
      mat_mul_vector(v, mat, tmp);
      const edge = rsw(tmp) < 0 ? left : right;
      ww(target, half(rsw(edge) + rsw(w)));
      ww(target + 2, rsw(w + 2) === -1 ? -1 : half(rsw(edge + 2) + rsw(w + 2)));
      ww(target + 4, half(rsw(edge + 4) + rsw(w + 4)));
      if (az > -78 && !pl.car_crashBmpFlag) state.field_45E = rsw(tmp) < 0 ? 2 : 1;
    };
    opp.field_CF = 0;
    state.field_45E = 0;
    let mat = MS ? 0 : rotMat();
    opp.field_CF = 1;

    if (opp.car_crashBmpFlag) {
      if (opp.car_speed2 === 0) opp.field_CF = 0;
    } else if (MS) {
      // Mindscape: one pass. A waypoint too far to the side is not skipped (Broderbund retries
      // with the next one), and the target's height is used even when it has none (-1).
      if (waypointDist() < 200) nextWaypoint(opp);
      mat = rotMat();
      pickTarget(mat, sum => Math.trunc(sum / 2));
      ww(v, rsw(target) - ox); ww(v + 2, rsw(target + 2) - oy); ww(v + 4, rsw(target + 4) - oz);
      mat_mul_vector(v, mat, rel);
      let angle = polarAngle(rsw(rel), rsw(rel + 4), matMulAx(mat, v));
      if (!opp.car_slidingFlag && abs16(angle) > 0x100) nextWaypoint(opp); // waypoint behind
      angle = opp.car_sumSurfFrontWheels === 0 ? 0 : Math.max(-0x41, Math.min(0x41, angle));
      const steer = opp.car_steeringAngle;
      if (s16(angle < steer ? steer - angle : angle - steer) > steerStep) opp.car_steeringAngle = angle < steer ? steer - steerStep : steer + steerStep;
      else opp.car_steeringAngle = angle;
    } else {
      let retried = opp.car_36MwhlAngle !== 0 || state.game_inputmode === 2;
      let advance = waypointDist() < 200;
      let angle;
      for (;;) {
        if (advance) nextWaypoint(opp);
        pickTarget(mat, sum => sum >> 1);
        ww(v, rsw(target) - ox);
        ww(v + 2, rsw(target + 2) === -1 ? 0 : rsw(target + 2) - oy);
        ww(v + 4, rsw(target + 4) - oz);
        mat_mul_vector(v, mat, rel);
        angle = polarAngle(rsw(rel), rsw(rel + 4), matMulAx(mat, v));
        if (!opp.car_slidingFlag && abs16(angle) > 0x100) nextWaypoint(opp); // waypoint behind
        if (angle <= 0x41 && angle >= -0x41) break;
        if (!retried) { retried = true; advance = true; continue; } // too sharp: try the next one
        angle = angle > 0 ? 0x41 : -0x41;
        break;
      }
      if (opp.car_sumSurfFrontWheels === 0) angle = 0;
      const steer = opp.car_steeringAngle;
      if (abs16(s16(angle - steer)) > steerStep) opp.car_steeringAngle = angle < steer ? steer - steerStep : steer + steerStep;
      else opp.car_steeringAngle = angle;
    }

    let pedal = 0; // update_car_speed: 1 accelerate, 2 brake
    if (opp.car_sumSurfRearWheels) {
      if (opp.car_crashBmpFlag) pedal = 2;
      else if (opp.car_36MwhlAngle) {
        const d = brakeStep << 9;
        if (d > opp.car_speed2) { opp.car_speed2 = 0; opp.car_36MwhlAngle = 0; } else opp.car_speed2 = opp.car_speed2 - d;
      } else if (opp.car_demandedGrip > opp.car_surfacegrip_sum) pedal = 2;
      else {
        const speed = state.game_inputmode === 2 ? 0x4000 : rb(state.$field_3F9) << 8;
        if (u16(speed - 0x100) > opp.car_speed) pedal = 1;
        else if (u16(speed + 0x300) < opp.car_speed) pedal = 2;
      }
    }
    call.update_car_speed(pedal, 1, opp.addr, A.simd_opponent);
    call.update_grip(opp.addr, A.simd_opponent, 0);
    call.update_player_state(opp.addr, A.simd_opponent, pl.addr, A.simd_player, 1);

    if (!opp.car_crashBmpFlag) {
      // Heading error to the waypoint, for the car's steering.
      ww(v, rsw(w) - pos6(opp.car_posWorld1.lx));
      ww(v + 2, rsw(w + 2) - pos6(opp.car_posWorld1.ly));
      ww(v + 4, rsw(w + 4) - pos6(opp.car_posWorld1.lz));
      mat = mat_rot_zxy(opp.car_rotate.z, opp.car_rotate.y, opp.car_rotate.x, 1);
      mat_mul_vector(v, mat, rel);
      const z = s16(-rsw(rel));
      opp.field_48 = polarAngle(z, rsw(rel + 4), z) & 0x3ff;
    }
    if (opp.field_CD) {
      // Lap done: finished once past the start line.
      const dz = s16(rw(A.trackcenterpos + s8(U.startrow2) * 2) - pos6(opp.car_posWorld1.lz));
      const dx = s16(rw(A.trackcenterpos2 + s8(U.startcol2) * 2) - pos6(opp.car_posWorld1.lx));
      if (s16(multiply_and_scale(cos_fast(G.track_angle), dz) + multiply_and_scale(sin_fast(G.track_angle), dx)) < 0) {
        call.update_crash_state(3, 1);
      }
    }
  });
}

export const do_opponent_op = () => call.opponent_op();

provide({ track_setup, load_opponent_data, init_plantrak, opponent_op, do_opponent_op });
export const PORTS = ['track_setup', 'load_opponent_data', 'init_plantrak', 'opponent_op', 'do_opponent_op'];
