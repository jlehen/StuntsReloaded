// Track surface and collision lookup, ported from the original asm (seg003/seg004, plane_rotate_op
// in seg001). build_track_object finds what lies under a world position: the track element (or
// terrain) and the plane of its surface, the surface type, and the wall the car would hit when
// moving to the next position. Its results are globals read by update_player_state:
//   planindex / current_planptr  plane index (planindex*4 + element orientation) into the 'plan'
//                                resource; 0 is flat ground. Planes are PLANE structs (math.js).
//   terrainHeight                base height of the tile (hill 450) plus a small offset (see end).
//   current_surf_type            1..3 track surfaces (asphalt, dirt, ice: ss_surfaceType + 1),
//                                4 grass, 5 water.
//   wallindex (-1: none)         index into the 'wall' resource (6 bytes: angle, x, z), placed
//                                with wallStartX/Z, wallOrientation, wallHeight, elRdWallRelated.
//   byte_4392C                   0 while above a ramp/elevated deck, so the deck edges are open.
//   corkFlag                     inside a corkscrew.
// Element coordinates: the position relative to the element center, rotated so the element is in
// its reference orientation (ss_rotY = 0). Multi-tile elements are centered on their shared tile
// edge or corner.
import { A, G, rb, rw, rsw, ww, s8, s16, farptrAt, frame, alloca } from './mem.js';
import { TRACKOBJECT, state } from './structs.js';
import {
  sin_fast, cos_fast, polarAngle, polarRadius2D, polarRadius3D, multiply_and_scale,
  mat_mul_vector, mat_mul_vector2, mat_invert, mat_rot_y, mat_rot_zxy,
} from './math.js';
import { call, provide } from './calls.js';

const GRASS = 4, WATER = 5;
const tbl = (label, i) => rsw(label + 2 * i); // entry of a word table in DGROUP
const trkObj = elem => new TRACKOBJECT(A.trkObjectList + 14 * elem);
const elemAt = off => rb(farptrAt(A.td14_elem_map_main, off));
const terrAt = off => rb(farptrAt(A.td15_terr_map_main, off));
const abs16 = v => (v < 0 ? s16(-v) : v);
// Signed distance of (x, z) from the line through the origin with direction angle a.
const lineDist = (a, x, z) => s16(multiply_and_scale(sin_fast(a), z) + multiply_and_scale(cos_fast(a), x));
// a * b / c with the C runtime's long multiply/divide (__aFlmul, __aFldiv); low word of the result.
function lmuldiv(a, b, c) {
  if (c === 0) throw new Error('divide by zero');
  return s16(Math.trunc((a * b) / c));
}
// Linear interpolation of the bound table pair b0/b1 at z within the z range z0/z1, entry i.
function lerpBound(z0, z1, b0, b1, i, z) {
  const zlo = tbl(z0, i);
  return s16(lmuldiv(s16(tbl(b1, i) - tbl(b0, i)), s16(z - zlo), s16(tbl(z1, i) - zlo)) + tbl(b0, i));
}
// Tube cross-section sector (pipes, cork l/r) from the lateral offset and the height: 0 bottom,
// 1..5 up the left side, 6 top, 7..11 down the right side.
function tubeSector(vx, absX, h) {
  const upper = h > 0x97;
  if (h > 0x58 && !upper) return vx < 0 ? 3 : 9;
  if (absX < 0x1f) return upper ? 6 : 0;
  if (vx < -0x54) return upper ? 4 : 2;
  if (vx < 0) return upper ? 5 : 1;
  if (vx > 0x54) return upper ? 8 : 10;
  return upper ? 7 : 11;
}

