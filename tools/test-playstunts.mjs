// What makes the Mindscape build here interchangeable with playstunts, beyond the port itself
// (tools/trace-all.mjs): the two things it does that the original does not (version.js, rules),
// and the files traded with it. Run with STUNTS_VERSION=ms.
import { M } from '../src/mem.js';
import { VERSION, MS, rules } from '../src/version.js';
import { state } from '../src/structs.js';
import { bootWorld, gameFile } from './oracle.mjs';
import { SCENARIOS } from './trace.mjs';
import { enablePorts } from '../src/ports.js';
import { loadReplay, loadTrack, replayBuild, setupRace, step, gameconfig, RPL_HEADER } from '../src/race.js';
import { KEPT } from '../src/player.js';
import { parseHig, buildHig, parseBackup, buildBackup, HIG_SIZE } from '../src/interop.js';

if (!MS) { console.log('playstunts reconstructs the Mindscape build: run with STUNTS_VERSION=ms'); process.exit(1); }
enablePorts();
let ok = true;
const check = (name, fails) => { console.log(`${fails.length ? 'FAIL' : 'ok  '} ${name}`); for (const f of fails) console.log('  ' + f); ok &&= !fails.length; };
const P = () => state.playerstate;
const rsw = a => (M[a] | (M[a + 1] << 8)) << 16 >> 16;

// --- Its rules only matter to a car at rest: until one of the cars has stood still (or been
// wrecked), every scenario runs exactly as with the original's rules.
{
  const fails = [];
  let frames = 0, apart = 0;
  const atRest = c => c.car_speed2 < 11 || c.car_crashBmpFlag !== 0; // speed that scales to no movement
  for (const sc of SCENARIOS.filter(s => /default|manual|opp[135]|lap-JOES/.test(s.name))) {
    const n = Math.min(sc.frames ?? 1e9, 2500);
    const inputs = sc.input ? Array.from({ length: n }, () => sc.input()) : null; // the same for both runs
    const run = (on, each) => {
      rules.playstunts = on;
      bootWorld();
      const recorded = sc.setup();
      setupRace();
      for (let f = 0; f < Math.min(n, recorded ?? n); f++) { step(inputs ? inputs[f] : undefined); if (each(f) === false) break; }
    };
    const ref = [];
    let rested = Infinity;
    run(false, f => {
      ref.push(M.slice(state.addr, state.addr + state.constructor.size));
      if (rested === Infinity && f > 40 && (atRest(P()) || (gameconfig.game_opponenttype && atRest(state.opponentstate)))) rested = f;
    });
    run(true, f => {
      const cur = M.subarray(state.addr, state.addr + state.constructor.size);
      if (ref[f].every((v, i) => v === cur[i])) { frames++; return; }
      apart++;
      if (f < rested) fails.push(`${sc.name}: differs at frame ${f}, before a car is at rest (frame ${rested})`);
      return false;
    });
  }
  check(`the original's driving until a car is at rest (${frames} frames, ${apart} scenarios differ after that)`, fails);
}

// --- A stopped car with a wheel across a wall: the original divides by zero (its handler makes
// the quotient 0), playstunts moves the car clear, the crossing wheel 12 units before the wall.
{
  const fails = [], BARN = [9 * 1024 + 512, 16 * 1024 + 512];
  const tick = on => {
    rules.playstunts = on;
    bootWorld();
    loadTrack(gameFile('DEFAULT.TRK'));
    gameconfig.game_opponenttype = 0;
    setupRace();
    step(1);
    const p = P(), x = BARN[0], z = BARN[1] - 150 - 20; // the barn's south wall is 150 from its centre
    p.car_posWorld1.lx = x << 6; p.car_posWorld1.lz = z << 6;
    p.car_rotate.x = p.car_rotate.y = p.car_rotate.z = 0;
    p.car_speed = p.car_speed2 = 0;
    for (let i = 0; i < 4; i++) { const w = p.car_whlWorldCrds1[i]; w.x = x; w.y = p.car_posWorld1.ly >> 6; w.z = z - 200; } // they were outside
    step(0);
    return { crash: p.car_crashBmpFlag, wheels: [0, 1, 2, 3].map(i => [p.car_whlWorldCrds1[i].x - BARN[0], p.car_whlWorldCrds1[i].z - BARN[1]]) };
  };
  const orig = tick(false), ps = tick(true);
  const front = ps.wheels[0][1];
  if (ps.crash) fails.push('the car is wrecked');
  if (Math.abs(front + 162) > 1) fails.push(`the crossing wheel is at ${front} from the barn's centre, not 12 before its wall (-162)`);
  const gap = ps.wheels[2][1] - ps.wheels[0][1], gap0 = orig.wheels[2][1] - orig.wheels[0][1];
  if (Math.abs(gap - gap0) > 1) fails.push(`the wheels did not move together (wheelbase ${gap}, was ${gap0})`);
  if (orig.wheels[0][1] === front) fails.push('the original\'s rules give the same: the case is not exercised');
  check(`at rest across a wall: moved clear (front wheel ${orig.wheels[0][1]} -> ${front})`, fails);
}

