// Three.js rendering of the original shapes and track, using the original placement rules
// (restunts c/frame.c update_frame). Game axes: x east, y up, z north (left-handed); Three.js
// is right-handed, so z is mirrored: (x, y, z) -> (x, y, -z).
import * as THREE from '../vendor/three.module.js';
import { M, A, DS, rw, rsw, rb, rsb, farptr } from './mem.js';
import { call } from './calls.js';
import { sin_fast as sin, cos_fast as cos, multiply_and_scale as mulScale } from './math.js';
import { decompress, parseRes, parseShape3d, parsePalette, parseShape2d } from './res.js';
import { getFile } from './files.js';
import { addDetail, surfaceKind } from './fx.js';

export const ANGLE = Math.PI * 2 / 1024;
let palette, materialColor, materialPattern;

// Palette and material table (paint index -> palette color / pattern flag).
export function initMaterials() {
  palette = parsePalette(parseRes(decompress(getFile('SDMAIN.PVS'))));
  const n = (A.material_pattern_list - A.material_color_list) / 2;
  materialColor = [], materialPattern = [];
  for (let i = 0; i < n; i++) {
    materialColor.push(palette[rw(A.material_color_list + i * 2)]);
    materialPattern.push(rw(A.material_pattern_list + i * 2));
  }
}
export const paintColor = i => new THREE.Color(...(materialColor[i] ?? [255, 0, 255]).map(c => c / 255)).convertSRGBToLinear();

// Shape files -> parsed shapes by name.
const shapeCache = new Map();
export function loadShapes(file) {
  const res = parseRes(decompress(getFile(file)));
  const out = {};
  for (const [name, bytes] of res) out[name] = parseShape3d(bytes);
  return out;
}

const matBase = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
const matDecal = matBase.clone(); Object.assign(matDecal, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8 });
const matGlass = matBase.clone(); Object.assign(matGlass, { transparent: true, opacity: 0.45, roughness: 0.2, depthWrite: false });
const matTerrain = matBase.clone(); Object.assign(matTerrain, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 4 });
for (const m of [matBase, matDecal, matTerrain]) addDetail(m);
// Car bodies: same look as matBase until enhanced graphics adds a clear coat (fx.js).
export const matCar = new THREE.MeshPhysicalMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });

// Geometry buckets: accumulate triangles (already transformed) per material kind.
class Bucket {
  constructor() { this.pos = []; this.col = []; this.kind = []; }
  tri(a, b, c, color, kind = 0) {
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.col.push(color.r, color.g, color.b);
    this.kind.push(kind, kind, kind);
  }
  mesh(material) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('kind', new THREE.Float32BufferAttribute(this.kind, 1)); // surface kind (fx.js)
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, material);
    m.castShadow = m.receiveShadow = true;
    return m;
  }
}
export class Builder {
  constructor() { this.base = new Bucket(); this.decal = new Bucket(); this.glass = new Bucket(); this.terrain = new Bucket(); }
  // Adds a shape transformed by mat (THREE.Matrix4 in Three.js space), using paint slot.
  add(shape, mat, slot = 0, kind = null) {
    const v = shape.verts.map(([x, y, z]) => new THREE.Vector3(x, y, -z).applyMatrix4(mat).toArray());
    for (const p of shape.prims) {
      const paint = p.paints[slot < p.paints.length ? slot : 0];
      const color = paintColor(paint);
      const bucket = kind ? this[kind] : materialPattern[paint] ? this.glass : (p.flags & 2) ? this.decal : this.base;
      if (p.type >= 3 && p.type <= 10) {
        for (let i = 1; i + 1 < p.idx.length; i++) bucket.tri(v[p.idx[0]], v[p.idx[i]], v[p.idx[i + 1]], color, surfaceKind(paint));
      } else if (p.type === 11) { // sphere: center, point on surface
        sphere(bucket, v[p.idx[0]], v[p.idx[1]], color);
      } else if (p.type === 12) { // wheel: 6 verts, two rims (center, radius point, width point)
        wheel(bucket, v, p.idx, color);
      }
    }
  }
  group(base = matBase) {
    const g = new THREE.Group();
    for (const [k, m] of [['base', base], ['decal', matDecal], ['glass', matGlass], ['terrain', matTerrain]]) {
      const mesh = this[k].mesh(m);
      if (mesh) g.add(mesh);
    }
    return g;
  }
}
function sphere(bucket, c, s, color) {
  const r = Math.hypot(s[0] - c[0], s[1] - c[1], s[2] - c[2]) || 1;
  const g = new THREE.IcosahedronGeometry(r, 1).toNonIndexed();
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i += 3) {
    const t = [0, 1, 2].map(k => [p.getX(i + k) + c[0], p.getY(i + k) + c[1], p.getZ(i + k) + c[2]]);
    bucket.tri(t[0], t[1], t[2], color);
  }
}
function wheel(bucket, v, idx, color) {
  const [c1, r1, , c2] = [v[idx[0]], v[idx[1]], v[idx[2]], v[idx[3]]];
  const a = new THREE.Vector3(...c1), b = new THREE.Vector3(...c2);
  const r = a.distanceTo(new THREE.Vector3(...r1)) || 1;
  const axis = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(r, r, axis.length() || 1, 12, 1).toNonIndexed();
  const m = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.clone().normalize()));
  m.setPosition(a.clone().add(b).multiplyScalar(0.5));
  g.applyMatrix4(m);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i += 3) bucket.tri(...[0, 1, 2].map(k => [p.getX(i + k), p.getY(i + k), p.getZ(i + k)]), color);
}