// pos, nextPos: VECTORs (world coordinates, 1 unit = 1/1024 tile) of the wheel now and next.
export function build_track_object(pos, nextPos) {
  G.planindex = 0;
  G.wallindex = -1;
  G.wallHeight = -12;
  G.elRdWallRelated = -1000;
  G.corkFlag = 0;
  G.current_surf_type = GRASS;
  G.byte_4392C = 1;
  let wallOrientMod = 0, elemOrient = 0;
  G.terrainHeight = 0;
  const px = rsw(pos), pz = rsw(pos + 4);
  const col = px >> 10, row = pz >> 10;

  if (col >= 0 && col <= 29 && row >= 0 && row <= 29) {
    G.elem_xCenter = tbl(A.trackcenterpos2, col);
    G.elem_zCenter = tbl(A.terraincenterpos, row);
    const tileTerr = terrAt(tbl(A.trackrows, row) + col);
    if (tileTerr === 1) G.current_surf_type = WATER;
    else if (tileTerr >= 2 && tileTerr <= 5) { // coast: water beyond the diagonal shore line
      const a = [0x80, -0x280, -0x180, -0x80][tileTerr - 2];
      if (lineDist(a, s16(px - G.elem_xCenter), s16(pz - G.elem_zCenter)) < 0) G.current_surf_type = WATER;
    } else if (tileTerr === 6) G.terrainHeight = tbl(A.hillHeightConsts, 1);

    let tileElem = elemAt(tbl(A.terrainrows, row) + col);
    if (tileElem !== 0) {
      // Filler tiles (0xFD..0xFF) of a multi-tile element point to its owner tile.
      let ownerRow = row, ownerCol = col;
      if (tileElem >= 0xfd) {
        if (tileElem !== 0xff) ownerRow++;
        if (tileElem !== 0xfe) ownerCol--;
        tileElem = elemAt(tbl(A.terrainrows, ownerRow) + ownerCol);
      }
      const multi = trkObj(tileElem).ss_multiTileFlag;
      if (multi & 1) G.elem_zCenter = tbl(A.terrainpos, ownerRow);
      if (multi & 2) G.elem_xCenter = tbl(A.trackpos2, ownerCol + 1);
      if (tileElem !== 0 && tileTerr >= 7 && tileTerr < 0xb) tileElem = call.subst_hillroad_track(tileTerr, tileElem) & 0xff;
      elemOrient = trkObj(tileElem).ss_rotY;
      wallOrientMod = elementSurface(pos, nextPos, tileElem);
    }

    if (tileTerr >= 7) { // hill slopes: 7..0xA slope, 0xB..0xE and 0xF..0x12 corners, 4 orientations each
      let x = s16(px - tbl(A.trackcenterpos2, col)), z = s16(pz - tbl(A.terraincenterpos, row));
      if (tileTerr <= 0x12) {
        switch ((tileTerr - 7) & 3) {
          case 0: elemOrient = 0; break;
          case 1: elemOrient = 0x300; [x, z] = [z, s16(-x)]; break;
          case 2: elemOrient = 0x200; [x, z] = [s16(-x), s16(-z)]; break;
          case 3: elemOrient = 0x100; [x, z] = [s16(-z), x]; break;
        }
      }
      if (tileTerr <= 0xa) { if (G.planindex === 0) G.planindex = 3; }
      else if (tileTerr <= 0xe) { if (lineDist(-0x80, x, z) < 0) G.planindex = 4; }
      else if (tileTerr <= 0x12) {
        if (lineDist(-0x80, x, z) > 0) G.planindex = 5;
        else G.terrainHeight = 0x1c2;
      }
    }
  }

  if (G.planindex > 0) {
    G.planindex = G.planindex << 2;
    if (elemOrient === 0x100) G.planindex += 3;
    else if (elemOrient === 0x200) G.planindex += 2;
    else if (elemOrient === 0x300) G.planindex += 1;
  }
  ww(A.current_planptr, rw(A.planptr) + 34 * G.planindex);
  ww(A.current_planptr + 2, rw(A.planptr + 2));
  // Grass is slightly bumpy; other surfaces sit 2 units up.
  if (G.current_surf_type === GRASS) G.terrainHeight += ((pz ^ px) >> 8) & 1;
  else G.terrainHeight += 2;

  const wi = G.wallindex;
  if (wi < 0) return;
  G.wallOrientation = (elemOrient + wallOrientMod - rsw(farptrAt(A.wallptr, 6 * wi))) & 0x3ff;
  const wx = rsw(farptrAt(A.wallptr, 6 * wi + 2)), wz = rsw(farptrAt(A.wallptr, 6 * wi + 4));
  switch (elemOrient) {
    case 0: G.wallStartX = wx; G.wallStartZ = wz; break;
    case 0x100: G.wallStartX = wz; G.wallStartZ = -wx; break;
    case 0x200: G.wallStartX = -wx; G.wallStartZ = -wz; break;
    case 0x300: G.wallStartX = -wz; G.wallStartZ = wx; break;
  }
  G.wallStartX += G.elem_xCenter;
  G.wallStartZ += G.elem_zCenter;
}

