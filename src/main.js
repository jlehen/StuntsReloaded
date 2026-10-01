// App: loads the original files, boots the engine, runs menus, races and replays.
import { preload, getFile, loadCachedFiles, addUserFiles } from './files.js';
import { boot, loadTrack, loadReplay, setupRace, step, state, gameconfig, carId, td } from './race.js';
import { G, M, A, rsw, farptr } from './mem.js';
import { simd_player } from './structs.js';
import { createFx, addDetail, KIND } from './fx.js';
import { THREE, matCar, initMaterials, loadShapes, buildTrack, buildCar, carPose, paintColor, buildTruck, buildHorizon, paintHex, animateWheels, animateTrack, buildDebris, updateDebris, buildClouds, buildSigns, updateSigns } from './render.js';
import { multiply_and_scale, sin_fast, cos_fast } from './math.js';
import { callTop } from './calls.js';
import { bitmap, text } from './art.js';
import { initUI, show, showResults } from './ui.js';
import { createEditor } from './editor.js';
import { enablePorts } from './ports.js';
import { initAudio, updateAudio, setMuted, isMuted } from './audio.js';

const CARS = ['COUN', 'ANSX', 'AUDI', 'FGTO', 'JAGU', 'LANC', 'LM02', 'P962', 'PC04', 'PMIN', 'VETT'];
const GAME_FILES = ['GAME.EXE', 'GAME1.P3S', 'GAME2.P3S', 'GAME.PRE', 'SDMAIN.PVS', 'SDTITL.PVS', 'SDOSEL.PVS', 'DEFAULT.TRK', 'DEFAULT.RPL',
  ...CARS.flatMap(c => [`CAR${c}.RES`, `ST${c}.P3S`, `STDA${c}.PVS`, `STDB${c}.PVS`]),
  ...[1, 2, 3, 4, 5, 6].flatMap(i => [`OPP${i}.PRE`, `OPP${i}WIN.PVS`, `OPP${i}LOSE.PVS`]),
  'DESERT.PVS', 'TROPICAL.PVS', 'ALPINE.PVS', 'CITY.PVS', 'COUNTRY.PVS'];
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('stunts.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('stunts.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } } };

// Game files: served from game/, else the user's own copy (cached in IndexedDB), else restunts' copy on GitHub.
await preload(GAME_FILES);
if (!getFile('GAME.EXE')) await loadCachedFiles();
if (!getFile('GAME.EXE')) await preload(GAME_FILES.map(n => n === 'GAME.EXE' ? 'game.exe' : n), // lower-case there
  'https://raw.githubusercontent.com/4d-stunts/restunts/master/stunts/');
if (!getFile('GAME.EXE')) await askForFiles();
async function askForFiles() {
  $('status').textContent = '';
  $('files').hidden = false;
  await new Promise(resolve => {
    const take = async list => {
      await addUserFiles(list);
      if (getFile('GAME.EXE') && getFile('GAME1.P3S')) resolve();
      else $('files-msg').textContent = 'That folder does not look like Stunts 1.1 (GAME.EXE, GAME1.P3S… are missing).';
    };
    $('files-pick').onchange = e => take(e.target.files);
    addEventListener('dragover', e => e.preventDefault());
    addEventListener('drop', e => { e.preventDefault(); take(e.dataTransfer.files); });
  });
  $('files').hidden = true;
}
if (!params.has('original')) enablePorts(); // ?original runs only the original code
boot(getFile('GAME.EXE'));
initMaterials();
const shapes = { ...loadShapes('GAME1.P3S'), ...loadShapes('GAME2.P3S') };