// --- Track -------------------------------------------------------------------------------
const TRACKOBJECT_SIZE = 14;
const trkobj = i => {
  const o = A.trkObjectList + i * TRACKOBJECT_SIZE;
  return { rotY: rsw(o + 2), shape: rw(o + 4), overlay: rb(o + 8), surf: rsb(o + 9), multi: rb(o + 11) };
};
const sceneshape2 = i => { const o = A.sceneshapes2 + i * TRACKOBJECT_SIZE; return { rotY: rsw(o + 2), shape: rw(o + 4) }; };

// Shape table: game3dshapes[i] names are aBarn[i*5]; shapes come from GAME1/GAME2.
function shapeNames() {
  const names = [];
  for (let i = 0; i < 0x74; i++) { let s = ''; for (let j = 0; j < 4; j++) { const c = M[A.aBarn + i * 5 + j]; if (c) s += String.fromCharCode(c); } names.push(s); }
  return names;
}

const tileX = col => col * 1024 + 512;               // trackcenterpos2
const tileZ = row => (29 - row) * 1024 + 512;        // trackcenterpos
const place = (x, y, z, rotY) => new THREE.Matrix4().makeRotationY(-rotY * ANGLE).setPosition(x, y, -z);

// Builds the static track scene from the element/terrain maps in memory.
export function buildTrack(shapes) {
  const names = shapeNames();
  const G3D = A.game3dshapes - DS; // shape pointers in trkObjectList are DS offsets into game3dshapes
  const byPtr = ptr => ptr ? shapes[names[(ptr - G3D) / 22]] : null;
  const elems = farptr(A.td14_elem_map_main), terr = farptr(A.td15_terr_map_main);
  const elemAt = (col, row) => M[elems + col + rw(A.trackrows + row * 2)];
  const terrAt = (col, row) => M[terr + col + rw(A.terrainrows + row * 2)];
  const hill = rsw(A.hillHeightConsts + 2);
  const b = new Builder();
  const anim = [new Builder(), new Builder(), new Builder(), new Builder()]; // animated paint (ss_surfaceType < 0)
  const add = (shape, mat, surf) => { if (surf >= 0) b.add(shape, mat, surf); else anim.forEach((a, i) => a.add(shape, mat, i)); };

  for (let row = 0; row < 30; row++) for (let col = 0; col < 30; col++) {
    let e = elemAt(col, row), t = terrAt(col, row);
    if (e >= 0xfd) e = 0; // filler: the owning multi-tile element draws itself
    if (e !== 0 && t >= 7 && t < 11) { e = call.subst_hillroad_track(t, e) & 0xff; t = 0; }
    // Border fences.
    const fence = fenceIndex(col, row);
    if (fence >= 0) {
      const f = trkobj(rb(A.fence_TrkObjCodes + fence));
      const s = byPtr(f.shape);
      if (s) b.add(s, place(tileX(col), 0, tileZ(row), rsw(A.word_3C0D6 + fence * 2)));
    }
    let height = 0;
    if (t === 6) { height = hill; if (e !== 0) t = 0; }
    else if (e >= 0x69 && e <= 0x6c) { // raised corners: terrain of all 4 tiles below
      for (const [dc, dr] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const tt = terrAt(col + dc, row + dr);
        if (tt) { const s2 = sceneshape2(tt); b.add(byPtr(s2.shape), place(tileX(col + dc), 0, tileZ(row + dr), s2.rotY), 0, 'terrain'); }
      }
      t = 0;
    }
    if (t !== 0) {
      const s2 = sceneshape2(t);
      b.add(byPtr(s2.shape), place(tileX(col), height, tileZ(row), s2.rotY), 0, 'terrain');
    }
    if (e === 0) continue;
    const o = trkobj(e);
    const x = (o.multi & 2) ? (col + 1) * 1024 : tileX(col);
    const z = (o.multi & 1) ? (29 - row) * 1024 : tileZ(row);
    if (height) { // plateau tops under elements on raised terrain
      const offs = [[[0, 0]], [[0, 512], [0, -512]], [[512, 0], [-512, 0]], [[-512, 512], [-512, -512], [512, 512], [512, -512]]][o.multi];
      for (const [dx, dz] of offs) b.add(shapes.high, place(x + dx, height, z + dz, 0), 0, 'terrain');
    }
    if (o.overlay) {
      const ov = trkobj(o.overlay);
      const s = byPtr(ov.shape);
      if (s) add(s, place(x, height, z, ov.rotY), ov.surf);
    }
    const s = byPtr(o.shape);
    if (s) add(s, place(x, height, z, o.rotY), o.surf);
  }
  const g = b.group();
  // Animated elements show paint set byte_3C0C6[frame & 15] (0,0,0,0,1,1,1,1,2,...).
  g.userData.anim = anim.map(a => { const ag = a.group(); g.add(ag); return ag; });
  return g;
}