// The element part of build_track_object (the bto_branches jump table on ss_physicalModel).
// Sets planindex, surface and wall globals; returns the wall orientation modifier (0 or 0x200).
function elementSurface(pos, nextPos, tileElem) {
  const obj = trkObj(tileElem);
  const xc = G.elem_xCenter, zc = G.elem_zCenter;
  let vx = s16(rsw(pos) - xc), vz = s16(rsw(pos + 4) - zc);
  let nvx = s16(rsw(nextPos) - xc), nvz = s16(rsw(nextPos + 4) - zc);
  switch (obj.ss_rotY) {
    case 0x100: [vx, vz, nvx, nvz] = [s16(-vz), vx, s16(-nvz), nvx]; break;
    case 0x200: [vx, vz, nvx, nvz] = [s16(-vx), s16(-vz), s16(-nvx), s16(-nvz)]; break;
    case 0x300: [vx, vz, nvx, nvz] = [vz, s16(-vx), nvz, s16(-nvx)]; break;
  }
  let surfaceType = s8(obj.ss_surfaceType + 1);
  if (surfaceType < 1) surfaceType = 1;
  const absX = abs16(vx), absZ = abs16(vz);
  const h = s16(rsw(pos + 2) - G.terrainHeight);
  let wallOrientMod = 0;

  const pave = () => { G.current_surf_type = surfaceType; };
  const sideWall = v => { G.wallindex = v < 0 ? 0x64 : 0x65; }; // guard rail left/right
  const corner = (x, z, inner, outer) => { const r = polarRadius2D(x, z); if (r > inner && r < outer) pave(); };
  const largeCorner = () => corner(s16(vx + 0x400), s16(vz + 0x400), 0x588, 0x678);
  const sharpCorner = () => corner(s16(vx + 0x200), s16(vz + 0x200), 0x188, 0x278);
  // Segment 0..17 of a banked/elevated corner, from the angle around the corner center.
  const cornerSegment = () => {
    const a = polarAngle(s16(vx + 0x400), s16(vz + 0x400), s16(vx + 0x400)) & 0xff;
    return 0x11 - (s16(a * 18) >> 8);
  };
  // Ramp and solid ramp top (plane 3). Rails on the sides; open edges while byte_4392C is 0.
  const rampTop = () => {
    if (abs16(nvx) < 0x78) {
      G.planindex = 3;
      pave();
      if (G.wallindex === -1 && vz >= 0 && absX >= 0x78) {
        G.wallHeight = 0x2a;
        G.elRdWallRelated = -12;
        sideWall(vx);
      }
    } else if (G.byte_4392C !== 0 && absX <= 0x78) {
      G.planindex = 3;
      if (G.wallindex === -1) { wallOrientMod = 0x200; sideWall(vx); }
    }
  };
  // Elevated road deck (plane 2) with rails; end walls 0x67/0x68 when not on the deck already.
  const solidRoad = () => {
    if (abs16(nvx) <= 0x78) {
      G.planindex = 2;
      pave();
      if (G.byte_4392C !== 0) {
        if (nvz >= 0x1dc) G.wallindex = 0x67;
        else if (nvz <= -0x1dc) G.wallindex = 0x68;
      }
      if (absX >= 0x78) { G.wallHeight = 0x2a; sideWall(vx); }
    } else if (G.byte_4392C !== 0 && absX <= 0x78) {
      G.planindex = 2;
      G.wallHeight = 0x2a;
      wallOrientMod = 0x200;
      sideWall(nvx);
    }
  };
  // Highway median walls (planindex 1 set by the caller).
  const highwayWalls = () => {
    if (nvx <= -0x78) G.wallindex = 0xbc;
    else if (nvx >= 0x78) G.wallindex = 0xba;
  };
  // Bank road entrance: flat, then banking in 4 triangulated steps, then fully banked.
  const bankEntrance = (plane0, right, edgeAngle) => {
    if (absX > 0x78) return;
    if (!right && nvx <= -0x78) { wallOrientMod = 0x200; G.wallindex = 0x64; }
    else if (right && nvx >= 0x78) { wallOrientMod = 0x200; G.wallindex = 0x65; }
    pave();
    if (vz < -0x14e) { G.planindex = plane0; return; }
    if (vz >= 0x14e) { G.planindex = plane0 + 9; return; }
    let part;
    if (vz < -0xa8) { G.planindex = plane0 + 1; part = 0; }
    else if (vz < 0) { G.planindex = plane0 + 3; part = 1; }
    else if (vz < 0xa8) { G.planindex = plane0 + 5; part = 2; }
    else { G.planindex = plane0 + 7; part = 3; }
    if (lineDist(edgeAngle, vx, s16(vz - tbl(A.bkRdEntr_triang_zAdjust, part))) > 0) G.planindex++;
  };
  // Corkscrew up/down (x mirrored for the left-hand one): ramp in, helix of 24 planes, ramp out.
  const corkUpDown = (x, plane0, wallOuter, wallInner) => {
    G.corkFlag = 1;
    if (vz < 0 && h < 0x64 && x > 0) {
      if (x < 0x278 && x > 0x188) { pave(); G.planindex = plane0; }
      return;
    }
    if (vz > 0 && h > 0x15e && x < 0x2b4 && x > 0x14c) {
      G.wallHeight = 0x2a;
      G.elRdWallRelated = -12;
      G.wallindex = (x > 0x200 ? wallOuter : wallInner) + 0x18;
      pave();
      G.planindex = plane0 + 0x19;
      G.byte_4392C = 0;
      return;
    }
    const r = polarRadius2D(x, vz);
    if (r <= 0x14c || r >= 0x2b4) return;
    const seg = s16(((0x100 - polarAngle(x, vz, r)) & 0x3ff) * 0x18) >> 10;
    G.planindex = plane0 + seg + 1;
    pave();
    G.byte_4392C = 0;
    G.wallHeight = 0x2a;
    G.elRdWallRelated = -12;
    const d = s16(r - 0x200);
    if (d > 0x5a) G.wallindex = wallOuter + seg;
    else if (d < -0x5a) G.wallindex = wallInner + seg;
  };
  // Buildings: a box; the wall is the side the next position crosses.
  const box = (inside, height, x0, x1, z0, z1, wz0, wz1, wx0, wx1) => {
    if (!inside) return;
    G.wallHeight = height;
    if (nvz <= z0) G.wallindex = wz0;
    else if (nvz >= z1) G.wallindex = wz1;
    else if (nvx <= x0) G.wallindex = wx0;
    else if (nvx >= x1) G.wallindex = wx1;
  };

  switch (obj.ss_physicalModel) {
    case 0x00: // start/finish line
      if (state.game_inputmode === 0 && vx > 0) {
        if (vz < -0x17c) G.planindex = 0x83;
        else if (vz < -0x12c) G.planindex = 0x84;
      }
    // fallthrough
    case 0x01: // road
      if (absX < 0x78) pave();
      break;
    case 0x02: sharpCorner(); break;
    case 0x03: largeCorner(); break;
    case 0x05: // chicane A: mirrored chicane B
      vx = s16(-vx);
    // fallthrough
    case 0x04: // chicane B: two opposite large-corner arcs
      pave();
      if (vx > 0) { vz = s16(-vz); vx = s16(-vx); }
      largeCorner();
      break;
    case 0x06: // sharp split A
      if (absX < 0x78) pave(); else sharpCorner();
      break;
    case 0x07: // sharp split B
      if (absX < 0x78) pave();
      else corner(s16(0x200 - vx), s16(vz + 0x200), 0x188, 0x278);
      break;
    case 0x08: // split A
      if (vx >= 0x188 && vx <= 0x278) pave(); else largeCorner();
      break;
    case 0x09: // split B
      if (vx >= -0x278 && vx <= -0x188) pave();
      else corner(s16(0x400 - vx), s16(vz + 0x400), 0x588, 0x678);
      break;
    case 0x0a: { // highway entrance: the road widens along z (tables highEntr*)
      let i = 0;
      while (tbl(A.highEntrZBounds1, i) < vz) i++;
      const Z0 = A.highEntrZBounds0, Z1 = A.highEntrZBounds1;
      const inn0 = tbl(A.highEntrXInnBounds0, i), out0 = tbl(A.highEntrXOutBounds0, i);
      const inner = tbl(A.highEntrXInnBounds1, i) === inn0 ? inn0 : lerpBound(Z0, Z1, A.highEntrXInnBounds0, A.highEntrXInnBounds1, i, vz);
      const outer = tbl(A.highEntrXOutBounds1, i) === out0 ? out0 : lerpBound(Z0, Z1, A.highEntrXOutBounds0, A.highEntrXOutBounds1, i, vz);
      if (absX > inner && absX < outer) { pave(); break; }
      if (vz < 0 || absX > 0x78) break;
      G.planindex = 1;
      if (vz < 0x14e) G.wallindex = nvx >= 0 ? 0xbb : 0xbd;
      else highwayWalls();
      break;
    }
    case 0x0b: // highway: carriageways at 0x78 < |x| <= 0x168, raised median (plane 1) with walls
      if (absX > 0x168) break;
      if (absX > 0x78) { pave(); break; }
      G.planindex = 1;
      highwayWalls();
      break;
    case 0x0c: // crossroad
      if (absX < 0x78 || absZ < 0x78) pave();
      break;
    case 0x10: // ramp
      if (vz > 0) G.byte_4392C = 0;
      else if (nvz >= 0) G.wallindex = 0x66;
      rampTop();
      break;
    case 0x11: // solid ramp
      if (nvz >= 0x1dc) G.wallindex = 0x67;
      rampTop();
      break;
    case 0x12: case 0x13: // elevated road, elevated span
      if (h > 0x186) { G.byte_4392C = 0; solidRoad(); }
      break;
    case 0x14: solidRoad(); break;
    case 0x15: { // elevated corner
      if (h <= 0x186) break;
      const tr = s16(polarRadius2D(s16(vx + 0x400), s16(vz + 0x400)) - 0x600);
      if (tr <= -0x96 || tr >= 0x96) break;
      pave();
      G.planindex = 2;
      G.byte_4392C = 0;
      if (tr >= -0x6c && tr <= 0x6c) break;
      const seg = cornerSegment();
      G.wallHeight = 0x2a;
      G.elRdWallRelated = -12;
      G.wallindex = seg + (tr < 0 ? 0x69 : 0x7b);
      break;
    }
    case 0x16: // overpass: road below, deck above
      if (h > 0x186) { G.byte_4392C = 0; solidRoad(); }
      else if (absZ <= 0x78) pave();
      break;
    case 0x17: bankEntrance(0x19, true, 0xa0); break; // bank road entrance B
    case 0x18: bankEntrance(0x23, false, -0x2a0); break; // bank road entrance A
    case 0x19: // banked road
      if (absX > 0x78) break;
      pave();
      G.planindex = 6;
      if (nvx >= 0x78) { wallOrientMod = 0x200; G.wallindex = 0x65; }
      break;
    case 0x1a: { // banked corner
      const tr = s16(polarRadius2D(s16(vx + 0x400), s16(vz + 0x400)) - 0x600);
      if (tr <= -0x78 || tr >= 0x7e) break;
      const seg = cornerSegment();
      G.planindex = seg + 7;
      pave();
      if (tr <= 0x66) break;
      wallOrientMod = 0x200;
      G.wallindex = seg + 0x7b;
      G.byte_4392C = 0;
      break;
    }
    case 0x1b: loop(vx, vz, h, pave); break;
    case 0x1c: { // tunnel: walls inside, roof on top
      const nh = s16(rsw(nextPos + 2) - G.terrainHeight);
      if (h >= 0x90 || nh >= 0x90) {
        if (absX < 0x10e) { pave(); G.planindex = 0x85; }
        break;
      }
      if (absX < 0x78) pave();
      if (vx >= 0x78 && vx <= 0x10e) {
        G.wallHeight = 0x90;
        if (nvz <= -0x200) G.wallindex = 0x9a;
        else if (nvz >= 0x200) G.wallindex = 0x99;
        else if (nvx <= 0x78) G.wallindex = 0x98;
        else if (nvx >= 0x10e) G.wallindex = 0x96;
      } else if (vx <= -0x78 && vx >= -0x10e) {
        G.wallHeight = 0x90;
        if (nvz <= -0x200) G.wallindex = 0x9a;
        else if (nvz >= 0x200) G.wallindex = 0x99;
        else if (nvx >= -0x78) G.wallindex = 0x97;
        else if (nvx <= -0x10e) G.wallindex = 0x95;
      }
      break;
    }
    case 0x1d: { // pipe entrance
      if (abs16(nvx) >= 0x73 && absX <= 0xa4) { G.wallHeight = 0x97; G.wallindex = nvx > 0 ? 0x9f : 0xa0; break; }
      if (absX >= 0x73 || h >= 0xab) break;
      pave();
      if (absX < 0x1f) { G.planindex = 0x46; break; }
      let offX, a;
      if (vx < -0x54) { G.planindex = 0x49; offX = -0x64; a = -5; }
      else if (vx < 0) { G.planindex = 0x47; offX = -0x39; a = -8; }
      else if (vx > 0x54) { G.planindex = 0x4d; offX = 0x64; a = 5; }
      else { G.planindex = 0x4b; offX = 0x39; a = 8; }
      if (lineDist(a, s16(vx - offX), vz) < 0) G.planindex++;
      break;
    }
    case 0x1e: case 0x1f: { // pipe, half-pipe (0x1F: flat bottom in the middle)
      if (abs16(nvx) >= 0xa4 && absX <= 0xa4) { G.wallHeight = 0x97; G.wallindex = nvx > 0 ? 0x9b : 0x9c; break; }
      if (absX >= 0xa4 || h >= 0x109) break;
      if (absX < 0x82) pave();
      if (obj.ss_physicalModel === 0x1f && h <= 0x97 && absX <= 0x54 && absZ <= 0x4b) {
        G.planindex = 0x45;
        if (nvz <= -0x4b) G.wallindex = 0x9d;
        else if (nvz >= 0x4b) G.wallindex = 0x9e;
        break;
      }
      G.planindex = 0x39 + tubeSector(vx, absX, h);
      break;
    }
    case 0x20: corkUpDown(s16(-vx), 0x4f, 0x32, 0x4b); break; // cork u/d A (left-handed)
    case 0x21: corkUpDown(vx, 0x69, 0, 0x19); break; // cork u/d B
    case 0x22: // slalom: two posts
      if (absX < 0x78) pave();
      if (vx >= 0x17 && vx <= 0x61 && vz > -0x10f && vz < -0xf1) {
        G.wallHeight = 0x2a;
        if (nvz < -0x10f) G.wallindex = 0x91;
        else if (nvz > -0xf1) G.wallindex = 0x92;
        else if (nvx < 0x17) G.wallindex = 0x94;
        else if (nvx > 0x61) G.wallindex = 0x93;
      } else if (vx <= -0x17 && vx >= -0x61 && vz < 0x10f && vz > 0xf1) {
        G.wallHeight = 0x2a;
        if (nvz > 0x10f) G.wallindex = 0x8d;
        else if (nvz < 0xf1) G.wallindex = 0x8e;
        else if (nvx > -0x17) G.wallindex = 0x8f;
        else if (nvx < -0x61) G.wallindex = 0x90;
      }
      break;
    case 0x23: { // cork left/right: a tube twisting along z
      if (absX >= 0x96 || h >= 0x109) break;
      pave();
      const sector = tubeSector(vx, absX, h);
      if (sector !== 0 && tbl(A.corkLR_negZBound, sector) < vz && tbl(A.corkLR_posZBound, sector) > vz) G.planindex = sector + 0x39;
      if (G.planindex === 0 && absZ < 0x200) {
        G.wallindex = 0xb9;
        G.corkFlag = 1;
        G.wallHeight = 0x75;
      }
      break;
    }
    case 0x41: box(absX <= 0x96 && absZ <= 0x96, 0x1a9, -0x96, 0x96, -0x96, 0x96, 0xa1, 0xa2, 0xa4, 0xa3); break; // barn
    case 0x42: box(vx >= -0xc8 && vx <= 0x104 && absZ <= 0x50, 0xe6, -0xc8, 0x104, -0x50, 0x50, 0xa5, 0xa8, 0xa6, 0xa7); break; // gas station
    case 0x43: box(absX <= 0xb4 && absZ <= 0x64, 0xf8, -0xb4, 0xb4, -0x64, 0x64, 0xa9, 0xac, 0xab, 0xaa); break; // Joe's
    case 0x44: box(absX <= 0xc8 && absZ <= 0xc8, 0x226, -0xc8, 0xc8, -0xc8, 0xc8, 0xad, 0xae, 0xaf, 0xb0); break; // office
    case 0x45: box(absX <= 0x72 && absZ <= 0x72, 0x1ef, -0x72, 0x72, -0x72, 0x72, 0xb4, 0xb2, 0xb1, 0xb3); break; // windmill
    case 0x46: box(vx >= -0xaa && vx <= 0x104 && absZ <= 0x6e, 0xe6, -0xaa, 0x104, -0x6e, 0x6e, 0xb5, 0xb8, 0xb7, 0xb6); break; // ship
  }
  return wallOrientMod;
}