// --- Renderer, race scene, showroom -------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const skyScene = new THREE.Scene(); // horizon and clouds, drawn in a separate pass behind the world
const sky = paintColor(17), groundColor = paintColor(16);
skyScene.background = sky;
skyScene.add(new THREE.HemisphereLight(0xdde8ff, groundColor, 1.2));
scene.fog = new THREE.Fog(sky, 12000, 40000);
const hemi = new THREE.HemisphereLight(0xdde8ff, groundColor, 1.2);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dd, 2.2);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -2500, right: 2500, top: 2500, bottom: -2500, near: 100, far: 10000 });
sun.shadow.bias = -0.0005;
scene.add(sun, sun.target);
const groundGeo = new THREE.PlaneGeometry(200000, 200000);
groundGeo.setAttribute('kind', new THREE.Float32BufferAttribute(Array(4).fill(KIND.grass), 1));
const ground = new THREE.Mesh(groundGeo, addDetail(new THREE.MeshStandardMaterial({ color: groundColor, roughness: 1, polygonOffset: true, polygonOffsetFactor: 4, polygonOffsetUnits: 16 })));
ground.rotation.x = -Math.PI / 2;
ground.position.set(15360, -1, -15360); // depth-offset behind the terrain tiles (lakes are at y 0)
ground.receiveShadow = true;
scene.add(ground);
const camera = new THREE.PerspectiveCamera(60, 1, 2, 60000);

const showroom = new THREE.Scene();
showroom.background = new THREE.Color(0x10141c);
showroom.add(new THREE.HemisphereLight(0xffffff, 0x223344, 1.4));
const spot = new THREE.DirectionalLight(0xffffff, 2.5); spot.position.set(200, 300, 150); showroom.add(spot);
const floor = new THREE.Mesh(new THREE.CircleGeometry(160, 64), new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 0.6 }));
floor.rotation.x = -Math.PI / 2; showroom.add(floor);
const showCam = new THREE.PerspectiveCamera(35, 1, 1, 5000);
const fx = createFx({ renderer, scene, skyScene, camera, sun, hemi, carMaterial: matCar, ground, groundColor });
let showCar = null, inShowroom = false;

const dash = $('dash');
function resize() {
  renderer.setSize(innerWidth, innerHeight);
  for (const c of [camera, showCam]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
  dash.width = innerWidth; dash.height = innerHeight;
  fx.resize(innerWidth, innerHeight);
}
addEventListener('resize', resize);

// --- Settings, tracks, highscores ---------------------------------------------------------
const settings = Object.assign({ car: 'COUN', paint: 0, manual: false, opponent: 0, oppCar: 'PMIN', track: 'DEFAULT', enhanced: true }, store.get('settings', {}));
fx.enabled = settings.enhanced || params.has('enhanced');
const tracks = store.get('tracks', {}); // name -> base64 of the 1802-byte .TRK
const b64 = { enc: u => btoa(String.fromCharCode(...u)), dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)) };
const trackBytes = n => n === 'DEFAULT' || !tracks[n] ? getFile('DEFAULT.TRK') : b64.dec(tracks[n]);
if (settings.track !== 'DEFAULT' && !tracks[settings.track]) settings.track = 'DEFAULT';
const carNames = Object.fromEntries(CARS.map(c => [c, text(`CAR${c}.RES`, 'gnam')[0] || c]));

// --- Scene contents -----------------------------------------------------------------------
let trackGroup = null, carObj = null, oppObj = null, truck = null, horizon = null, debris = null, clouds = null, signs = null;
function rebuildScene() {
  for (const o of [trackGroup, carObj, oppObj, debris, signs]) if (o) scene.remove(o);
  signs = buildSigns(shapes);
  scene.add(signs);
  for (const o of [horizon, clouds]) if (o) skyScene.remove(o);
  clouds = buildClouds(shapes, G.run_game_random);
  skyScene.add(clouds);
  debris = buildDebris(carId(gameconfig.game_playercarid), gameconfig.game_opponenttype ? carId(gameconfig.game_opponentcarid) : null,
    gameconfig.game_playermaterial, gameconfig.game_opponentmaterial);
  scene.add(debris);
  trackGroup = buildTrack(shapes);
  horizon = buildHorizon(M[td('td14_elem_map_main') + 900] % 5);
  fx.setScenery(M[td('td14_elem_map_main') + 900] % 5);
  carObj = buildCar(carId(gameconfig.game_playercarid), gameconfig.game_playermaterial);
  scene.add(trackGroup, carObj);
  skyScene.add(horizon);
  oppObj = null;
  if (gameconfig.game_opponenttype) {
    oppObj = buildCar(carId(gameconfig.game_opponentcarid), gameconfig.game_opponentmaterial);
    scene.add(oppObj);
  }
  dashArt = null;
}