// --- The wheel angles a stopped car reads: kept from its last moving tick, and with an opponent
// overwritten by the opponent's wheel origin, as on playstunts' (and the original's) stack.
{
  const fails = [];
  rules.playstunts = true;
  const start = opp => {
    bootWorld(); loadTrack(gameFile('DEFAULT.TRK'));
    for (let i = 0; i < 4; i++) { gameconfig.game_playercarid[i] = 'COUN'.charCodeAt(i); gameconfig.game_opponentcarid[i] = 'PMIN'.charCodeAt(i); }
    gameconfig.game_opponenttype = opp; setupRace();
  };
  const kept = o => [0, 2, 4, 6].map(i => rsw(KEPT + o + i));
  start(0);
  if (kept(0).some(Boolean) || kept(8).some(Boolean)) fails.push('not cleared for a new race');
  for (let f = 0; f < 60; f++) step(1 | 4); // accelerating, steering right
  const moving = kept(0), p = P();
  if (moving[2] !== moving[3] || moving[0] !== moving[1] || moving[0] === moving[2]) fails.push(`moving: ${moving} is not a steered front pair and a rear pair`);
  p.car_speed = p.car_speed2 = 0;
  for (let f = 0; f < 3; f++) { step(2); if (P().car_speed2) break; }
  if (P().car_speed2 === 0 && kept(0).some((v, i) => v !== moving[i])) fails.push(`stopped: the kept angles changed (${moving} -> ${kept(0)})`);
  start(2);
  for (let f = 0; f < 40; f++) step(1);
  const rear = [0, 2, 4, 6].map(i => rsw(state.opponentstate.$car_posWorld1 + 4 + i)); // y and z of the opponent, for scale
  const got = kept(0);
  if (Math.abs(((got[1] << 16) | (got[0] & 0xffff)) - ((rear[1] << 16) | (rear[0] & 0xffff))) > 0x8000) fails.push(`with an opponent: ${got} is not a wheel position of its car`);
  check('kept wheel angles', fails);
}

// --- Files. Replays: the 24-byte header, told apart from Broderbund's.
{
  const fails = [];
  const rpl = gameFile('DEFAULT.RPL');
  if (replayBuild(rpl) !== VERSION) fails.push('DEFAULT.RPL is not recognized as this build\'s');
  const bb = Uint8Array.of(...rpl.subarray(0, 22), 20, 0, ...rpl.subarray(22)); // the same with a frame rate word
  if (replayBuild(bb) !== 'bb') fails.push('a 26-byte header is not recognized as Broderbund\'s');
  if (replayBuild(Uint8Array.of(...rpl, 0x53, 0x52, 0x54, 0x31, 1, 50, 0, 0)) !== VERSION) fails.push('a replay with the tweaks trailer is not recognized');
  if (RPL_HEADER !== 0x18 || loadReplay(rpl) !== rpl.length - 0x18 - 1802) fails.push('header size or frame count');
  check('replay format', fails);
}
// High scores and the backup file.
{
  const fails = [];
  const scores = [{ name: 'ANNA', car: 'Lamborghini Countach', opponent: 'BR/INDY', lost: true, frames: 2337 },
    { name: 'A NAME OF 16 CHR', car: 'Porsche 962', opponent: '', lost: false, frames: 1200 }];
  const hig = buildHig(scores), back = parseHig(hig);
  if (hig.length !== HIG_SIZE) fails.push('size');
  if (JSON.stringify(back) !== JSON.stringify([scores[1], scores[0]])) fails.push('round trip: ' + JSON.stringify(back));
  // Bytes as the game lays them out: record 0 is the best; empty records are dots and FFFF.
  if (hig[50] !== 0xb0 || hig[51] !== 0x04 || hig[41] !== 2 || hig[42] !== 0x20) fails.push('record layout (time, solo marker)');
  if (hig[52 + 41] !== 1 || String.fromCharCode(...hig.subarray(52 + 42, 52 + 49)) !== 'BR/INDY') fails.push('record layout (opponent)');
  const empty = hig.subarray(2 * 52, 3 * 52);
  if (!empty.subarray(0, 40).every(b => b === 0x2e) || String.fromCharCode(...empty.subarray(42, 49)) !== '../....' || empty[50] !== 0xff || empty[51] !== 0xff) fails.push('empty record');
  const files = [{ name: 'DEFAULT', ext: 'TRK', bytes: gameFile('DEFAULT.TRK') }, { name: 'MY_TRK-1', ext: 'HIG', bytes: hig },
    { name: 'TOOLONGNAME', ext: 'RPL', bytes: gameFile('DEFAULT.RPL') }];
  const text = buildBackup(files), v = JSON.parse(text);
  // What playstunts checks on import (lib/game/save-backup.ts).
  if (v.format !== 'playstunts-backup' || v.version !== 1 || v.directory !== 'C:\\') fails.push('backup header');
  if (v.files.length !== 2 || v.files.some(f => !/^[A-Z]:\\/.test(f.key) || btoa(atob(f.bytes)) !== f.bytes)) fails.push('backup files (the name too long for it is left out)');
  const parsed = parseBackup(text);
  if (parsed.length !== 2 || parsed[0].name !== 'DEFAULT' || parsed[0].ext !== 'TRK' || parsed[0].bytes.length !== 1802 || parsed[1].bytes.some((b, i) => b !== hig[i])) fails.push('backup round trip');
  try { parseBackup('{"format":"other"}'); fails.push('accepts another format'); } catch { /* expected */ }
  check('high scores and backup file', fails);
}
process.exit(ok ? 0 : 1);