// Loop: the ring (planes 0x2D.. for the first half, 0x33.. for the second, mirrored) and the base.
// Ring segment i spans z from loopSurface_ZBounds0[i] to ZBounds1[i] (0..2 going up, 3..5 upside
// down); the track's inner x edge moves from XBounds0[i] to XBounds1[i], and it is 0x190 wide.
function loop(vx, vz, h, pave) {
  const back = vz < 0;
  const plane0 = back ? 0x33 : 0x2d;
  const effX = back ? s16(-vx) : vx, effZ = back ? s16(-vz) : vz;
  const maxZ = rsw(A.loopSurface_maxZ);
  let z = effZ, ring = true;
  if (effZ > s16(maxZ - 1)) {
    if (effZ > s16(maxZ + 100)) ring = false;
    else z = s16(maxZ - 1);
  }
  if (ring) {
    let i = 0;
    while (tbl(A.loopSurface_ZBounds1, i) < z) i++;
    const upper = h > 0x20c;
    if (upper) i = 5 - i;
    let hit = false;
    if (upper || i <= 1 || h >= 0x64) {
      const x0 = tbl(A.loopSurface_XBounds0, i), x1 = tbl(A.loopSurface_XBounds1, i);
      if (x0 <= effX && s16(x1 + 0x190) >= effX) {
        if (x1 < effX && s16(x0 + 0x190) > effX) hit = true;
        else if (upper || x1 !== x0) {
          const z0 = tbl(A.loopSurface_ZBounds0, i);
          const edge = s16(x0 + lmuldiv(s16(x0 - x1), s16(z0 - z), s16(tbl(A.loopSurface_ZBounds1, i) - z0)));
          hit = edge < effX && s16(edge + 0x190) > effX;
        }
      }
    }
    if (hit) {
      G.planindex = plane0 + i;
      pave();
      G.byte_4392C = 0;
      return;
    }
    if (upper) return;
  }
  // Base: the flat entry/exit road between an inner and an outer edge, interpolated along z.
  let i = 0;
  while (tbl(A.loopBase_ZBounds1, i) < effZ) i++;
  const inner = lerpBound(A.loopBase_ZBounds0, A.loopBase_ZBounds1, A.loopBae_InnXBounds0, A.loopBase_InnXBounds1, i, effZ);
  const outer = lerpBound(A.loopBase_ZBounds0, A.loopBase_ZBounds1, A.loopBase_OutXBounds0, A.loopBase_OutXBounds1, i, effZ);
  if (effX >= inner && effX <= outer) pave();
}