// --- Modes --------------------------------------------------------------------------------
let mode = 'attract'; // attract | race | finishing | replay | results | editor
let replayFrames = 0, replaySpeed = 1, paused = false, lastReplay = null;

function configure() {
  for (let i = 0; i < 4; i++) {
    gameconfig.game_playercarid[i] = settings.car.charCodeAt(i);
    gameconfig.game_opponentcarid[i] = settings.oppCar.charCodeAt(i);
  }
  const name = settings.track.padEnd(9, '\0');
  for (let i = 0; i < 9; i++) gameconfig.game_trackname[i] = name.charCodeAt(i) & 0xff;
  gameconfig.game_playermaterial = settings.paint;
  gameconfig.game_playertransmission = settings.manual ? 0 : 1;
  gameconfig.game_opponenttype = settings.opponent;
  gameconfig.game_opponentmaterial = 0;
  gameconfig.game_recordedframes = 0;
}
function startRace() {
  loadTrack(feed ? feed.subarray(0x1a, 0x1a + 1802) : trackBytes(settings.track));
  configure();
  M.fill(0, td('td16_rpl_buffer'), td('td16_rpl_buffer') + 0x2ee0);
  try { setupRace(20); } catch (e) { alert('This track is not valid: ' + e.message); return toMenu(); }
  G.byte_449DA = 0;
  // run_game: the car starts behind the line and rolls out of the transporter truck.
  const p = state.playerstate, ang = G.track_angle;
  p.car_posWorld1.lx += multiply_and_scale(sin_fast(ang), -240) << 6;
  p.car_posWorld1.lz += multiply_and_scale(cos_fast(ang), -240) << 6;
  p.car_posWorld1.ly += 0x580;
  G.word_44DCA = 0;
  G.byte_4393C = 1;
  G.game_replay_mode = 1;
  rebuildScene();
  resetPoses();
  mode = 'race';
  hideMenus();
}
function startReplay(bytes, { attract = false } = {}) {
  replayFrames = loadReplay(bytes);
  try { setupRace(); } catch (e) { alert('Cannot play this replay: ' + e.message); return toMenu(); }
  G.game_replay_mode = 2;
  rebuildScene();
  for (let n = +params.get('skip') || 0; n > 0 && state.game_frame < replayFrames; n--) step();
  resetPoses();
  mode = attract ? 'attract' : 'replay';
  paused = false; replaySpeed = 1; $('rb-speed').textContent = '1×';
  if (attract) camMode = 2;
  else { hideMenus(); $('replaybar').hidden = false; }
}
function toMenu() {
  startReplay(getFile('DEFAULT.RPL'), { attract: true });
  $('replaybar').hidden = true;
  $('hud').hidden = true;
  show('main');
  ui.updateSummary();
}
function hideMenus() {
  show(null);
  $('hud').hidden = false;
  $('replaybar').hidden = true;
}

// The race's replay bytes: header (GAMEINFO), track, inputs.
function replayBytes() {
  const hdr = td('td13_rpl_header');
  M.copyWithin(hdr, A.gameconfig, A.gameconfig + 0x1a);
  return M.slice(hdr, hdr + 0x1a + 1802 + gameconfig.game_recordedframes);
}

