// Enhanced graphics, the frame's way to the screen: the sky and the world are drawn into one
// multisampled HDR target, a bloom is built from it at a quarter of the resolution (downsampled
// to a few mips, then added back up), and a single pass tone-maps, grades and outputs the sum.
// (Three's EffectComposer with UnrealBloomPass did the same in a dozen full-size passes on
// multisampled targets: over a third of the frame time.)
import * as THREE from '../vendor/three.module.js';
import { FullScreenQuad } from '../vendor/addons/postprocessing/Pass.js';

const VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
const pass = (fragmentShader, uniforms, extra = {}) => new FullScreenQuad(new THREE.ShaderMaterial({
  vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, toneMapped: false, ...extra }));
const MIPS = 4;

export function createPost(renderer, { strength = 0.3, threshold = 1.0 } = {}) {
  const scene = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const mips = Array.from({ length: MIPS }, () => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
  // Down: 4 bilinear taps (a 4x4 box); the first one also keeps only what is brighter than the
  // threshold, softly. Up: a 3x3 tent of the smaller mip, added to the larger one.
  const down = pass(`uniform sampler2D tMap; uniform vec2 uTexel; uniform float uThreshold; varying vec2 vUv;
void main() {
  vec3 c = 0.25 * (texture2D(tMap, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb
    + texture2D(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tMap, vUv + uTexel * vec2(1.0, 1.0)).rgb);
  if (uThreshold > 0.0) { // by luminance: a saturated paint in the sun is not a light
    c *= smoothstep(uThreshold, uThreshold * 1.5, dot(c, vec3(0.2126, 0.7152, 0.0722)));
    c = min(c, vec3(12.0));
  }
  gl_FragColor = vec4(c, 1.0);
}`, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 } });
  const up = pass(`uniform sampler2D tMap; uniform vec2 uTexel; varying vec2 vUv;
void main() {
  vec3 c = 4.0 * texture2D(tMap, vUv).rgb;
  c += 2.0 * (texture2D(tMap, vUv + uTexel * vec2(1.0, 0.0)).rgb + texture2D(tMap, vUv - uTexel * vec2(1.0, 0.0)).rgb
    + texture2D(tMap, vUv + uTexel * vec2(0.0, 1.0)).rgb + texture2D(tMap, vUv - uTexel * vec2(0.0, 1.0)).rgb);
  c += texture2D(tMap, vUv + uTexel).rgb + texture2D(tMap, vUv - uTexel).rgb
    + texture2D(tMap, vUv + uTexel * vec2(1.0, -1.0)).rgb + texture2D(tMap, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 16.0, 1.0);
}`, { tMap: { value: null }, uTexel: { value: new THREE.Vector2() } }, { blending: THREE.AdditiveBlending, transparent: true });
  // Output: scene + bloom, the renderer's tone mapping and colour space, then (in display space)
  // a touch of saturation and contrast and a soft vignette.
  const out = pass(`uniform sampler2D tScene, tBloom; uniform float uStrength; varying vec2 vUv;
void main() {
  gl_FragColor = vec4(texture2D(tScene, vUv).rgb + uStrength * texture2D(tBloom, vUv).rgb, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  vec3 c = gl_FragColor.rgb;
  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, 1.06);
  c = (c - 0.5) * 1.04 + 0.5;
  vec2 v = vUv - 0.5;
  gl_FragColor = vec4(c * (1.0 - 0.35 * dot(v, v)), 1.0);
}`, { tScene: { value: scene.texture }, tBloom: { value: mips[0].texture }, uStrength: { value: strength } }, { toneMapped: true });

  const size = new THREE.Vector2();
  return {
    // w, h in CSS pixels; the targets take the renderer's pixel ratio.
    setSize(w, h) {
      const r = renderer.getPixelRatio();
      scene.setSize(Math.round(w * r), Math.round(h * r));
      let mw = Math.max(2, scene.width >> 2), mh = Math.max(2, scene.height >> 2);
      for (const m of mips) { m.setSize(mw, mh); mw = Math.max(1, mw >> 1); mh = Math.max(1, mh >> 1); }
    },
    render(sky, world, camera) {
      const auto = renderer.autoClear;
      renderer.autoClear = false;
      renderer.setRenderTarget(scene);
      renderer.clear();
      renderer.render(sky, camera);
      renderer.clearDepth();
      renderer.render(world, camera);
      // Bloom: threshold into mip 0, down the chain, and back up adding each level.
      let src = scene;
      for (let i = 0; i < MIPS; i++) {
        down.material.uniforms.tMap.value = src.texture;
        down.material.uniforms.uTexel.value.set(0.5 / mips[i].width, 0.5 / mips[i].height);
        down.material.uniforms.uThreshold.value = i ? 0 : threshold;
        renderer.setRenderTarget(mips[i]);
        down.render(renderer);
        src = mips[i];
      }
      for (let i = MIPS - 1; i > 0; i--) {
        up.material.uniforms.tMap.value = mips[i].texture;
        up.material.uniforms.uTexel.value.set(1 / mips[i].width, 1 / mips[i].height);
        renderer.setRenderTarget(mips[i - 1]);
        up.render(renderer);
      }
      renderer.setRenderTarget(null);
      renderer.getSize(size);
      out.render(renderer);
      renderer.autoClear = auto;
    },
    strength: out.material.uniforms.uStrength,
  };
}