// Hill road variant (0xB6..0xC5) of a road element on slope terrain 7..0xA, else 0.
const HILL_ROADS = [
  [[0x04], [0x0e], [0x18], [0x27, 0x3b, 0x62]],
  [[0x05], [0x0f], [0x19], [0x24, 0x38, 0x5f]],
  [[0x04], [0x0e], [0x18], [0x26, 0x3a, 0x61]],
  [[0x05], [0x0f], [0x19], [0x25, 0x39, 0x60]],
];
export function subst_hillroad_track(terr, elem) {
  const t = (terr & 0xff) - 7;
  if (t < 0 || t > 3) return 0;
  const k = HILL_ROADS[t].findIndex(codes => codes.includes(elem & 0xff));
  return k < 0 ? 0 : 0xb6 + t + 4 * k;
}

// Obstacle points (slalom posts, trees, pillars...) of the element at (col, row), with row
// counted as in trackrows. Writes world-space VECTORs to out; returns their count.
export function bto_auxiliary1(col, row, out) {
  col = s16(col);
  row = s16(row);
  const elemIdx = (r, c) => elemAt(tbl(A.trackrows, r) + c);
  const multi = e => trkObj(e).ss_multiTileFlag;
  let elem = elemIdx(row, col);
  if (elem === 0) return 0;
  let x = tbl(A.trackcenterpos2, col), z = tbl(A.trackcenterpos, row);
  // Multi-tile centers; the 0xFD/0xFE fillers use trackpos[row + 1] (sic).
  switch (elem) {
    case 0xfd:
      elem = elemIdx(row - 1, col - 1);
      if (multi(elem) & 1) z = tbl(A.trackpos, row + 1);
      if (multi(elem) & 2) x = tbl(A.trackpos2, col);
      break;
    case 0xfe:
      elem = elemIdx(row - 1, col);
      if (multi(elem) & 1) z = tbl(A.trackpos, row + 1);
      if (multi(elem) & 2) x = tbl(A.trackpos2, col + 1);
      break;
    case 0xff:
      elem = elemIdx(row, col - 1);
      if (multi(elem) & 1) z = tbl(A.trackpos, row);
      if (multi(elem) & 2) x = tbl(A.trackpos2, col);
      break;
    default:
      if (multi(elem) & 1) z = tbl(A.trackpos, row);
      if (multi(elem) & 2) x = tbl(A.trackpos2, col + 1);
  }
  const obj = trkObj(elem);
  const pm = obj.ss_physicalModel;
  let count = 0, pts = 0;
  if (pm === 0x0b || (pm >= 0x47 && pm <= 0x4a)) { count = 1; pts = A.unk_3E640; }
  else if (pm === 0x12) { count = 8; pts = A.unk_3E646; }
  else if (pm === 0x20) { count = 2; pts = A.unk_3E682; }
  else if (pm === 0x21) { count = 2; pts = A.unk_3E68E; }
  else if (pm === 0x22) { count = 4; pts = A.unk_3E69A; }
  else if (pm === 0x23) { count = 2; pts = A.unk_3E676; }
  if (!count) return 0;
  const y = terrAt(tbl(A.terrainrows, row) + col) === 6 ? tbl(A.hillHeightConsts, 1) : 0;
  const orient = obj.ss_rotY;
  for (let i = 0; i < count; i++) {
    const p = pts + 6 * i, o = out + 6 * i;
    let ox, oz;
    switch (orient) {
      case 0: ox = rsw(p); oz = rsw(p + 4); break;
      case 0x100: ox = rsw(p + 4); oz = -rsw(p); break;
      case 0x200: ox = -rsw(p); oz = -rsw(p + 4); break;
      case 0x300: ox = -rsw(p + 4); oz = rsw(p); break;
      default: continue;
    }
    ww(o, ox + x);
    ww(o + 2, rsw(p + 2) + y);
    ww(o + 4, oz + z);
  }
  return count;
}