// --- Input --------------------------------------------------------------------------------
const keys = new Set();
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  if (e.code === 'KeyC' && mode !== 'attract') camMode = (camMode + 1) % 3;
  if (e.code === 'Escape') {
    if (mode === 'race' || mode === 'finishing') toMenu();
    else if (mode === 'replay') lastReplay ? finishToResults() : toMenu();
  }
  if (e.code === 'KeyR' && (mode === 'race' || mode === 'results')) startRace();
  if (mode === 'replay' && e.code === 'Space') paused = !paused;
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code) && mode !== 'attract') e.preventDefault();
});
addEventListener('keyup', e => keys.delete(e.code));
for (const ev of ['pointerdown', 'keydown']) addEventListener(ev, () => initAudio(), { once: false, passive: true });
setMuted(store.get('muted', false));
addEventListener('keydown', e => { if (e.code === 'KeyM' && e.target.tagName !== 'INPUT') { setMuted(!isMuted()); store.set('muted', isMuted()); } });
addEventListener('blur', () => keys.clear());
// Debug: ?feed=X.RPL drives the race with a replay's recorded inputs.
const feed = params.get('feed') && getFile(params.get('feed'));
// Gamepad (standard mapping): stick/d-pad steer, RT or A accelerate, LT or B brake, RB/LB shift up/down.
function padByte() {
  const p = navigator.getGamepads?.().find(g => g?.mapping === 'standard');
  if (!p) return 0;
  const b = i => p.buttons[i]?.pressed || p.buttons[i]?.value > 0.3;
  return (b(7) || b(0) ? 1 : 0) | (b(6) || b(1) ? 2 : 0) | (p.axes[0] > 0.35 || b(15) ? 4 : 0) |
    (p.axes[0] < -0.35 || b(14) ? 8 : 0) | (b(5) ? 0x10 : 0) | (b(4) ? 0x20 : 0);
}
const inputByte = () => feed ? feed[0x1a + 1802 + (G.game_replay_mode === 1 ? 0 : state.game_frame)] ?? 0 :
  (keys.has('ArrowUp') || params.has('auto') ? 1 : 0) | (keys.has('ArrowDown') ? 2 : 0) |
  (keys.has('ArrowRight') ? 4 : 0) | (keys.has('ArrowLeft') ? 8 : 0) | (keys.has('KeyA') ? 0x10 : 0) | (keys.has('KeyZ') ? 0x20 : 0) | padByte();

// --- Simulation tick (run_game's loop) ------------------------------------------------------
function tick() {
  if (mode === 'attract' || mode === 'replay') {
    if (paused) return;
    if (state.game_frame < replayFrames) step();
    else if (mode === 'attract') startReplay(getFile('DEFAULT.RPL'), { attract: true });
  } else if (mode === 'race' && G.game_replay_mode === 1) { // roll-in: the original drives the car to the line
    const go = inputByte() & 3;
    if (!go) step(0);
    if (go || !G.byte_4393C) { G.game_replay_mode = 0; G.byte_4393C = 0; callTop('init_game_state', -1); resetPoses(); }
  } else if (mode === 'race') {
    // The timer records the input (replay_unk2), then run_game catches up with update_gamestate.
    callTop('replay_unk2', 0, inputByte());
    G.byte_46467 = 0; // "replay buffer full" dialog: keep racing (the window slides)
    while (state.game_frame !== G.elapsed_time2) step();
    if (state.game_inputmode === 0) { G.elapsed_time2 = 0; gameconfig.game_recordedframes = 0; state.game_frame = 0; } // waiting for the first input
    if (G.byte_449DA) finishRace();
  }
}

