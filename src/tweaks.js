// Optional departures from the original simulation, chosen per race in the menu and saved with its
// replay: steering assist and car fragility. At the defaults the ports are the original, bit for
// bit (tools/trace-all.mjs); each tweak is a branch the ports take only when it is set.
import { rsw, s16 } from './mem.js';
import { SIMD } from './structs.js';

// assist: steering assist. fragility: 0 (indestructible) .. 100 % (original).
// DEFAULTS is the original game, and what a replay without tweaks means; the menu's own defaults
// are main.js's settings.
export const DEFAULTS = Object.freeze({ assist: false, fragility: 100 });
export const tweaks = { ...DEFAULTS };
export function setTweaks(t = DEFAULTS) {
  tweaks.assist = !!t.assist;
  const f = Math.round(t.fragility);
  tweaks.fragility = f >= 0 && f <= 100 ? f : 100;
}
export const isDefault = (t = tweaks) => !t.assist && t.fragility === 100;
// For the menus: '' at the defaults.
export const describeTweaks = (t = tweaks) => [t.assist && 'steering assist', t.fragility !== 100 && `fragility ${t.fragility}%`].filter(Boolean).join(', ');

// --- Replays. Tweaked races append 8 bytes after the recorded inputs ('SRT1', assist, fragility,
// two spare); untweaked ones stay plain original .RPL files.
const MAGIC = [0x53, 0x52, 0x54, 0x31];
export const replayTrailer = (t = tweaks) => (isDefault(t) ? [] : [...MAGIC, t.assist ? 1 : 0, t.fragility, 0, 0]);
// The tweaks a replay was recorded with; `end` is where its inputs end.
export function replayTweaks(bytes, end) {
  if (!MAGIC.every((m, i) => bytes[end + i] === m)) return DEFAULTS;
  return { assist: bytes[end + 4] === 1, fragility: bytes[end + 5] };
}

// --- Fragility. The car survives 100/fragility times the impact the original allows.
// An original crash threshold (wall and landing speeds, car-car impact), scaled.
export const crashLimit = t0 => (tweaks.fragility === 100 ? t0 : tweaks.fragility ? t0 * 100 / tweaks.fragility : Infinity);
// Hits the original never survives (obstacles, rollovers, getting wedged): survivable up to
// 30 mph at 50 %, 90 mph at 25 %, any speed at 0 %.
export const survives = speed2 => tweaks.fragility < 100 && speed2 <= 0x1e00 * (100 / tweaks.fragility - 1);

// --- Steering assist, in place of upd_statef20_from_steer_input. The original wheel turns slowly
// (8 down to 1 units per tick, 240 for full lock), returns slowly, and keeps turning past what the
// tyres hold, where the car slides and spins. The assisted wheel stops at the largest angle the
// tyres hold on tarmac at the current speed (the test update_grip makes: speed^2 / 64 *
// (angle >> 3) <= grip), gets there in 4 ticks (at 20 fps), and is centred the tick after release.
// input: 1 right, 2 left, plus the stick deflection in bits 6-7 (0 full, 1..3: 3/4, 1/2, 1/4).
// Depends only on the car state, so replays and their snapshots reproduce it.
export function assistedSteering(c, simd, input, fps) {
  const v = c.car_speed >> 8, q = (v * v) >>> 6;
  const grip = s16((s16(new SIMD(simd).grip * 2) * rsw(simd + SIMD.offsets.sliding + 2) * 4) >> 10);
  const lock = q ? Math.min(0xf0, Math.floor(grip / q) * 8 + 7) : 0xf0;
  const dir = (input & 3) === 1 ? 1 : (input & 3) === 2 ? -1 : 0;
  const target = dir * Math.round(lock * (4 - ((input >> 6) & 3)) / 4);
  const angle = c.car_steeringAngle;
  const turningIn = angle * dir >= 0 && Math.abs(target) > Math.abs(angle);
  const step = turningIn ? Math.ceil(lock / (fps === 10 ? 2 : 4)) : lock;
  c.car_steeringAngle = Math.max(-lock, Math.min(lock, angle + Math.max(-step, Math.min(step, target - angle))));
}
