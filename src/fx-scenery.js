// Enhanced graphics: 3D distant scenery around the track, replacing the pixel-art horizon.
// One procedural ring of terrain per scenery (desert, tropical, alpine, city, country), low-poly and
// flat-shaded like the original shapes, with surface kinds for the fx.js shader.
import * as THREE from '../vendor/three.module.js';

const CX = 15360, CZ = -15360;          // track centre (Three.js space)
const R0 = 26000, R1 = 95000;           // ring: just beyond the track corners, out past the haze
const KIND = { dirt: 3, ice: 4, grass: 5, water: 6, concrete: 7, building: 8 };

// Value noise (hashed lattice, smoothstep blend) and its fractal sum, roughly 0..1.
function hash(x, z, s) {
  let h = Math.imul(x, 374761393) + Math.imul(z, 668265263) + Math.imul(s, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, z, s) {
  const xi = Math.floor(x), zi = Math.floor(z);
  let fx = x - xi, fz = z - zi;
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const a = hash(xi, zi, s), b = hash(xi + 1, zi, s), c = hash(xi, zi + 1, s), d = hash(xi + 1, zi + 1, s);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
function fbm(x, z, s, oct = 5) {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) { v += amp * noise(x * f, z * f, s + i); norm += amp; amp *= 0.5; f *= 2.03; }
  return v / norm;
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Height (y) and face colour/kind for each scenery. slope: 0 flat .. 1 vertical.
const SCENES = [
  { // desert: mesas and buttes with red rock strata over sand
    h: (x, z) => {
      const n = fbm(x / 9000, z / 9000, 1);
      return smooth(0.48, 0.52, n) * (3500 + 5000 * fbm(x / 25000, z / 25000, 9)) + 400 * fbm(x / 2500, z / 2500, 5);
    },
    face: (y, slope) => y < 280 ? [[0.86, 0.7, 0.5], KIND.dirt]
      : [mix([0.72, 0.34, 0.18], [0.86, 0.52, 0.3], 0.5 + 0.5 * Math.sin(y / 170)), slope < 0.3 ? KIND.dirt : 0],
  },
  { // tropical: lush hills, beaches, and the sea where the land dips
    h: (x, z) => {
      const land = smooth(0.42, 0.56, fbm(x / 30000, z / 30000, 2, 3));
      return land * 8000 * fbm(x / 9000, z / 9000, 3) ** 1.5 - (1 - land) * 400;
    },
    face: (y, slope) => y < 90 ? [[0.86, 0.8, 0.56], KIND.dirt]
      : [mix([0.2, 0.52, 0.14], [0.1, 0.36, 0.1], Math.min(1, slope * 2)), KIND.grass],
    sea: true, trees: true,
  },
  { // alpine: forested foothills, rock, snowy ridged peaks
    h: (x, z) => {
      const r = 1 - Math.abs(2 * fbm(x / 14000, z / 14000, 4) - 1);
      return r * r * 12000 * (0.35 + fbm(x / 30000, z / 30000, 8, 2)) + 300 * fbm(x / 3000, z / 3000, 6);
    },
    face: (y, slope) => y > 4200 - 1500 * slope ? [[0.94, 0.96, 1], 0]
      : y > 2200 || slope > 0.65 ? [[0.46, 0.44, 0.43], KIND.concrete]
      : [[0.13, 0.32, 0.14], KIND.grass],
  },
  { // city: low hills behind a skyline (buildings added separately)
    h: (x, z) => 5000 * Math.max(0, fbm(x / 12000, z / 12000, 7) - 0.3) * smooth(42000, 55000, Math.hypot(x - CX, z - CZ)),
    face: () => [[0.3, 0.48, 0.24], KIND.grass],
    city: true,
  },
  { // country: rolling hills, patchwork of fields, darker woods on the slopes
    h: (x, z) => 7000 * Math.max(0, fbm(x / 11000, z / 11000, 11) - 0.3),
    trees: true,
    face: (y, slope, x, z) => {
      if (slope > 0.35) return [[0.14, 0.33, 0.12], KIND.grass];
      const f = hash(Math.floor(x / 1800), Math.floor(z / 1800), 12);
      return [[[0.36, 0.56, 0.2], [0.55, 0.62, 0.25], [0.78, 0.7, 0.36], [0.3, 0.48, 0.18], [0.5, 0.4, 0.26]][Math.floor(f * 5)], f > 0.8 ? KIND.dirt : KIND.grass];
    },
  },
];

export function buildScenery(index, material) {
  const S = SCENES[index] ?? SCENES[4];
  const pos = [], col = [], kind = [];
  const c = new THREE.Color();
  const face = (a, b, d) => {
    pos.push(...a, ...b, ...d);
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const slope = 1 - Math.abs(n[1]) / Math.hypot(...n);
    const y = (a[1] + b[1] + d[1]) / 3, x = (a[0] + b[0] + d[0]) / 3, z = (a[2] + b[2] + d[2]) / 3;
    const [rgb, k] = S.face(y, slope, x, z);
    c.setRGB(...rgb, THREE.SRGBColorSpace);
    for (let i = 0; i < 3; i++) { col.push(c.r, c.g, c.b); kind.push(k); }
  };

  // Polar grid, rings spaced geometrically so faces look about as big near and far.
  const NA = 360, NR = 26, grid = [];
  for (let j = 0; j <= NR; j++) {
    const r = R0 * (R1 / R0) ** (j / NR), row = [];
    for (let i = 0; i < NA; i++) {
      const a = (i / NA) * Math.PI * 2, x = CX + r * Math.cos(a), z = CZ + r * Math.sin(a);
      row.push([x, S.h(x, z) * smooth(R0, R0 + 9000, r), z]);
    }
    grid.push(row);
  }
  for (let j = 0; j < NR; j++) for (let i = 0; i < NA; i++) {
    const i2 = (i + 1) % NA, p = grid[j][i], q = grid[j][i2], s = grid[j + 1][i], t = grid[j + 1][i2];
    face(p, s, q); face(q, s, t);
  }

  if (S.city) { // skyline: boxes, taller downtown clusters, windowed facades
    for (let n = 0; n < 700; n++) {
      const a = hash(n, 1, 21) * Math.PI * 2, r = R0 + 2000 + hash(n, 2, 21) ** 1.5 * 16000;
      const x = CX + r * Math.cos(a), z = CZ + r * Math.sin(a);
      const downtown = fbm(Math.cos(a) * 3, Math.sin(a) * 3, 22, 2);
      const h = 500 + hash(n, 3, 21) ** 2 * 6500 * smooth(0.35, 0.7, downtown), w = 450 + hash(n, 4, 21) * 900, d = 450 + hash(n, 5, 21) * 900;
      const tone = [[0.62, 0.62, 0.64], [0.72, 0.66, 0.56], [0.45, 0.52, 0.62], [0.55, 0.55, 0.5]][Math.floor(hash(n, 6, 21) * 4)];
      const v = [[-w, 0, -d], [w, 0, -d], [w, 0, d], [-w, 0, d]].map(([vx, , vz]) => [x + vx / 2, z + vz / 2]);
      for (let k = 0; k < 4; k++) { // walls
        const [x0, z0] = v[k], [x1, z1] = v[(k + 1) % 4];
        const q = [[x0, 0, z0], [x1, 0, z1], [x1, h, z1], [x0, h, z0]];
        for (const tri of [[0, 1, 2], [0, 2, 3]]) {
          pos.push(...q[tri[0]], ...q[tri[1]], ...q[tri[2]]);
          c.setRGB(...tone, THREE.SRGBColorSpace);
          for (let m = 0; m < 3; m++) { col.push(c.r, c.g, c.b); kind.push(KIND.building); }
        }
      }
      const top = v.map(([vx, vz]) => [vx, h, vz]);
      for (const tri of [[0, 2, 1], [0, 3, 2]]) {
        pos.push(...top[tri[0]], ...top[tri[1]], ...top[tri[2]]);
        c.setRGB(tone[0] * 0.8, tone[1] * 0.8, tone[2] * 0.8, THREE.SRGBColorSpace);
        for (let m = 0; m < 3; m++) { col.push(c.r, c.g, c.b); kind.push(KIND.concrete); }
      }
    }
  }

  if (S.trees) { // woods: clumps of low-poly cone trees on gentle land
    const tone = [[0.1, 0.28, 0.1], [0.14, 0.34, 0.12], [0.09, 0.24, 0.12]];
    for (let n = 0; n < 2500; n++) {
      const a = hash(n, 1, 31) * Math.PI * 2, r = R0 + 1500 + hash(n, 2, 31) * 30000;
      const x = CX + r * Math.cos(a), z = CZ + r * Math.sin(a);
      if (fbm(x / 6000, z / 6000, 32, 2) < 0.55) continue;
      const y = S.h(x, z) * smooth(R0, R0 + 9000, r), h = 350 + hash(n, 3, 31) * 450, w = h * 0.35;
      const ring = [0, 1, 2, 3, 4].map(k => [x + w * Math.cos(k * 1.2566), y, z + w * Math.sin(k * 1.2566)]);
      c.setRGB(...tone[n % 3], THREE.SRGBColorSpace);
      for (let k = 0; k < 5; k++) {
        pos.push(...ring[k], ...ring[(k + 1) % 5], x, y + h, z);
        for (let m = 0; m < 3; m++) { col.push(c.r, c.g, c.b); kind.push(KIND.grass); }
      }
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('kind', new THREE.Float32BufferAttribute(kind, 1));
  g.computeVertexNormals();
  const group = new THREE.Group();
  group.add(new THREE.Mesh(g, material));
  if (S.sea) { // water sheet under the land, the shader's water
    const sea = new THREE.RingGeometry(R0 - 500, R1, 90, 1).rotateX(-Math.PI / 2).translate(CX, -60, CZ);
    const n = sea.getAttribute('position').count;
    sea.setAttribute('color', new THREE.Float32BufferAttribute(Array(n).fill([0, 0.22, 0.64]).flat(), 3));
    sea.setAttribute('kind', new THREE.Float32BufferAttribute(Array(n).fill(KIND.water), 1));
    group.add(new THREE.Mesh(sea, material));
  }
  return group;
}