// After the player's race the opponent keeps driving until done (run_game's "cop" loop).
let result = null;
function finishRace() {
  lastReplay = replayBytes();
  const p = state.playerstate;
  result = {
    finished: p.car_crashBmpFlag === 3, drowned: p.car_crashBmpFlag === 2,
    frames: state.game_total_finish, penaltyFrames: state.game_penalty,
    topSpeed: Math.round(state.game_topSpeed / 256), jumps: state.game_jumpCount, impact: Math.round(state.game_impactSpeed / 256),
  };
  mode = gameconfig.game_opponenttype && state.opponentstate.car_crashBmpFlag === 0 ? 'finishing' : 'results';
  if (mode === 'finishing') $('status').textContent = 'Waiting for your opponent…';
  else finishToResults();
}
function finishLoop() {
  const limit = 0x5dc * G.framespersec;
  for (let i = 0; i < 400 && mode === 'finishing'; i++) {
    callTop('replay_unk2', 1, 0); // time limit only, nothing recorded
    step();
    if (state.opponentstate.car_crashBmpFlag !== 0 || state.game_frame + G.elapsed_time1 >= limit) finishToResults();
  }
}
function finishToResults() {
  mode = 'results';
  $('status').textContent = '';
  $('hud').hidden = true; $('replaybar').hidden = true;
  const fps = G.framespersec, o = state.opponentstate;
  const r = { ...result, time: fmtTime(result.frames), penalty: result.penaltyFrames ? fmtTime(result.penaltyFrames) : 0, highscores: [] };
  if (gameconfig.game_opponenttype) {
    const oppDone = o.car_crashBmpFlag === 3;
    const oppFrames = state.game_oEndFrame + G.elapsed_time1;
    r.opponent = { id: gameconfig.game_opponenttype, name: oppName(gameconfig.game_opponenttype), crashed: o.car_crashBmpFlag && !oppDone,
      time: oppDone ? fmtTime(oppFrames) : null, won: oppDone && (!result.finished || oppFrames < result.frames),
      decided: oppDone || result.finished }; // nobody finished: no winner, no reaction
  }
  if (result.finished) {
    const key = 'hi.' + settings.track, list = store.get(key, []);
    const entry = { frames: result.frames, fps, car: carNames[settings.car], date: new Date().toLocaleDateString(), at: Date.now() };
    list.push(entry); list.sort((a, b) => a.frames / a.fps - b.frames / b.fps); list.length = Math.min(list.length, 10);
    store.set(key, list);
    r.highscores = list.map(h => ({ ...h, time: fmtTime(h.frames, h.fps), current: h.at === entry.at }));
  }
  showResults(app, r);
}

// --- Poses, cameras, dashboard ------------------------------------------------------------
const poses = { prev: new THREE.Object3D(), cur: new THREE.Object3D(), oprev: new THREE.Object3D(), ocur: new THREE.Object3D() };
function resetPoses() {
  carPose(state.playerstate, poses.cur); poses.prev.copy(poses.cur);
  carPose(state.opponentstate, poses.ocur); poses.oprev.copy(poses.ocur);
  camPos.set(1e9, 0, 0);
}
function advancePoses() {
  poses.prev.copy(poses.cur); poses.oprev.copy(poses.ocur);
  carPose(state.playerstate, poses.cur); carPose(state.opponentstate, poses.ocur);
}
let camMode = 0; // 0 chase, 1 cockpit, 2 TV cameras
const camPos = new THREE.Vector3(1e9, 0, 0), camTarget = new THREE.Vector3();
function updateCamera(dt) {
  const cockpit = camMode === 1 && mode !== 'attract';
  carObj.visible = !cockpit;
  if (oppObj) oppObj.visible = true;
  if (cockpit) {
    // In-car camera (update_frame, cameramode 0): car position + car_height - 6 along the car's up axis.
    // The view centre sits in the windshield above the dashboard, as in the original.
    camera.setViewOffset(innerWidth, innerHeight * 1.35, 0, innerHeight * 0.35, innerWidth, innerHeight);
    camera.position.copy(carObj.position).add(new THREE.Vector3(0, simd_player.car_height - 6, 0).applyQuaternion(carObj.quaternion));
    camera.quaternion.copy(carObj.quaternion);
    return;
  }
  camera.clearViewOffset();
  const look = carObj.position.clone().add(new THREE.Vector3(0, 30, 0));
  if (camMode === 2) { // TV cameras placed by track_setup (trackdata9), picked per track section
    const i = state.field_3F7[0], t9 = farptr(A.trackdata9);
    camPos.set(rsw(t9 + i * 6), rsw(t9 + i * 6 + 2) + G.word_44D20 + 0x5a, -rsw(t9 + i * 6 + 4));
    camTarget.copy(look);
  } else {
    // Chase camera. The car model faces -z in Three.js space, so local +z points backwards.
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(carObj.quaternion); back.y = 0; back.normalize();
    const want = carObj.position.clone().addScaledVector(back, 300).add(new THREE.Vector3(0, 110, 0));
    if (camPos.distanceTo(want) > 1500) camPos.copy(want); else camPos.lerp(want, 1 - Math.exp(-dt * 4));
    if (camTarget.distanceTo(look) > 1500) camTarget.copy(look); else camTarget.lerp(look, 1 - Math.exp(-dt * 12));
  }
  camera.position.copy(camPos);
  camera.lookAt(camTarget);
}

