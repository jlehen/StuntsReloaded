// Race lifecycle, mirroring stuntsmainimpl/run_game: boot, load track or replay, set up, step.
import { M, A, G, DS, ww, farptr, setFarptr, farAlloc, heapReset, heapMark, loadExe } from './mem.js';
import { loadResfile, locateResource } from './files.js';
import { GAMESTATE, state, gameconfig } from './structs.js';
import { installStubs } from './engine.js';
import { callTop } from './calls.js';
import { enableStubs } from './stubs.js';
import { setTweaks, replayTweaks } from './tweaks.js';

// init_trackdata: one 'trakdata' block split into the td pointers (restunts.c).
const TD = [['td01_track_file_cpy', 0x70a], ['td02_penalty_related', 0x70a], ['trackdata3', 0x70a], ['td04_aerotable_pl', 0x80],
  ['td05_aerotable_op', 0x80], ['trackdata6', 0x80], ['trackdata7', 0x80], ['td08_direction_related', 0x60], ['trackdata9', 0x180],
  ['td10_track_check_rel', 0x120], ['td11_highscores', 0x16c], ['trackdata12', 0xf0], ['td13_rpl_header', 0x1a],
  ['td14_elem_map_main', 0x385], ['td15_terr_map_main', 0x385], ['td16_rpl_buffer', 0x2ee0], ['td17_trk_elem_ordered', 0x385],
  ['trackdata18', 0x385], ['trackdata19', 0x385], ['td20_trk_file_appnd', 0x7ac], ['td21_col_from_path', 0x385],
  ['td22_row_from_path', 0x385], ['trackdata23', 0x30]];
function initTrackdata() {
  let p = farAlloc(0x6bf3);
  for (const [name, size] of TD) { setFarptr(A[name], p); p += size; }
}
function initRowTables() {
  for (let i = 0; i < 30; i++) {
    ww(A.trackrows + i * 2, 30 * (29 - i)); ww(A.terrainrows + i * 2, 30 * i);
    ww(A.trackpos + i * 2, (29 - i) << 10); ww(A.trackpos2 + i * 2, i << 10);
    ww(A.trackcenterpos + i * 2, ((29 - i) << 10) + 0x200); ww(A.terrainpos + i * 2, i << 10);
    ww(A.terraincenterpos + i * 2, (i << 10) + 0x200); ww(A.trackcenterpos2 + i * 2, (i << 10) + 0x200);
  }
}
const SCR = DS + 0xafd0; // scratch for strings passed to original code (free DGROUP)
function nearStr(s) {
  for (let i = 0; i < s.length; i++) M[SCR + i] = s.charCodeAt(i);
  M[SCR + s.length] = 0;
  return SCR - DS;
}

// Startup (stuntsmainimpl before the menus). exe: GAME.EXE bytes.
export function boot(exe) {
  loadExe(exe);
  installStubs();
  enableStubs();
  initRowTables();
  callTop('init_polyinfo');
  initTrackdata();
  callTop('init_unknown');
  callTop('init_kevinrandom', DS + nearStr('kevin'));
  callTop('set_default_car');
  G.framespersec2 = 20;
  G.textresprefix = 0x65; // 'e': English text resources (init_main)
  G.passed_security = 1; // as restunts' main: otherwise the copy protection crashes the car after 4 s
  bootHeap = heapMark();
}
let bootHeap;
export const td = name => farptr(A[name]);
export const carId = arr => String.fromCharCode(...[0, 1, 2, 3].map(i => arr[i]));

// .TRK: 901 element bytes + 901 terrain bytes.
export function loadTrack(bytes) { M.set(bytes.subarray(0, 1802), td('td14_elem_map_main')); }
// .RPL: 26-byte GAMEINFO header, track, then one input byte per frame, then the tweaks the race
// was driven with, if any (tweaks.js), which are set for the playback. Returns frame count.
export function loadReplay(bytes) {
  M.fill(0, td('td16_rpl_buffer'), td('td16_rpl_buffer') + 0x2ee0);
  M.set(bytes.subarray(0, 0x1a + 1802 + 0x2ee0), td('td13_rpl_header'));
  M.copyWithin(A.gameconfig, td('td13_rpl_header'), td('td13_rpl_header') + 0x1a);
  setTweaks(replayTweaks(bytes, 0x1a + 1802 + gameconfig.game_recordedframes));
  return gameconfig.game_recordedframes;
}

// Race setup: track_setup, cars (setup_player_cars' gameplay parts), init_game_state.
// fps: 20 (or 10) for a new race; replays use their recorded rate.
export function setupRace(fps = gameconfig.game_framespersec || 20) {
  heapReset(bootHeap);
  G.run_game_random = callTop('get_kevinrandom') << 3; // run_game draws this first (clouds' azimuth offset)
  const err = callTop('track_setup') & 0xffff;
  if (err) throw new Error('track_setup error ' + err);
  // The original allocates 20 snapshots but writes up to 40 at 10 fps (cvx[frame / 300]); give it room.
  setFarptr(A.cvxptr, farAlloc(GAMESTATE.size * 40));
  const car = id => { const r = loadResfile('car' + id); if (!r) throw new Error('missing car ' + id); return r; };
  const p = car(carId(gameconfig.game_playercarid));
  callTop('setup_aero_trackdata', p, 0);
  if (gameconfig.game_opponenttype) {
    const o = car(carId(gameconfig.game_opponentcarid));
    callTop('setup_aero_trackdata', o, 1);
    callTop('load_opponent_data');
  }
  const game = loadResfile('game');
  setFarptr(A.gameresptr, game);
  setFarptr(A.planptr, locateResource(game, 'plan'));
  setFarptr(A.wallptr, locateResource(game, 'wall'));
  G.framespersec = fps;
  gameconfig.game_framespersec = fps;
  callTop('init_game_state', -1);
}

// One simulation tick with the given input byte (recorded into the replay buffer).
export function step(input) {
  if (input !== undefined) M[td('td16_rpl_buffer') + state.game_frame] = input;
  callTop('update_gamestate');
}
export { state, gameconfig };
