// Runs a replay through the simulation and prints a summary (original code unless ports are hooked).
// usage: node tools/world.mjs [REPLAY.RPL]
import { bootWorld, gameFile, cpu } from './oracle.mjs';
import { loadReplay, setupRace, step, state, gameconfig, carId } from '../src/race.js';
import { G } from '../src/mem.js';

bootWorld();
const n = loadReplay(gameFile(process.argv[2] ?? 'DEFAULT.RPL'));
console.log('frames', n, 'fps', gameconfig.game_framespersec ?? 20, 'car', carId(gameconfig.game_playercarid), 'opponent', gameconfig.game_opponenttype);
setupRace();
console.log('start col/row', G.startcol2, G.startrow2, 'angle', G.track_angle);
const t0 = Date.now();
for (let f = 0; f < n; f++) {
  step();
  const p = state.playerstate;
  if (f % 100 === 0 || f === n - 1) console.log(state.game_frame, 'pos', p.car_posWorld1.lx >> 6, p.car_posWorld1.ly >> 6, p.car_posWorld1.lz >> 6, 'rot', p.car_rotate.x, 'speed', p.car_speed2 >> 8, 'gear', p.car_current_gear, 'crash', p.car_crashBmpFlag, 'finish', state.game_total_finish);
}
console.log('ms', Date.now() - t0, 'instructions', cpu.steps);