// Original dashboard art (STDAxxxx.PVS) with needles from SIMD, as in setup_car_shapes.
let dashArt = null;
function drawDash() {
  const ctx = dash.getContext('2d');
  ctx.clearRect(0, 0, dash.width, dash.height);
  if (camMode !== 1 || mode === 'attract' || mode === 'results') return;
  dashArt ??= Object.fromEntries(['dash', 'roof', 'whl1', 'whl2', 'whl3', 'ins2'].map(n => [n, bitmap(`STDA${carId(gameconfig.game_playercarid)}.PVS`, n)]));
  const s = dash.width / 320, oy = dash.height - 200 * s;
  ctx.imageSmoothingEnabled = false;
  const put = img => img && ctx.drawImage(img, +img.dataset.x * s, +img.dataset.y * s + oy, img.width * s, img.height * s);
  if (dashArt.roof) ctx.drawImage(dashArt.roof, 0, 0, dash.width, dashArt.roof.height * s);
  put(dashArt.dash);
  const p = state.playerstate, steer = p.car_steeringAngle;
  put(steer > 16 ? dashArt.whl3 : steer < -16 ? dashArt.whl2 : dashArt.whl1);
  // Needle coordinates are relative to the instrument panel sprite (ins2, at 64,148).
  const bx = +(dashArt.ins2?.dataset.x ?? 64), by = +(dashArt.ins2?.dataset.y ?? 148);
  const X = x => (bx + x) * s, Y = y => (by + y) * s + oy;
  const needle = (cx, cy, pts, n, i) => {
    i = Math.min(i, n - 1);
    ctx.beginPath();
    ctx.moveTo(X(cx), Y(cy));
    ctx.lineTo(X(M[pts + i * 2]), Y(M[pts + i * 2 + 1]));
    ctx.strokeStyle = '#e8322a'; ctx.lineWidth = Math.max(1.5, s * 0.8); ctx.lineCap = 'round';
    ctx.stroke();
  };
  const sc = simd_player.spdcenter, rc = simd_player.revcenter;
  if (sc.py === 0) { // digital speedometer: one digit per point
    const mph = String(Math.round(p.car_speed / 256)).padStart(simd_player.spdnumpoints, ' ');
    ctx.fillStyle = '#ff4f3a'; ctx.font = `bold ${Math.round(7 * s)}px ui-monospace, monospace`; ctx.textBaseline = 'middle';
    for (let i = 0; i < simd_player.spdnumpoints; i++) ctx.fillText(mph[i], X(M[simd_player.$spdpoints + i * 2]), Y(M[simd_player.$spdpoints + i * 2 + 1]));
  } else if (sc.py !== -1) needle(sc.px, sc.py, simd_player.$spdpoints, simd_player.spdnumpoints, Math.floor(p.car_speed / 0x280));
  if (rc.py !== -1 && simd_player.revnumpoints) needle(rc.px, rc.py, simd_player.$revpoints, simd_player.revnumpoints, p.car_currpm >> 7);
}

// --- HUD ----------------------------------------------------------------------------------
function fmtTime(frames, fps = G.framespersec || 20) {
  const s = frames / fps;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}
function updateHud() {
  const p = state.playerstate;
  $('hud').innerHTML = `<span>${fmtTime(state.game_frame + G.elapsed_time1)}</span><span>${Math.round(p.car_speed2 / 256)} mph</span>` +
    `<span>${p.car_currpm} rpm</span><span>gear ${p.car_current_gear}</span>` +
    (state.game_penalty ? `<span class="pen">+${fmtTime(state.game_penalty)}</span>` : '') +
    (mode === 'replay' ? `<span>${paused ? 'paused' : replaySpeed > 1 ? replaySpeed + '×' : 'replay'}</span>` : '');
}

