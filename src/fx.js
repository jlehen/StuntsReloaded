// Enhanced graphics (menu option): gradient sky with sun and haze, glossy car paint reflecting it,
// procedural surface detail, bloom and a colour grade. Rendering only, the simulation is untouched.
import * as THREE from '../vendor/three.module.js';
import { EffectComposer } from '../vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../vendor/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../vendor/addons/postprocessing/OutputPass.js';
import { ShaderPass } from '../vendor/addons/postprocessing/ShaderPass.js';

// World-space value noise multiplied into the paint colours: large patches plus fine grain that
// fades with distance (it would shimmer). Strength 0 leaves the classic look.
const detail = { value: 0 };
export function addDetail(material) {
  material.onBeforeCompile = s => {
    s.uniforms.uDetail = detail;
    s.vertexShader = s.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    s.fragmentShader = s.fragmentShader.replace('#include <common>', `#include <common>
varying vec3 vWPos;
uniform float uDetail;
float h3(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}`).replace('#include <color_fragment>', `#include <color_fragment>
if (uDetail > 0.0) {
  float dist = length(vViewPosition), near = smoothstep(2500.0, 300.0, dist);
  float n = 0.6 * vnoise(vWPos / 900.0) + 0.4 * mix(0.5, vnoise(vWPos / 40.0), near);
  n += 0.25 * near * (vnoise(vWPos / 6.0) - 0.5);
  float w = vnoise(vWPos / 2500.0 + 7.0) - 0.5; // warm/cool patches
  diffuseColor.rgb *= mix(vec3(1.0), (0.74 + 0.52 * n) * vec3(1.0 + 0.08 * w, 1.0 + 0.03 * w, 1.0 - 0.08 * w), uDetail * smoothstep(30000.0, 8000.0, dist));
}`);
  };
  return material;
}

export function createFx({ renderer, scene, skyScene, camera, sun, hemi, carMaterial, groundColor }) {
  const skyHemi = skyScene.children.find(o => o.isHemisphereLight); // lights the clouds
  const classic = { skyHemi: skyHemi.intensity, background: skyScene.background, fog: scene.fog, hemi: hemi.intensity, hemiColor: hemi.color.getHex(), sun: sun.intensity, sunColor: sun.color.getHex() };
  const horizon = new THREE.Color(0xb3d1ec), zenith = new THREE.Color(0x1a56c2);
  const fog = new THREE.Fog(horizon, 2500, 90000); // haze; never full, so the ground still meets the horizon art

  // Gradient sky with a sun glow; the sun sits where main.js places the shadow light.
  const sunDir = new THREE.Vector3(1500, 3000, 1000).normalize();
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    // Below the horizon: the hazed ground, seen between the ground's far-plane edge and the horizon art.
    uniforms: { horizon: { value: horizon }, zenith: { value: zenith }, sunDir: { value: sunDir }, ground: { value: groundColor.clone().lerp(horizon, 0.65) } },
    vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `varying vec3 vDir; uniform vec3 horizon, zenith, sunDir, ground;
void main() {
  vec3 d = normalize(vDir);
  vec3 c = mix(mix(horizon, ground, smoothstep(0.0, -0.003, d.y)), zenith, pow(max(d.y, 0.0), 0.45));
  float s = max(dot(d, sunDir), 0.0);
  c += vec3(1.0, 0.85, 0.6) * (0.35 * pow(s, 12.0) + 0.6 * pow(s, 300.0) + 30.0 * smoothstep(0.9994, 0.9996, s));
  gl_FragColor = vec4(c, 1.0);
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

  let on = false;
  return {
    get enabled() { return on; },
    set enabled(v) {
      on = v;
      detail.value = on ? 1 : 0;
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
    resize(w, h) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); },
    render() { sky.position.copy(camera.position); composer.render(); },
  };
}
