// Enhanced graphics race effects: skid marks, tyre smoke and dust, crash fire and sparks.
// Driven from CARSTATE after each simulation tick; purely visual.
import * as THREE from '../vendor/three.module.js';

// Wheel surface (car_surfaceWhl, current_surf_type): 0 air, 1 paved, 2 dirt, 3 ice, 4 grass, 5 water.
// Skid mark colour/alpha, whether it needs sliding, and the particle that comes off the wheel.
const SURF = {
  1: { mark: [0.02, 0.02, 0.02, 0.6], slideOnly: true, puff: [0.8, 0.8, 0.8], puffA: 0.3 },
  2: { mark: [0.16, 0.09, 0.04, 0.55], slideOnly: false, puff: [0.55, 0.38, 0.22], puffA: 0.3 },
  3: { mark: [0.85, 0.92, 1.0, 0.4], slideOnly: true, puff: [0.92, 0.96, 1.0], puffA: 0.3 },
  4: { mark: [0.04, 0.1, 0.02, 0.45], slideOnly: false, puff: [0.3, 0.38, 0.16], puffA: 0.16 },
  5: { mark: null, slideOnly: false, puff: [0.9, 0.95, 1.0], puffA: 0.6 },
};
const MARK_W = 7, MAX_SEG = 6000;

