// Enhanced graphics (menu option): gradient sky with sun and haze, glossy car paint reflecting it,
// procedural surfaces (asphalt, grass, dirt, ice, water, concrete), bloom and a colour grade. Rendering only, the simulation is untouched.
import * as THREE from '../vendor/three.module.js';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';
import { createEffects } from './fx-effects.js';

// Shared uniforms: detail strength (0 = classic look), time (water), and the sky colours.
const U = {
  uDetail: { value: 0 }, uTime: { value: 0 },
  uHorizon: { value: new THREE.Color(0xb3d1ec) }, uZenith: { value: new THREE.Color(0x1a56c2) },
  uSunDir: { value: new THREE.Vector3(1500, 3000, 1000).normalize() }, // where main.js puts the shadow light
  uGround: { value: new THREE.Color() },
};
// Sky: horizon-to-zenith gradient, sun glow and disc; below the horizon, the hazed ground.
const SKY_GLSL = `uniform vec3 uHorizon, uZenith, uSunDir, uGround;
vec3 skyColor(vec3 d) {
  vec3 c = mix(mix(uHorizon, uGround, smoothstep(0.0, -0.003, d.y)), uZenith, pow(max(d.y, 0.0), 0.45));
  float s = max(dot(d, uSunDir), 0.0);
  return c + vec3(1.0, 0.85, 0.6) * (0.35 * pow(s, 12.0) + 0.6 * pow(s, 300.0) + 30.0 * smoothstep(0.9994, 0.9996, s));
}`;

// Surface kinds by original paint index (material_color_list), from the track shapes that use them.
export const KIND = { asphalt: 1, marking: 2, dirt: 3, ice: 4, grass: 5, water: 6, concrete: 7 };
const PAINT_KIND = {
  19: 'asphalt', 20: 'asphalt', 22: 'asphalt', 23: 'asphalt', 18: 'marking', 21: 'marking', 24: 'marking',
  25: 'dirt', 27: 'dirt', 28: 'ice', 30: 'ice', 16: 'grass', 101: 'grass', 102: 'grass', 103: 'grass', 104: 'grass',
  105: 'grass', 100: 'water', 31: 'concrete', 32: 'concrete', 33: 'concrete', 35: 'concrete', 36: 'concrete',
};
export const surfaceKind = paint => KIND[PAINT_KIND[paint]] ?? 0;

