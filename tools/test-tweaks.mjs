// The tweaks (src/tweaks.js: steering assist, car fragility) change the simulation only where they
// say so. That the defaults are the original, bit for bit, is tools/trace-all.mjs's job; here:
// - fragility below 100 %: nothing changes before the frame the original wrecks the car;
// - fragility 0: the car is never wrecked, and what would wreck it (tree, wall, landing on the
//   roof) leaves it driveable;
// - steering assist: the wheel never asks more than the tyres hold on tarmac, at any speed, in
//   any car, and centres on release;
// - a tweaked race replays identically from its .RPL, seeking included.
// usage: node tools/test-tweaks.mjs
import { M, A, G } from '../src/mem.js';
import { GAMESTATE, state } from '../src/structs.js';
import { bootWorld, gameFile } from './oracle.mjs';
import { SCENARIOS } from './trace.mjs';
import { enablePorts } from '../src/ports.js';
import { callTop } from '../src/calls.js';
import { loadReplay, loadTrack, setupRace, step, gameconfig, td, RPL_HEADER } from '../src/race.js';
import { tweaks, setTweaks, replayTrailer, replayTweaks, crashLimit, survives, DEFAULTS } from '../src/tweaks.js';

enablePorts();
let ok = true;
const check = (name, fails, detail = '') => { console.log(`${fails.length ? 'FAIL' : 'ok  '} ${name}${detail}`); for (const f of fails.slice(0, 5)) console.log('  ' + f); ok &&= !fails.length; };
const P = () => state.playerstate;
const snapshot = () => M.slice(A.state, A.state + GAMESTATE.size);
const same = (a, b) => a.every((v, i) => v === b[i]);
const driven = SCENARIOS.filter(s => s.input); // the random drivers (tools/trace.mjs)
const start = (sc, t) => { bootWorld(); sc.setup(); setTweaks(t); setupRace(sc.fps ?? 20); };

// --- Limits.
{
  const fails = [];
  setTweaks({ fragility: 100 });
  if (crashLimit(0x1e00) !== 0x1e00 || survives(0)) fails.push('100 % is not the original');
  setTweaks({ fragility: 50 });
  if (crashLimit(0x1e00) !== 0x3c00 || !survives(0x1e00) || survives(0x1e01)) fails.push('50 %: twice the speed, 30 mph for obstacles');
  setTweaks({ fragility: 0 });
  if (crashLimit(1) !== Infinity || !survives(0xffff)) fails.push('0 % is not indestructible');
  for (const t of [{ assist: true, fragility: 100 }, { assist: false, fragility: 0 }, { assist: true, fragility: 35 }]) {
    const bytes = Uint8Array.of(1, 2, 3, ...replayTrailer(t)), back = replayTweaks(bytes, 3);
    if (back.assist !== t.assist || back.fragility !== t.fragility) fails.push('replay trailer ' + JSON.stringify(t));
  }
  if (replayTrailer(DEFAULTS).length || replayTweaks(gameFile('DEFAULT.RPL'), gameFile('DEFAULT.RPL').length) !== DEFAULTS) fails.push('plain replays have no trailer');
  check('limits and replay trailer', fails);
}

// --- Fragility below 100 %: identical to the original until it wrecks the car.
// --- Fragility 0: never wrecked.
{
  const fails = [], wrecked = [];
  let frames = 0, survived = 0;
  for (const sc of driven) {
    const n = sc.frames;
    start(sc, DEFAULTS);
    const inputs = [], orig = [];
    let crashAt = n;
    for (let f = 0; f < n; f++) {
      inputs.push(sc.input());
      step(inputs[f]);
      if (P().car_crashBmpFlag === 1) { crashAt = f; break; }
      orig.push(snapshot());
    }
    for (const fragility of [0, 50]) {
      start(sc, { fragility });
      for (let f = 0; f < crashAt; f++) {
        step(inputs[f]);
        if (!same(snapshot(), orig[f])) { fails.push(`${sc.name} at ${fragility} %: differs at frame ${f}, before the original's crash at ${crashAt}`); break; }
      }
      frames += crashAt;
      if (fragility) continue;
      for (let f = crashAt; f < n; f++) { // drive on past the crash
        step(f === crashAt ? inputs[f] : sc.input());
        if (P().car_crashBmpFlag === 1) { wrecked.push(`${sc.name}: wrecked at frame ${f}`); break; }
      }
      if (crashAt < n) survived++;
    }
  }
  check('fragility 0 and 50 %: the original until its crash', fails, ` (${frames} frames)`);
  check('fragility 0: never wrecked', wrecked, ` (${survived} crashes survived)`);
}

