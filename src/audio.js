// Synthesized sound (WebAudio), driven by the simulation state each frame: engine by rpm and
// throttle, tyre squeal while sliding, scrape on wall contact (field_CF & 0x10), thump on hard
// wheel impacts (field_CF & 0x20), crash burst when the car crashes.
let ctx = null, master = null, noiseBuf = null;
const engines = [];

function noise() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf; s.loop = true;
  return s;
}

// Engine voice: two detuned sawtooths + a sub square, through a lowpass that opens with throttle.
function engineVoice() {
  const out = ctx.createGain(); out.gain.value = 0;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 4;
  const oscs = [['sawtooth', 1], ['sawtooth', 1.007], ['square', 0.5]].map(([type, mul]) => {
    const o = ctx.createOscillator(); o.type = type;
    const g = ctx.createGain(); g.gain.value = type === 'square' ? 0.35 : 0.5;
    o.connect(g).connect(lp); o.start();
    return { o, mul };
  });
  lp.connect(out).connect(master);
  return { out, lp, oscs };
}
// Looped filtered noise with a gain we can ramp (squeal, scrape).
function noiseVoice(type, freq, q) {
  const n = noise(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  f.type = type; f.frequency.value = freq; f.Q.value = q; g.gain.value = 0;
  n.connect(f).connect(g).connect(master); n.start();
  return g;
}
function burst(freq, dur, vol) {
  const n = noise(), f = ctx.createBiquadFilter(), g = ctx.createGain(), t = ctx.currentTime;
  f.type = 'lowpass'; f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(80, t + dur);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  n.connect(f).connect(g).connect(master); n.start(t); n.stop(t + dur);
}

let squeal, scrape, lastCrash = [0, 0], muted = false;
export function initAudio() {
  if (ctx) return ctx.resume();
  ctx = new AudioContext();
  master = ctx.createGain(); master.gain.value = muted ? 0 : 0.5;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);
  engines.push(engineVoice(), engineVoice());
  squeal = noiseVoice('bandpass', 2400, 6);
  scrape = noiseVoice('bandpass', 700, 1.5);
}
export function setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : 0.5; }
export const isMuted = () => muted;

// cars: [{ cs: CARSTATE view, active, distance }] (player first). running: simulation is live.
export function updateAudio(cars, running) {
  if (!ctx) return;
  const t = ctx.currentTime;
  cars.forEach((car, i) => {
    const v = engines[i];
    if (!car?.active || !running) { v.out.gain.setTargetAtTime(0, t, 0.05); return; }
    const cs = car.cs;
    const rpm = cs.car_currpm, throttle = cs.car_is_accelerating ? 1 : 0.35;
    const base = 18 + rpm / 60; // firing frequency
    for (const o of v.oscs) o.o.frequency.setTargetAtTime(base * o.mul, t, 0.03);
    v.lp.frequency.setTargetAtTime(300 + rpm / 5 * throttle, t, 0.05);
    const att = 1 / (1 + (car.distance ?? 0) / 800);
    const crashed = cs.car_crashBmpFlag === 1 || cs.car_crashBmpFlag === 2;
    v.out.gain.setTargetAtTime(crashed ? 0 : (0.12 + 0.1 * throttle) * att, t, 0.05);
    if (i === 0) {
      const sliding = cs.car_slidingFlag && cs.car_speed2 > 0x800 && cs.car_sumSurfAllWheels;
      squeal.gain.setTargetAtTime(sliding ? 0.08 : 0, t, 0.04);
      scrape.gain.setTargetAtTime(cs.field_CF & 0x10 ? 0.25 : 0, t, 0.03);
      if (cs.field_CF & 0x20) burst(400, 0.2, 0.5);
    }
    if (cs.car_crashBmpFlag === 1 && lastCrash[i] !== 1) burst(3000, 1.2, att);
    if (cs.car_crashBmpFlag === 2 && lastCrash[i] !== 2) burst(900, 1.6, 0.6 * att);
    lastCrash[i] = cs.car_crashBmpFlag;
  });
}