// Trackside signs placed by track_setup (update_frame): sign i is trkObjectList[212 + trackdata23[i]]
// at td10[i] (x, y, z), heading td08[i]; hidden once hit (state.field_3FA[i]).
export function buildSigns(shapes) {
  const names = [];
  for (let i = 0; i < 0x74; i++) { let s = ''; for (let j = 0; j < 4; j++) { const c = M[A.aBarn + i * 5 + j]; if (c) s += String.fromCharCode(c); } names.push(s); }
  const G3D = A.game3dshapes - DS;
  const t19 = farptr(A.trackdata19), t23 = farptr(A.trackdata23), t10 = farptr(A.td10_track_check_rel), t08 = farptr(A.td08_direction_related);
  const used = new Set();
  for (let i = 0; i < 900; i++) if (M[t19 + i] !== 0xff) used.add(M[t19 + i]);
  const g = new THREE.Group();
  g.userData.signs = [];
  for (const i of used) {
    const o = trkobj(212 + M[t23 + i]);
    const shape = shapes[names[(o.shape - G3D) / 22]];
    if (!shape) continue;
    const b = new Builder();
    b.add(shape, place(rsw(t10 + i * 6), rsw(t10 + i * 6 + 2), rsw(t10 + i * 6 + 4), rsw(t08 + i * 2)));
    const m = b.group();
    m.userData.index = i;
    g.add(m);
    g.userData.signs.push(m);
  }
  return g;
}
export function updateSigns(g, st) { for (const m of g.userData.signs) m.visible = !st.field_3FA[m.userData.index]; }

export function animateTrack(g, frame) {
  const k = rsb(A.byte_3C0C6 + (frame & 15));
  g.userData.anim?.forEach((a, i) => { a.visible = i === k; });
}