// --- What wrecks the original, on the default track: the car placed in front of it.
{
  const fails = [];
  // Car at (x, z) world units heading `yaw` (0 north, 0x100 west) at `mph`, `up` above the ground.
  const place = (x, z, { yaw = 0, mph = 0, up = 0, roll = 0, pitch = 0 }) => {
    bootWorld();
    loadTrack(gameFile('DEFAULT.TRK'));
    gameconfig.game_opponenttype = 0;
    setupRace(20);
    step(1);
    const p = P();
    p.car_posWorld1.lx = x << 6; p.car_posWorld1.lz = z << 6; p.car_posWorld1.ly += up << 6;
    p.car_rotate.x = yaw; p.car_rotate.y = pitch; p.car_rotate.z = roll;
    p.car_speed = p.car_speed2 = mph << 8;
    // Wheel positions of the tick before (the Mindscape build keeps one array of them, not two).
    for (let i = 0; i < 4; i++) for (const w of [p.car_whlWorldCrds1, p.car_whlWorldCrds2].filter(Boolean).map(a => a[i])) { w.x = x; w.y = p.car_posWorld1.ly >> 6; w.z = z; }
  };
  const run = (frames, input) => { for (let f = 0; f < frames && P().car_crashBmpFlag === 0; f++) step(typeof input === 'function' ? input(f) : input); };
  const pos = () => [P().car_posWorld1.lx >> 6, P().car_posWorld1.lz >> 6];
  const TREE = [8 * 1024 + 512, 4 * 1024 + 512], BARN = [9 * 1024 + 512, 16 * 1024 + 512], FIELD = [20 * 1024, 15 * 1024];

  // A tree, head on at 25 mph.
  for (const [fragility, mph, wreck] of [[100, 25, true], [50, 25, false], [50, 60, true], [0, 150, false]]) {
    setTweaks({ fragility });
    place(TREE[0], TREE[1] - 150, { mph });
    run(40, 1);
    if ((P().car_crashBmpFlag === 1) !== wreck) fails.push(`tree at ${mph} mph, fragility ${fragility}: ${wreck ? 'should wreck' : 'should survive'}`);
    if (!wreck && pos()[1] > TREE[1]) fails.push(`tree at ${mph} mph, fragility ${fragility}: went through it (z ${pos()[1]})`);
  }
  // ... and it can then be driven around: steering away gets the car past the tree.
  setTweaks({ fragility: 0 });
  place(TREE[0], TREE[1] - 150, { mph: 25 });
  for (let f = 0; f < 100 && pos()[1] < TREE[1]; f++) step(1 | 4);
  if (P().car_crashBmpFlag || pos()[1] < TREE[1]) fails.push(`tree: stuck at ${pos()}`);

  // A wall (the barn), head on at 80 mph: the original's limit there is 30 mph.
  for (const [fragility, wreck] of [[100, true], [50, true], [25, false], [0, false]]) {
    setTweaks({ fragility });
    place(BARN[0], BARN[1] - 400, { mph: 80 });
    let top = 0;
    run(30, f => { if (f > 20) top = Math.max(top, P().car_speed2 >> 8); return 0; });
    if ((P().car_crashBmpFlag === 1) !== wreck) fails.push(`wall at 80 mph, fragility ${fragility}: ${wreck ? 'should wreck' : 'should survive'}`);
    if (!wreck && top > 30) fails.push(`wall, fragility ${fragility}: still at ${top} mph after the hit`);
    if (!wreck && pos()[1] > BARN[1] - 100) fails.push(`wall, fragility ${fragility}: went through it (z ${pos()[1]})`);
  }

  // Upside down above a field (rolled over, or gone end over end and so flying tail first).
  for (const [name, attitude, north] of [['rolled', { roll: 0x200 }, true], ['end over end', { pitch: 0x200 }, false]]) {
    for (const fragility of [100, 0]) {
      setTweaks({ fragility });
      place(FIELD[0], FIELD[1], { mph: 40, up: 60, ...attitude });
      run(60, 0);
      const p = P(), z = pos()[1];
      if (fragility === 100) { if (p.car_crashBmpFlag !== 1) fails.push(`${name}: the original should wreck`); continue; }
      if (p.car_crashBmpFlag || Math.abs(p.car_rotate.z) > 0x20 || Math.abs(p.car_rotate.y) > 0x20) fails.push(`${name}: not back on its wheels (crash ${p.car_crashBmpFlag}, roll ${p.car_rotate.z}, pitch ${p.car_rotate.y})`);
      if (north ? z <= FIELD[1] : z >= FIELD[1]) fails.push(`${name}: went the wrong way (z ${z - FIELD[1]})`);
      run(60, 1);
      if (north ? pos()[1] <= z : pos()[1] >= z) fails.push(`${name}: turned around after landing`);
      if (!p.car_sumSurfAllWheels) fails.push(`${name}: never landed`);
    }
  }
  check('tree, wall and rollover: wrecked or survived as the fragility says', fails);
}