// --- App API for the UI -------------------------------------------------------------------
// Name: 'Nickname]Name' or just 'Name' as the first line(s) of the description.
const oppName = i => { const d = text(`OPP${i}.PRE`, 'edes'); return d[1] || d[0] || `Opponent ${i}`; };
const app = {
  CARS, settings,
  save: () => { store.set('settings', settings); fx.enabled = settings.enhanced || params.has('enhanced'); },
  startRace, startReplay, toMenu,
  carName: c => carNames[c],
  carDescription: c => text(`CAR${c}.RES`, 'edes'),
  carPaints: c => { const car0 = loadShapes(`ST${c}.P3S`).car0; return [...Array(car0.npaints)].map((_, i) => paintHex(car0, i)); },
  oppName,
  trackNames: () => ['DEFAULT', ...Object.keys(tracks).filter(n => n !== 'DEFAULT').sort()],
  trackBytes,
  importTrack: (n, bytes) => { if (bytes.length >= 1801) { tracks[n] = b64.enc(bytes.subarray(0, 1802)); store.set('tracks', tracks); settings.track = n; app.save(); } },
  deleteTrack: n => { delete tracks[n]; store.set('tracks', tracks); settings.track = 'DEFAULT'; app.save(); },
  showroom(on) {
    inShowroom = on;
    if (showCar) showroom.remove(showCar);
    showCar = on ? buildCar(settings.car, settings.paint) : null;
    if (showCar) showroom.add(showCar);
  },
  viewReplay: () => startReplay(lastReplay),
  saveReplay() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lastReplay]));
    a.download = `${settings.track}.RPL`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
};
const editor = createEditor({
  renderer, scene, shapes,
  setTrackGroup(g) { if (trackGroup) scene.remove(trackGroup); trackGroup = g; scene.add(g); },
  onSave(n, bytes) { app.importTrack(n, bytes); },
  onTestDrive(n, bytes) { app.importTrack(n, bytes); editor.close(); startRace(); },
  onExit() { editor.close(); toMenu(); show('tracks'); },
});
app.editTrack = n => {
  mode = 'editor';
  show(null); $('hud').hidden = true; $('replaybar').hidden = true;
  for (const o of [carObj, oppObj, truck]) if (o) o.visible = false;
  editor.open(n, trackBytes(n));
};
const ui = initUI(app);
$('rb-play').onclick = () => { paused = !paused; };
$('rb-restart').onclick = () => startReplay(lastReplay ?? getFile('DEFAULT.RPL'));
$('rb-speed').onclick = () => { replaySpeed = replaySpeed >= 4 ? 1 : replaySpeed * 2; $('rb-speed').textContent = replaySpeed + '×'; };
$('rb-cam').onclick = () => { camMode = (camMode + 1) % 3; };
// Seeking like the original: restore_gamestate (30 s snapshots), then simulate up to the target.
$('rb-seek').oninput = e => {
  const target = Math.min(+e.target.value, replayFrames);
  callTop('restore_gamestate', target);
  while (state.game_frame < target) step();
  resetPoses();
};
$('rb-exit').onclick = () => (lastReplay ? finishToResults() : toMenu());