// Crash debris (update_frame): up to 24 pieces, sceneshapes3 (exp0-3) around the owner car
// (field_443: 0 player, 1 opponent, n+2 obstacle at td10[n]), rotated by field_2FE/32E/35E.
export function buildDebris(playerId, oppId, pMat, oMat) {
  const pieces = [];
  for (const [id, mat] of [[playerId, pMat], [oppId ?? playerId, oMat]]) {
    const sh = loadShapes(`ST${id}.P3S`);
    pieces.push(['exp0', 'exp1', 'exp2', 'exp3'].map(n => { const b = new Builder(); if (sh[n]) b.add(sh[n], new THREE.Matrix4(), mat); return b.group(); }));
  }
  const g = new THREE.Group();
  g.userData.pieces = pieces;
  g.userData.live = [];
  return g;
}
export function updateDebris(g, st, carPos) {
  for (const o of g.userData.live) g.remove(o);
  g.userData.live = [];
  if (!st.field_42A) return;
  for (let i = 0; i < 24; i++) {
    if (!st.field_38E[i]) continue;
    const owner = st.field_443[i];
    const o = g.userData.pieces[Math.min(owner, 1)][st.field_42B[i] & 3].clone();
    if (owner > 1) { // sign debris: offsets from the sign's position (td10), sign shapes from the game set
      const t10 = farptr(A.td10_track_check_rel) + (owner - 2) * 6;
      o.position.set((st.game_longs1[i] >> 6) + rsw(t10), (st.game_longs2[i] >> 6) + rsw(t10 + 2), -((st.game_longs3[i] >> 6) + rsw(t10 + 4)));
    } else {
      const base = carPos[owner];
      o.position.set((st.game_longs1[i] + base.lx) / 64, (st.game_longs2[i] + base.ly) / 64, -(st.game_longs3[i] + base.lz) / 64);
    }
    o.rotation.set(st.field_32E[i] * ANGLE, st.field_35E[i] * ANGLE, -st.field_2FE[i] * ANGLE, 'YXZ');
    g.add(o);
    g.userData.live.push(o);
  }
}

// Border fence selection (update_frame): -1 = none, 0..7 by side/corner.
function fenceIndex(col, row) {
  if (col === 0) return row === 0 ? 7 : row === 29 ? 5 : 6;
  if (col === 29) return row === 0 ? 1 : row === 29 ? 3 : 2;
  return row === 0 ? 0 : row === 29 ? 4 : -1;
}

// Transporter truck at the start line (update_frame), door opened by the roll-in angle a (word_44DCA).
export function buildTruck(shapes, a) {
  const truk = shapes.truk;
  const c = mulScale(cos(a), 0x24), s = mulScale(sin(a), 0x24) + 0x38;
  const verts = truk.verts.map(v => v.slice());
  for (const i of [8, 9, 10, 11]) verts[i][2] = s;
  verts[8][0] = verts[9][0] = c - 0x24; verts[10][0] = verts[11][0] = 0x24 - c;
  const ang = rsw(A.track_angle), col = rb(A.startcol2), row = rb(A.startrow2);
  const x = mulScale(sin(ang + 0x100), 0x24) + mulScale(sin(ang + 0x200), 0x1b6) + tileX(col);
  const z = mulScale(cos(ang + 0x100), 0x24) + mulScale(cos(ang + 0x200), 0x1b6) + tileZ(row);
  const b = new Builder();
  b.add({ ...truk, verts }, place(x, rsw(A.hillHeightConsts + rb(A.hillFlag) * 2), z, ang), Math.min(a >> 6, 3));
  return b.group();
}

// --- Horizon ------------------------------------------------------------------------------
// The scenery file's 4 strips (scen, sce2, sce3, sce4) are 320+192+320+192 = 1024 pixels wide:
// one pixel per angle unit, a full panorama. Drawn bottom-aligned on a cylinder around the camera.
// ponytail: strip order/alignment guessed; port skybox_op for the exact layout.
const SCENERY = ['DESERT', 'TROPICAL', 'ALPINE', 'CITY', 'COUNTRY'];
export function buildHorizon(scenery) {
  const res = parseRes(decompress(getFile(SCENERY[scenery] + '.PVS')));
  const strips = ['scen', 'sce2', 'sce3', 'sce4'].map(n => parseShape2d(res.get(n)));
  const h = Math.max(...strips.map(s => s.height));
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(1024, h);
  let x0 = 0;
  for (const s of strips) {
    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
      const c = s.pixels[x + y * s.width];
      if (!c) continue;
      const o = ((h - s.height + y) * 1024 + x0 + x) * 4;
      img.data.set([...palette[c], c === 117 ? 254 : 255], o); // 117: painted sky, cut by alphaTest in enhanced graphics
    }
    x0 += s.width;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  const R = 50000, height = R * Math.tan(h * ANGLE);
  const geo = new THREE.CylinderGeometry(R, R, height, 128, 1, true);
  geo.translate(0, height / 2 - R * 0.004, 0);
  return new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.BackSide, fog: false, depthWrite: false }));
}