// Rotates vec_unk2 into the current plane's frame: vec_planerotopresult (plane planindex_copy,
// or ground when -1), turned by the car heading relative to the plane.
export function plane_rotate_op() {
  frame(() => {
    const idx = G.planindex_copy;
    const v = alloca(6);
    if (idx === -1) {
      const a = G.pState_f36Mminf40sar2;
      if (a === 0) { mat_mul_vector(A.vec_unk2, A.mat_unk, A.vec_planerotopresult); return; }
      if (a !== G.f36f40_whlData) { mat_rot_y(A.mat_unk2, -a); G.f36f40_whlData = a; }
      mat_mul_vector(A.vec_unk2, A.mat_unk2, v);
      mat_mul_vector(v, A.mat_unk, A.vec_planerotopresult);
      return;
    }
    const plane = farptrAt(A.planptr, 34 * idx), planeRot = farptrAt(A.planptr, 34 * idx + 16);
    let angle;
    if (rsw(plane + 2) === G.pState_minusRotate_x_2 && rsw(plane) === G.pState_minusRotate_z_2) {
      angle = G.pState_minusRotate_y_2;
    } else {
      const v8 = alloca(6), rot = alloca(18), inv = alloca(18);
      mat_mul_vector(A.vec_unk2, A.mat_unk, v8);
      for (let i = 0; i < 18; i += 2) ww(rot + i, rw(farptrAt(A.planptr, 34 * idx + 16 + i)));
      mat_invert(rot, inv);
      mat_mul_vector(v8, inv, v);
      angle = polarAngle(s16(-rsw(v)), rsw(v + 4), s16(-rsw(v)));
    }
    angle = s16(angle + G.pState_f36Mminf40sar2);
    if (angle === 0) { mat_mul_vector2(A.vec_unk2, planeRot, A.vec_planerotopresult); return; }
    if (G.word_3BE16 !== angle) { mat_rot_y(A.mat_planetmp, -angle); G.word_3BE16 = angle; }
    mat_mul_vector(A.vec_unk2, A.mat_planetmp, v);
    mat_mul_vector2(v, planeRot, A.vec_planerotopresult);
  });
}