// Procedural surfaces in world space (vertex attribute `kind`): albedo variation, bump, roughness and,
// for water and ice, sky reflections. Features smaller than a pixel fade out (aw) instead of shimmering.
export function addDetail(material) {
  material.onBeforeCompile = s => {
    Object.assign(s.uniforms, U);
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nattribute float kind;\nvarying vec3 vWPos;\nvarying float vKind;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvKind = kind;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vWPos;
varying float vKind;
uniform float uDetail, uTime;
${SKY_GLSL}
float h3(vec3 p) {
  uvec3 q = uvec3(ivec3(floor(p))) * uvec3(1597334673u, 3812015801u, 2798796415u);
  return float((q.x ^ q.y ^ q.z) * 1597334673u) / 4294967295.0;
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm3(vec3 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 17.0) + 0.2 * vnoise(p * 4.1 + 31.0); }
float aw(float fw, float size) { return 1.0 - smoothstep(0.25, 0.7, fw / size); }
// perturbNormalArb (bumpmap_pars_fragment): bump from screen-space height derivatives.
vec3 sfPerturb(vec3 pos, vec3 n, vec2 dH, float face) {
  vec3 sx = dFdx(pos), sy = dFdy(pos), r1 = cross(sy, n), r2 = cross(n, sx);
  float det = dot(sx, r1) * face;
  return normalize(abs(det) * n - sign(det) * (dH.x * r1 + dH.y * r2));
}`).replace('#include <color_fragment>', `#include <color_fragment>
float sfH = 0.0, sfRough = -1.0, sfRefl = 0.0;
if (uDetail > 0.0) {
  int k = int(vKind + 0.5);
  vec3 p = vWPos;
  float fw = length(fwidth(p));
  float big = vnoise(p / 900.0), mid = vnoise(p / 90.0 + 5.0);
  vec3 alb = vec3(0.85 + 0.3 * big);
  if (k == 1) { // asphalt: aggregate grain, darker resurfaced patches
    float grain = vnoise(p / 1.3) * aw(fw, 1.3), patches = smoothstep(0.4, 0.75, fbm3(p / 220.0));
    alb = vec3(0.82 + 0.3 * big) * mix(1.0, 0.78, patches) * (0.88 + 0.26 * grain);
    sfH = 0.35 * grain + 0.6 * vnoise(p / 6.0) * aw(fw, 6.0);
    sfRough = 0.92 - 0.25 * patches;
  } else if (k == 2) { // paint: worn through in places
    float wear = smoothstep(0.55, 0.85, vnoise(p / 6.0)) * aw(fw, 6.0);
    alb = vec3(1.0 - 0.4 * wear);
    sfH = 0.2 * vnoise(p / 1.3) * aw(fw, 1.3);
    sfRough = 0.6;
  } else if (k == 3) { // dirt: pebbles, ruts, damp and dry patches
    float peb = pow(vnoise(p / 2.2), 3.0) * aw(fw, 2.2);
    alb = vec3(1.0, 0.97, 0.92) * (0.7 + 0.5 * fbm3(p / 70.0)) * (0.9 + 0.35 * peb) * (0.9 + 0.2 * big);
    sfH = 0.9 * peb + 2.0 * vnoise(p / 14.0) * aw(fw, 14.0);
    sfRough = 1.0;
  } else if (k == 4) { // ice: glossy, with white cracks
    float crack = (1.0 - smoothstep(0.0, 0.03, abs(vnoise(p / 45.0) - 0.5))) * aw(fw, 25.0);
    alb = vec3(0.93 + 0.1 * mid) + 0.3 * crack;
    sfH = -0.3 * crack;
    sfRough = 0.05 + 0.12 * mid; sfRefl = 0.7;
  } else if (k == 5) { // grass: tufts, dry and lush patches
    float tuft = vnoise(p * vec3(1.1, 0.4, 1.1)) * aw(fw, 1.0);
    float dry = smoothstep(0.5, 0.8, fbm3(p / 700.0 + 3.0));
    float mow = mix(0.94, 1.06, smoothstep(0.45, 0.55, abs(fract(p.x / 1024.0) - 0.5) * 2.0)); // stripes along the tile grid
    alb = mow * (0.78 + 0.4 * big) * (0.84 + 0.32 * mid) * mix(vec3(1.0), vec3(1.3, 1.12, 0.55), 0.55 * dry) * (0.86 + 0.28 * tuft);
    sfH = 0.6 * tuft + 1.2 * vnoise(p / 8.0) * aw(fw, 8.0);
    sfRough = 0.95;
  } else if (k == 6) { // water: moving ripples, sky reflection
    vec2 q = p.xz;
    sfH = 2.0 * vnoise(vec3(q / 35.0 + uTime * vec2(0.09, 0.05), uTime * 0.2))
        + 0.8 * vnoise(vec3(q / 11.0 - uTime * vec2(0.13, 0.11), uTime * 0.3 + 9.0)) * aw(fw, 11.0);
    alb = vec3(1.0, 0.55, 0.27); // paint 100 is a saturated blue: towards a deep teal
    sfRough = 0.04; sfRefl = 0.75;
  } else if (k == 7) { // concrete: speckle and stains
    float sp = vnoise(p / 1.6) * aw(fw, 1.6);
    alb = vec3(0.85 + 0.25 * big) * (0.9 + 0.2 * sp) * (1.0 - 0.2 * smoothstep(0.5, 0.8, fbm3(p / 60.0)));
    sfH = 0.25 * sp;
    sfRough = 0.85;
  }
  diffuseColor.rgb *= mix(vec3(1.0), alb, uDetail * smoothstep(40000.0, 12000.0, length(vViewPosition)));
}`).replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
if (sfRough >= 0.0) roughnessFactor = sfRough;`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (uDetail > 0.0) normal = sfPerturb(-vViewPosition, normal, vec2(dFdx(sfH), dFdy(sfH)), faceDirection);`)
      .replace('#include <opaque_fragment>', `if (sfRefl > 0.0) {
  vec3 nW = normalize((vec4(normal, 0.0) * viewMatrix).xyz), v = normalize(vWPos - cameraPosition), r = reflect(v, nW);
  float fres = 0.04 + 0.96 * pow(1.0 - max(dot(-v, nW), 0.0), 5.0);
  vec3 refl = skyColor(r) + vec3(1.0, 0.9, 0.7) * 60.0 * pow(max(dot(r, uSunDir), 0.0), 900.0);
  outgoingLight = mix(outgoingLight, refl, sfRefl * clamp(0.1 + fres, 0.0, 0.85));
}
#include <opaque_fragment>`);
  };
  return material;
}