// --- Main loop: fixed-rate simulation, interpolated rendering -------------------------------
let acc = 0, last = performance.now();
function frame(now) {
  const dt = Math.min(now - last, 250) / 1000; last = now;
  if (editor.active) { editor.render(); requestAnimationFrame(frame); return; }
  if (inShowroom) {
    const a = now / 4000;
    showCam.position.set(Math.cos(a) * 260, 90, Math.sin(a) * 260);
    showCam.lookAt(0, 10, 0);
    const free = $('cars').getBoundingClientRect().top || innerHeight; // centre the car in the space above the panel
    showCam.setViewOffset(innerWidth, innerHeight, 0, (innerHeight - free) / 2, innerWidth, innerHeight);
    renderer.clear();
    renderer.render(showroom, showCam);
    requestAnimationFrame(frame);
    return;
  }
  const tickS = 1 / (G.framespersec || 20);
  if (mode === 'finishing') finishLoop();
  else if (mode !== 'results') {
    acc += dt * (mode === 'replay' ? replaySpeed : 1);
    let n = 0;
    while (acc >= tickS && n++ < 20) { acc -= tickS; tick(); advancePoses(); }
    if (acc > tickS) acc = 0;
  }
  const t = Math.min(acc / tickS, 1);
  carObj.position.lerpVectors(poses.prev.position, poses.cur.position, t);
  carObj.quaternion.slerpQuaternions(poses.prev.quaternion, poses.cur.quaternion, t);
  if (oppObj) {
    oppObj.position.lerpVectors(poses.oprev.position, poses.ocur.position, t);
    oppObj.quaternion.slerpQuaternions(poses.oprev.quaternion, poses.ocur.quaternion, t);
  }
  animateWheels(carObj, state.playerstate);
  animateTrack(trackGroup, state.game_frame);
  updateSigns(signs, state);
  updateDebris(debris, state, [state.playerstate.car_posWorld1, state.opponentstate.car_posWorld1]);
  if (oppObj) animateWheels(oppObj, state.opponentstate);
  const truckAngle = state.game_inputmode === 0 && mode === 'race' ? G.word_44DCA : null; // door opens during the roll-in
  if (truck?.userData.angle !== truckAngle) {
    if (truck) scene.remove(truck);
    truck = truckAngle === null ? null : buildTruck(shapes, truckAngle);
    if (truck) { truck.userData.angle = truckAngle; scene.add(truck); }
  }
  updateCamera(dt);
  sun.position.copy(carObj.position).add(new THREE.Vector3(1500, 3000, 1000));
  sun.target.position.copy(carObj.position);
  horizon.position.copy(camera.position);
  horizon.visible = clouds.visible = !fx.enabled; // enhanced graphics has its own
  clouds.position.set(camera.position.x, 0, camera.position.z);
  if (mode === 'race' || mode === 'replay') updateHud();
  if (mode === 'replay' && document.activeElement !== $('rb-seek')) { $('rb-seek').max = replayFrames; $('rb-seek').value = state.game_frame; }
  const running = (mode === 'race' || mode === 'replay' || mode === 'finishing') && !paused;
  if (fx.enabled) fx.update(running ? dt * (mode === 'replay' ? replaySpeed : 1) : 0,
    [{ cs: state.playerstate, obj: carObj }, ...(oppObj ? [{ cs: state.opponentstate, obj: oppObj }] : [])], state.game_frame);
  updateAudio([{ cs: state.playerstate, active: true },
    { cs: state.opponentstate, active: !!gameconfig.game_opponenttype, distance: oppObj ? oppObj.position.distanceTo(camera.position) : 0 }], running);
  drawDash();
  renderWorld(camera);
  requestAnimationFrame(frame);
}
// Sky pass (horizon, clouds) then the world with a cleared depth buffer.
renderer.autoClear = false;
function renderWorld(cam) {
  if (fx.enabled && cam === camera) return fx.render();
  renderer.clear();
  renderer.render(skyScene, cam);
  renderer.clearDepth();
  renderer.render(scene, cam);
}

resize();
if (params.has('auto') || params.has('race') || feed) startRace(); // debug: race (?auto holds the accelerator)
else if (params.has('skip')) startReplay(getFile('DEFAULT.RPL'));
else toMenu();
$('status').textContent = '';
// Debugging/testing handle (tools/browse.mjs): stunts.ff(n) runs n ticks at once.
window.stunts = {
  app, state, G, getFile, scene, fx,
  get mode() { return mode; },
  ff(n) { for (let i = 0; i < n && mode !== 'results'; i++) { tick(); advancePoses(); } return state.game_frame; },
  // Height of the rendered track under each physics wheel contact point (should match wheel y).
  checkWheels() {
    const ray = new THREE.Raycaster();
    return [0, 1, 2, 3].map(i => {
      const w = state.playerstate.car_whlWorldCrds1[i];
      ray.set(new THREE.Vector3(w.x, w.y + 300, -w.z), new THREE.Vector3(0, -1, 0));
      const hit = ray.intersectObject(trackGroup, true)[0];
      return [w.y, hit ? Math.round(hit.point.y) : null];
    });
  },
};
requestAnimationFrame(frame);