// Collision test of two oriented boxes. coll: {halfWidth x, height y, halfLength z, radius};
// world: position VECTOR then rotation (z, x, y angles). Returns 1 if a bottom corner of either
// box lies inside the other.
export function car_car_coll_detect_maybe(pColl, pWorld, oColl, oWorld) {
  const radius = s16(rsw(pColl + 6) + rsw(oColl + 6));
  const dist = off => { const a = rsw(pWorld + off), b = rsw(oWorld + off); return a < b ? s16(b - a) : s16(a - b); };
  if (dist(0) > radius || dist(4) > radius || dist(2) > radius) return 0;
  return frame(() => {
    const d = alloca(6), v = alloca(6), corners = alloca(24);
    for (let k = 0; k < 6; k += 2) ww(d + k, rsw(pWorld + k) - rsw(oWorld + k));
    if ((polarRadius3D(d) & 0xffff) > (radius & 0xffff)) return 0;
    // The 4 bottom corners of box a in world space.
    const cornersOf = (coll, world) => {
      const m = mat_rot_zxy(s16(-rsw(world + 6)), s16(-rsw(world + 8)), s16(-rsw(world + 10)), 0);
      for (let i = 0; i < 4; i++) {
        ww(v, rsw(A.word_3BE04 + 2 * i) ? -rsw(coll) : rsw(coll));
        ww(v + 2, 0);
        ww(v + 4, rsw(A.word_3BE0C + 2 * i) ? -rsw(coll + 4) : rsw(coll + 4));
        mat_mul_vector(v, m, d);
        for (let k = 0; k < 6; k += 2) ww(d + k, rsw(d + k) + rsw(world + k));
        for (let k = 0; k < 6; k += 2) ww(corners + 6 * i + k, rsw(d + k));
      }
    };
    // Is one of the corners inside box b?
    const anyInside = (coll, world) => {
      const m = mat_rot_zxy(rsw(world + 6), rsw(world + 8), rsw(world + 10), 1);
      for (let i = 0; i < 4; i++) {
        for (let k = 0; k < 6; k += 2) ww(v + k, rsw(world + k) - rsw(corners + 6 * i + k));
        mat_mul_vector(v, m, d);
        const x = rsw(d), y = rsw(d + 2), z = rsw(d + 4), hw = rsw(coll), hl = rsw(coll + 4);
        if (y >= 0 && rsw(coll + 2) >= y && x >= s16(-hw) && x <= hw && s16(-hl) <= z && hl >= z) return true;
      }
      return false;
    };
    cornersOf(pColl, pWorld);
    if (anyInside(oColl, oWorld)) return 1;
    cornersOf(oColl, oWorld);
    return anyInside(pColl, pWorld) ? 1 : 0;
  });
}

provide({ build_track_object, bto_auxiliary1, plane_rotate_op, car_car_coll_detect_maybe, subst_hillroad_track });
export const PORTS = ['build_track_object', 'bto_auxiliary1', 'plane_rotate_op', 'car_car_coll_detect_maybe', 'subst_hillroad_track'];