export function createFx({ renderer, scene, skyScene, camera, sun, hemi, carMaterial, groundColor }) {
  const skyHemi = skyScene.children.find(o => o.isHemisphereLight); // lights the clouds
  const classic = { skyHemi: skyHemi.intensity, background: skyScene.background, fog: scene.fog, hemi: hemi.intensity, hemiColor: hemi.color.getHex(), sun: sun.intensity, sunColor: sun.color.getHex() };
  const fog = new THREE.Fog(U.uHorizon.value, 2500, 90000); // haze; never full, so the ground still meets the horizon art
  U.uGround.value.copy(groundColor).lerp(U.uHorizon.value, 0.65); // ground seen past the far plane

  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, uniforms: U,
    vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vDir;
${SKY_GLSL}
void main() {
  gl_FragColor = vec4(skyColor(normalize(vDir)), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(45000, 32, 16), skyMaterial);
  sky.visible = false;
  skyScene.add(sky);

  // Reflections for the car paint: the same sky over a dark green ground.
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMaterial),
    new THREE.Mesh(new THREE.CircleGeometry(60, 32).rotateX(-Math.PI / 2).translate(0, -2, 0), new THREE.MeshBasicMaterial({ color: 0x2f4a22 })));
  const env = new THREE.PMREMGenerator(renderer).fromScene(envScene, 0.02).texture;

  const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, rt);
  const worldPass = new RenderPass(scene, camera);
  Object.assign(worldPass, { clear: false, clearDepth: true });
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.22, 0.5, 0.92);
  composer.addPass(new RenderPass(skyScene, camera));
  composer.addPass(worldPass);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  // Grade (display space): a little more saturation and contrast, and a soft vignette.
  composer.addPass(new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform sampler2D tDiffuse; varying vec2 vUv;
void main() {
  vec3 c = texture2D(tDiffuse, vUv).rgb;
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.08);
  c = (c - 0.5) * 1.06 + 0.5;
  vec2 v = vUv - 0.5;
  gl_FragColor = vec4(c * (1.0 - 0.55 * dot(v, v)), 1.0);
}`,
  }));

  const effects = createEffects();

  let on = false;
  return {
    get enabled() { return on; },
    set enabled(v) {
      on = v;
      U.uDetail.value = on ? 1 : 0;
      effects.clear();
      if (on) scene.add(effects.group); else scene.remove(effects.group);
      sky.visible = on;
      skyScene.background = on ? null : classic.background;
      scene.fog = on ? fog : classic.fog;
      skyHemi.intensity = on ? 4.5 : classic.skyHemi;
      hemi.intensity = on ? 0.6 : classic.hemi;
      hemi.color.set(on ? 0xf2f2f0 : classic.hemiColor);
      sun.intensity = on ? 3 : classic.sun;
      sun.color.set(on ? 0xfff2e2 : classic.sunColor);
      Object.assign(carMaterial, on ? { envMap: env, clearcoat: 0.7, clearcoatRoughness: 0.1, roughness: 0.6 } : { envMap: null, clearcoat: 0, roughness: 0.9 });
    },
    // Per rendered frame: dt in seconds (0 when paused), cars [{ cs, obj }], state.game_frame.
    update(dt, cars, frame) { effects.update(dt, cars, frame); },
    resize(w, h) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); },
    render() { U.uTime.value = performance.now() / 1000; sky.position.copy(camera.position); composer.render(); },
  };
}