// Clouds (update_frame, detail 0): 8 flat shapes at azimuth word_3BE34[i] + run_game_random,
// 15000 away and 0xAE6 up, facing the viewer. The group follows the camera horizontally.
export function buildClouds(shapes, random) {
  const g = new THREE.Group();
  const names = ['cld3', 'cld2', 'cld1', 'cld3', 'cld2', 'cld1', 'cld3', 'cld2']; // off_3BE44
  for (let i = 0; i < 8; i++) {
    const a = ((rsw(A.word_3BE34 + i * 2) + random) & 0x3ff) * ANGLE;
    const x = 15000 * Math.sin(a), z = -15000 * Math.cos(a);
    const b = new Builder();
    b.add(shapes[names[i]], new THREE.Matrix4());
    const c = b.group();
    c.position.set(x, 0xae6, z);
    c.rotation.y = Math.atan2(-x, -z);
    c.traverse(o => { if (o.material) { o.material = o.material.clone(); Object.assign(o.material, { fog: false }); o.castShadow = false; } });
    g.add(c);
  }
  return g;
}

// --- Cars ---------------------------------------------------------------------------------
// car1/car2 are the in-game models; car0 is the showroom model at 20x scale, used here
// scaled down for more detail. Wheels (primitive type 12) become separate meshes so they can
// steer and follow the suspension like sub_204AE does to car1's wheel vertices.
export function buildCar(id, slot = 0) {
  const shapes = loadShapes(`ST${id}.P3S`);
  const car0 = shapes.car0, car1 = shapes.car1;
  const scale = new THREE.Matrix4().makeScale(1 / 20, 1 / 20, 1 / 20);
  const body = new Builder();
  body.add({ ...car0, prims: car0.prims.filter(p => p.type !== 12) }, scale, slot);
  const g = new THREE.Group();
  g.add(body.group(matCar));
  // car1's wheels are in physics order (rc2 index): match car0's wheels by quadrant.
  const physWheels = car1.prims.filter(p => p.type === 12).map(p => car1.verts[p.idx[0]]);
  g.userData.wheels = car0.prims.filter(p => p.type === 12).map(p => {
    const [cx, cy, cz] = [0, 3].map(k => car0.verts[p.idx[k]]).reduce((a, v) => a.map((x, i) => x + v[i] / 2), [0, 0, 0]);
    const j = physWheels.findIndex(v => Math.sign(v[0]) === Math.sign(cx) && Math.sign(v[2]) === Math.sign(cz));
    const wb = new Builder();
    wb.add({ ...car0, prims: [p] }, new THREE.Matrix4().makeTranslation(-cx / 20, -cy / 20, cz / 20).multiply(scale), slot);
    const pivot = new THREE.Group();
    pivot.position.set(cx / 20, cy / 20, -cz / 20);
    pivot.userData = { j: j < 0 ? 0 : j, front: cz > 0, y: cy / 20 };
    pivot.add(wb.group());
    g.add(pivot);
    return pivot;
  });
  return g;
}
// Steering (front wheels turn by steeringAngle/2) and suspension (wheel rises |rc2| >> 6).
export function animateWheels(car, cs) {
  for (const w of car.userData.wheels ?? []) {
    w.rotation.y = w.userData.front ? -(cs.car_steeringAngle >> 1) * ANGLE : 0;
    w.position.y = w.userData.y + (Math.abs(cs.car_rc2[w.userData.j]) >> 6);
  }
}
// Car pose from CARSTATE: position /64, rotation R = Ry(-yaw)Rx(-pitch)Rz(-roll) in game space.
export function carPose(cs, obj) {
  obj.position.set(cs.car_posWorld1.lx / 64, cs.car_posWorld1.ly / 64, -cs.car_posWorld1.lz / 64);
  obj.rotation.set(cs.car_rotate.y * ANGLE, cs.car_rotate.x * ANGLE, -cs.car_rotate.z * ANGLE, 'YXZ');
}
export { THREE };

// Swatch colour for a paint slot: the most used paint among the shape's polygons.
export function paintHex(shape, slot) {
  const count = new Map();
  for (const p of shape.prims) {
    if (p.type < 3 || p.type > 10) continue;
    const paint = p.paints[slot];
    count.set(paint, (count.get(paint) ?? 0) + 1);
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  return '#' + (materialColor[best] ?? [0, 0, 0]).map(c => c.toString(16).padStart(2, '0')).join('');
}