// --- Steering assist: holding the wheel never slides the car on tarmac; release centres it.
{
  const fails = [];
  let cases = 0;
  for (const car of ['COUN', 'ANSX', 'AUDI', 'FGTO', 'JAGU', 'LANC', 'LM02', 'P962', 'PC04', 'PMIN', 'VETT']) for (const fps of [20, 10]) {
    bootWorld();
    loadTrack(gameFile('DEFAULT.TRK'));
    for (let i = 0; i < 4; i++) gameconfig.game_playercarid[i] = car.charCodeAt(i);
    gameconfig.game_opponenttype = 0;
    setTweaks({ assist: true });
    setupRace(fps);
    step(1);
    const p = P();
    for (let mph = 0; mph < 250; mph += 3) {
      const locks = [];
      for (const level of [0xc0, 0x80, 0x40, 0]) { // quarter, half, three quarters, full
        p.car_steeringAngle = 0;
        p.car_36MwhlAngle = p.car_angle_z = 0;
        for (let tick = 0; tick < 6; tick++) {
          p.car_speed = p.car_speed2 = mph << 8;
          for (let w = 0; w < 4; w++) p.car_surfaceWhl[w] = 1;
          p.car_sumSurfAllWheels = 4;
          callTop('upd_statef20_from_steer_input', 2 | level);
          callTop('update_grip', p.addr, A.simd_player, 1);
          if (p.car_slidingFlag || p.car_demandedGrip > p.car_surfacegrip_sum) fails.push(`${car} ${fps} fps ${mph} mph: slides at steering ${p.car_steeringAngle}`);
        }
        locks.push(-p.car_steeringAngle);
        cases++;
      }
      if (locks.some((l, i) => l <= 0 || (i && l < locks[i - 1]))) fails.push(`${car} ${mph} mph: stick levels give ${locks}`);
      if (fps === 20 ? locks[3] > 0xf0 : false) fails.push(`${car} ${mph} mph: past full lock`);
      callTop('upd_statef20_from_steer_input', 0);
      if (p.car_steeringAngle !== 0) fails.push(`${car} ${mph} mph: not centred on release (${p.car_steeringAngle})`);
    }
  }
  check('steering assist: within the grip at every speed, centred on release', fails, ` (${cases} cases)`);
}

// --- A tweaked race replays identically from its .RPL, and seeks like the original.
{
  const fails = [];
  for (const sc of [driven[0], driven[2], driven.at(-1)]) {
    const t = { assist: true, fragility: 20 }, n = sc.frames;
    start(sc, t);
    let seed = 99;
    const stick = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 20) & 0xc0; // random stick deflection
    const snaps = [];
    for (let f = 0; f < n; f++) { const b = sc.input(); step(b & 12 ? b | stick() : b); snaps.push(snapshot()); }
    // The .RPL as main.js writes it: header, track, inputs, trailer.
    gameconfig.game_recordedframes = n;
    const hdr = td('td13_rpl_header');
    M.copyWithin(hdr, A.gameconfig, A.gameconfig + RPL_HEADER);
    const rpl = Uint8Array.of(...M.subarray(hdr, hdr + RPL_HEADER + 1802 + n), ...replayTrailer(t));
    bootWorld();
    setTweaks(DEFAULTS);
    if (loadReplay(rpl) !== n || !tweaks.assist || tweaks.fragility !== 20) fails.push(`${sc.name}: replay not loaded with its tweaks`);
    setupRace();
    G.game_replay_mode = 2;
    for (let f = 0; f < n; f++) { step(); if (!same(snapshot(), snaps[f])) { fails.push(`${sc.name}: replay differs at frame ${f}`); break; } }
    for (const target of [n >> 2, n - 7, n >> 1]) { // back and forth, as the replay bar does
      callTop('restore_gamestate', target);
      while (state.game_frame < target) step();
      if (!same(snapshot(), snaps[target - 1])) fails.push(`${sc.name}: seeking to frame ${target} differs`);
    }
  }
  check('tweaked races replay and seek identically', fails);
}

process.exit(ok ? 0 : 1);