// Camera-facing quads, one instance per particle. Soft round puffs; `glow` ones are additive and
// bright enough for the bloom pass (fire, sparks).
function particles(max, glow) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const iCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const iSize = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage); // size, seed
  geo.setAttribute('iPos', iPos); geo.setAttribute('iCol', iCol); geo.setAttribute('iSize', iSize);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    vertexShader: `attribute vec3 iPos; attribute vec4 iCol; attribute vec2 iSize;
varying vec2 vUv; varying vec4 vCol; varying float vSeed;
void main() {
  vUv = position.xy; vCol = iCol; vSeed = iSize.y;
  float a = iSize.y * 6.2831;
  vec2 c = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xy;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  mv.xy += c * iSize.x;
  vCol.a *= smoothstep(10.0, 40.0 + 1.5 * iSize.x, -mv.z); // fade out close to the camera
  gl_Position = projectionMatrix * mv;
}`,
    fragmentShader: `varying vec2 vUv; varying vec4 vCol; varying float vSeed;
void main() {
  float r = length(vUv);
  ${glow ? 'float a = pow(max(1.0 - r, 0.0), 2.0);' : `
  float lumps = 0.75 + 0.25 * sin(vUv.x * 5.0 + vSeed * 40.0) * sin(vUv.y * 4.0 - vSeed * 25.0);
  float a = smoothstep(1.0, 0.25, r) * lumps;`}
  vec3 c = vCol.rgb${glow ? '' : ' * (0.8 + 0.3 * vUv.y)'};
  gl_FragColor = vec4(c, a * vCol.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const P = [];
  return {
    mesh,
    spawn(p) { if (P.length < max) P.push({ age: 0, ...p }); },
    step(dt) {
      let n = 0;
      for (let i = 0; i < P.length; i++) {
        const p = P[i];
        p.age += dt;
        if (p.age >= p.life) continue;
        p.v.y -= (p.grav ?? 0) * dt;
        p.v.multiplyScalar(Math.max(0, 1 - (p.drag ?? 1.5) * dt));
        p.x.addScaledVector(p.v, dt);
        const t = p.age / p.life, fade = glow ? 1 - t : Math.min(1, t * 8) * (1 - t);
        const size = p.s0 + (p.s1 - p.s0) * Math.sqrt(t);
        // Ground puffs sit on their base: a camera-facing quad centred at the ground would be cut by it.
        iPos.array.set([p.x.x, p.x.y + (p.lift ? size * 0.8 : 0), p.x.z], n * 3);
        iCol.array.set([p.c[0] * (p.gain ?? 1), p.c[1] * (p.gain ?? 1), p.c[2] * (p.gain ?? 1), p.a * fade], n * 4);
        iSize.array.set([size, p.seed], n * 2);
        P[n++] = p;
      }
      P.length = n;
      geo.instanceCount = n;
      iPos.needsUpdate = iCol.needsUpdate = iSize.needsUpdate = true;
    },
    clear() { P.length = 0; geo.instanceCount = 0; },
  };
}

export function createEffects() {
  const group = new THREE.Group();

  // Skid marks: a ring buffer of quads, each joining a wheel's previous contact point to the current one.
  const pos = new Float32Array(MAX_SEG * 18), col = new Float32Array(MAX_SEG * 24);
  const markGeo = new THREE.BufferGeometry();
  markGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  markGeo.setAttribute('color', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
  markGeo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAX_SEG * 18).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
  const marks = new THREE.Mesh(markGeo, new THREE.MeshStandardMaterial({
    vertexColors: true, transparent: true, depthWrite: false, roughness: 1,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -16,
  }));
  marks.frustumCulled = false;
  marks.receiveShadow = true;
  let seg = 0, segCount = 0;
  const smoke = particles(1500, false), glow = particles(1200, true);
  group.add(marks, smoke.mesh, glow.mesh);

  const cars = [{}, {}];
  let lastFrame = -1;
  const up = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), side = new THREE.Vector3();
  const rnd = (s = 1) => (Math.random() * 2 - 1) * s;
  const jitter = s => new THREE.Vector3(rnd(s), rnd(s), rnd(s));

  function addSegment(p0, p1, n, c) {
    side.subVectors(p1, p0).cross(n).normalize().multiplyScalar(MARK_W / 2);
    const q = [p0.clone().sub(side), p0.clone().add(side), p1.clone().add(side), p1.clone().sub(side)];
    const o = seg * 18;
    [0, 1, 2, 0, 2, 3].forEach((k, i) => pos.set([q[k].x + n.x, q[k].y + n.y, q[k].z + n.z], o + i * 3));
    for (let i = 0; i < 6; i++) col.set(c, seg * 24 + i * 4);
    seg = (seg + 1) % MAX_SEG;
    segCount = Math.min(segCount + 1, MAX_SEG);
    markGeo.setDrawRange(0, segCount * 6);
    markGeo.attributes.position.needsUpdate = markGeo.attributes.color.needsUpdate = true;
  }

  function burst(at, vel, crash) {
    for (let i = 0; i < 28; i++) glow.spawn({ x: at.clone().add(jitter(30)), v: vel.clone().multiplyScalar(0.3).add(jitter(200)).setY(60 + Math.random() * 200),
      life: 0.3 + Math.random() * 0.6, s0: 18, s1: 60, c: [1, 0.25 + Math.random() * 0.3, 0.05], gain: 1.6, a: 1, seed: Math.random(), drag: 2 });
    for (let i = 0; i < 60; i++) glow.spawn({ x: at.clone(), v: vel.clone().multiplyScalar(0.5).add(jitter(500)).setY(100 + Math.random() * 500),
      life: 0.6 + Math.random() * 0.8, s0: 3, s1: 1.5, c: [1, 0.7, 0.3], gain: 8, a: 1, seed: 0, grav: 500, drag: 0.5 });
    for (let i = 0; i < (crash ? 45 : 10); i++) smoke.spawn({ x: at.clone().add(jitter(40)), v: jitter(60).setY(60 + Math.random() * 120),
      life: 2.5 + Math.random() * 3, s0: 40, s1: 220, c: [0.12, 0.11, 0.1], a: 0.8, seed: Math.random(), drag: 0.6, lift: true });
  }
  function splash(at, vel) {
    for (let i = 0; i < 80; i++) smoke.spawn({ x: at.clone().add(jitter(40)), v: vel.clone().multiplyScalar(0.3).add(jitter(200)).setY(200 + Math.random() * 400),
      life: 0.8 + Math.random() * 0.8, s0: 12, s1: 60, c: [0.92, 0.96, 1], a: 0.7, seed: Math.random(), grav: 500, drag: 0.8 });
  }

  // One simulation tick: new skid segments and particles for each active car.
  function tick(list) {
    list.forEach(({ cs, obj }, ci) => {
      const car = cars[ci];
      const at = new THREE.Vector3(cs.car_posWorld1.lx / 64, cs.car_posWorld1.ly / 64, -cs.car_posWorld1.lz / 64);
      const vel = car.at ? at.clone().sub(car.at).multiplyScalar(20) : new THREE.Vector3();
      car.at = at;
      up.set(0, 1, 0).applyQuaternion(obj.quaternion);
      const speed = cs.car_speed2, sliding = cs.car_slidingFlag && speed > 0x800;
      car.wheels ??= [null, null, null, null];
      for (let i = 0; i < 4; i++) {
        const w = cs.car_whlWorldCrds1[i], s = SURF[cs.car_surfaceWhl[i]];
        a.set(w.x, w.y, -w.z);
        const marking = s?.mark && speed > 0x300 && (sliding || !s.slideOnly);
        if (marking && car.wheels[i] && car.wheels[i].distanceTo(a) < 200) addSegment(car.wheels[i], a, up, s.mark);
        car.wheels[i] = marking ? a.clone() : null;
        if (!s) continue;
        // Smoke only while sliding on tarmac/ice; dust and grass always, more with speed and sliding.
        const rate = (sliding ? 1 : s.slideOnly ? 0 : Math.min(1, speed / 0x3000) * 0.5) * (i >= 2 ? 1 : 0.6);
        if (Math.random() < rate) smoke.spawn({ x: a.clone().addScaledVector(up, 6), v: vel.clone().multiplyScalar(0.15).add(jitter(40)).addScaledVector(up, 30 + Math.random() * 40),
          life: 0.9 + Math.random() * 1.1, s0: 8, s1: sliding ? 38 : 30, c: s.puff, a: s.puffA * (sliding ? 0.7 : 0.5), seed: Math.random(), drag: 1.2, lift: true });
      }
      if (cs.field_CF & 0x10 && speed > 0x400) for (let i = 0; i < 4; i++) // scraping a wall
        glow.spawn({ x: at.clone().add(jitter(25)), v: vel.clone().multiplyScalar(0.6).add(jitter(200)).setY(Math.random() * 250),
          life: 0.3 + Math.random() * 0.4, s0: 2, s1: 1, c: [1, 0.75, 0.35], gain: 8, a: 1, seed: 0, grav: 500, drag: 0.5 });
      if (cs.field_CF & 0x20) for (let i = 0; i < 12; i++) // hard landing
        smoke.spawn({ x: at.clone().add(jitter(40)).setY(at.y), v: jitter(120).setY(20 + Math.random() * 40),
          life: 1 + Math.random(), s0: 20, s1: 90, c: SURF[cs.car_surfaceWhl[2]]?.puff ?? [0.6, 0.55, 0.5], a: 0.4, seed: Math.random(), drag: 2, lift: true });
      const crash = cs.car_crashBmpFlag;
      if (crash !== car.crash && crash === 1) burst(at, vel, true);
      if (crash !== car.crash && crash === 2) splash(at, vel);
      if (crash === 1 && Math.random() < 0.7) // burning wreck
        smoke.spawn({ x: at.clone().add(jitter(20)), v: jitter(20).setY(90 + Math.random() * 60), life: 4 + Math.random() * 2,
          s0: 30, s1: 260, c: [0.1, 0.09, 0.08], a: 0.65, seed: Math.random(), drag: 0.4 });
      car.crash = crash;
    });
  }

  return {
    group, marksMaterial: marks.material,
    // cars: [{ cs, obj }] (active ones); frame: state.game_frame. A jump in frames (restart, seek) clears.
    update(dt, list, frame) {
      if (frame < lastFrame || frame > lastFrame + 40) this.clear();
      if (frame !== lastFrame) { lastFrame = frame; tick(list); }
      smoke.step(dt); glow.step(dt);
    },
    clear() {
      seg = segCount = 0; markGeo.setDrawRange(0, 0);
      smoke.clear(); glow.clear();
      cars.forEach(c => { for (const k in c) delete c[k]; });
    },
  };
}
