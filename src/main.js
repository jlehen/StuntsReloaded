// App: boots the engine on the game copy start.js loaded, runs menus, races and replays.
import { getFile } from './files.js';
import { boot, loadTrack, loadReplay, replayBuild, setupRace, step, state, gameconfig, carId, td, RPL_HEADER } from './race.js';
import { G, M, A, rsw, farptr } from './mem.js';
import { simd_player, fps } from './structs.js';
import { MS, VERSION, rules } from './version.js';
import { CARS, BUILDS, available, chooseBuild, addUserFiles } from './store.js';
import { createFx, addDetail, KIND } from './fx.js';
import { THREE, matCar, initMaterials, loadShapes, buildTrack, buildCar, carPose, paintColor, buildTruck, buildHorizon, paintHex, animateWheels, animateTrack, buildDebris, updateDebris, buildClouds, buildSigns, updateSigns } from './render.js';
import { multiply_and_scale, sin_fast, cos_fast } from './math.js';
import { callTop } from './calls.js';
import { bitmap, text } from './art.js';
import { initUI, show, showResults } from './ui.js';
import { createEditor } from './editor.js';
import { enablePorts } from './ports.js';
import { initAudio, updateAudio, setMuted, isMuted } from './audio.js';
import { tweaks, setTweaks, isDefault, describeTweaks, replayTrailer, replayTweaks, DEFAULTS } from './tweaks.js';
import { parseHig, buildHig, parseBackup, buildBackup } from './interop.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('stunts.' + k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('stunts.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } } };

// Shared tracks from the public 4dstunts-tracks bucket (the JSON API sends CORS headers), fetched while the game loads.
const GCS = 'https://storage.googleapis.com/storage/v1/b/4dstunts-tracks/o';
// ponytail: downloads every track at startup, fetch on demand if the bucket grows to thousands.
const remoteTracks = (async () => {
  const items = [];
  for (let page = ''; page != null;) {
    const r = await fetch(`${GCS}?fields=items(name),nextPageToken${page && '&pageToken=' + page}`);
    if (!r.ok) throw new Error(`track bucket: ${r.status}`);
    const j = await r.json();
    items.push(...(j.items ?? []).filter(o => /\.trk$/i.test(o.name)));
    page = j.nextPageToken;
  }
  return Object.fromEntries((await Promise.all(items.map(async o => {
    const r = await fetch(`${GCS}/${encodeURIComponent(o.name)}?alt=media`);
    return [o.name.split('/').pop().replace(/\.trk$/i, '').toUpperCase().slice(0, 8), new Uint8Array(await r.arrayBuffer())];
  }))).filter(([, b]) => b.length >= 1801));
})().catch(e => { console.warn(e); return {}; });

if (!params.has('original')) enablePorts(); // ?original runs only the original code
rules.playstunts = MS && !params.has('original'); // where playstunts departs from the original, follow it
boot(getFile('GAME.EXE'));
initMaterials();
const shapes = { ...loadShapes('GAME1.P3S'), ...loadShapes('GAME2.P3S') };

// --- Renderer, race scene, showroom -------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); // beyond 2 the cost grows faster than the sharpness
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.CustomToneMapping; // render.js: the original palette's colours as they are
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
const settings = Object.assign({ car: 'COUN', paint: 0, manual: false, opponent: 0, oppCar: 'PMIN', track: 'DEFAULT', enhanced: true,
  assist: false, fragility: 100, name: '', view: 0, chase: 1, fps: false }, store.get('settings', {})); // assist, fragility: the tweaks (tweaks.js)
// Best times are kept per track; apart for each combination of tweaks, and for each build (the
// two drive differently). Replays the player keeps: name -> base64 of the .RPL.
const hiKey = (track, t = tweaks) => `hi${isDefault(t) ? '.' : `:${t.assist ? 'a' : ''}${t.fragility}:`}${MS ? 'ms.' : ''}${track}`;
const replays = store.get('replays', {});
fx.enabled = settings.enhanced || params.has('enhanced');
const tracks = store.get('tracks', {}); // name -> base64 of the 1802-byte .TRK
const b64 = { enc: u => btoa(String.fromCharCode(...u)), dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)) };
const remote = await remoteTracks; // name -> bytes, imported tracks of the same name take precedence
const trackBytes = n => n !== 'DEFAULT' && tracks[n] ? b64.dec(tracks[n]) : n !== 'DEFAULT' && remote[n] ? remote[n] : getFile('DEFAULT.TRK');
if (settings.track !== 'DEFAULT' && !tracks[settings.track] && !remote[settings.track]) settings.track = 'DEFAULT';
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
  watchOpponent = false;
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
  loadTrack(feed ? feed.subarray(RPL_HEADER, RPL_HEADER + 1802) : trackBytes(settings.track));
  configure();
  if (feed) M.set(feed.subarray(0, 22), A.gameconfig); // its cars, gearbox and opponent
  setTweaks(params.has('original') ? DEFAULTS : settings); // the tweaks live in the ports
  tapped.clear();
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
  camMode = settings.view;
  mode = 'race';
  hideMenus();
}
function startReplay(bytes, { attract = false } = {}) {
  // A replay only plays back on the build that recorded it: the two drive differently.
  const build = replayBuild(bytes);
  if (build && build !== VERSION) {
    if (!available.includes(build)) alert(`This replay was recorded with ${BUILDS[build]}, which drives differently. Add that game's files (main menu) to watch it.`);
    else if (confirm(`This replay was recorded with ${BUILDS[build]}. Switch to it?`)) {
      try { sessionStorage.setItem('stunts.replay', b64.enc(bytes)); } catch { /* too large to carry over: load it again */ }
      return chooseBuild(build);
    }
    return toMenu();
  }
  replayFrames = loadReplay(bytes);
  try { setupRace(); } catch (e) { alert('Cannot play this replay: ' + e.message); return toMenu(); }
  G.game_replay_mode = 2;
  rebuildScene();
  for (let n = +params.get('skip') || 0; n > 0 && state.game_frame < replayFrames; n--) step();
  resetPoses();
  mode = attract ? 'attract' : 'replay';
  paused = false; replaySpeed = 1; $('rb-speed').textContent = '1×';
  camMode = attract ? 2 : settings.view; // the menu's demo is seen from the trackside cameras
  if (!attract) { hideMenus(); $('replaybar').hidden = false; }
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

// The race's replay bytes: header (GAMEINFO), track, inputs, and the tweaks it was driven with.
function replayBytes() {
  const hdr = td('td13_rpl_header');
  M.copyWithin(hdr, A.gameconfig, A.gameconfig + RPL_HEADER);
  const size = RPL_HEADER + 1802 + gameconfig.game_recordedframes, trailer = replayTrailer(), bytes = new Uint8Array(size + trailer.length);
  bytes.set(M.subarray(hdr, hdr + size));
  bytes.set(trailer, size);
  return bytes;
}

// --- Input --------------------------------------------------------------------------------
const keys = new Set();
const tapped = new Set(); // steering assist: keys pressed since the last tick, so that a tap shorter than a tick counts
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  keys.add(e.code);
  if (tweaks.assist) tapped.add(e.code);
  if (e.code === 'KeyC' && mode !== 'attract') setView((camMode + 1) % 3);
  // The original's (and playstunts') view keys: F1 in the car, F2 behind it, F3 trackside; T
  // watches the opponent, D hides the dashboard.
  const view = { F1: 1, F2: 0, F3: 2, F4: 0 }[e.code];
  if (view !== undefined && mode !== 'attract') { setView(view); e.preventDefault(); }
  if (e.code === 'KeyT' && mode !== 'attract' && oppObj) watchOpponent = !watchOpponent;
  if (e.code === 'KeyD' && mode !== 'attract') dashHidden = !dashHidden;
  // As playstunts: V cycles the chase camera's distance, F shows the frame rate.
  if (e.code === 'KeyV' && mode !== 'attract') { settings.chase = (settings.chase + 1) % CHASE.length; setView(0); }
  if (e.code === 'KeyF') { settings.fps = !settings.fps; store.set('settings', settings); $('fps').hidden = !settings.fps; }
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
  const x = p.axes[0] ?? 0, analog = tweaks.assist && !b(14) && !b(15);
  return (b(7) || b(0) ? 1 : 0) | (b(6) || b(1) ? 2 : 0) | (analog ? stickSteer(x) : (x > 0.35 || b(15) ? 4 : 0) | (x < -0.35 || b(14) ? 8 : 0)) |
    (b(5) ? 0x10 : 0) | (b(4) ? 0x20 : 0);
}
// Steering assist: the stick steers in proportion. The input byte has room for quarters of the
// deflection (bits 6-7: 0 full, 1..3: 3/4, 1/2, 1/4); the remainder carries over to the next
// ticks, which alternate between two quarters for the values in between.
let stickRest = 0;
function stickSteer(x) {
  stickRest += Math.min(1, Math.max(0, (Math.abs(x) - 0.12) / 0.8)) * 4; // dead zone 0.12, full lock from 0.92
  const quarters = Math.min(4, Math.floor(stickRest));
  stickRest -= quarters;
  return quarters ? (x > 0 ? 4 : 8) | ((4 - quarters) << 6) : 0;
}
function inputByte() {
  if (feed) return feed[RPL_HEADER + 1802 + (G.game_replay_mode === 1 ? 0 : state.game_frame)] ?? 0;
  const down = code => keys.has(code) || tapped.has(code);
  const b = (down('ArrowUp') || params.has('auto') ? 1 : 0) | (down('ArrowDown') ? 2 : 0) |
    (down('ArrowRight') ? 4 : 0) | (down('ArrowLeft') ? 8 : 0) |
    (down('KeyA') || down('Space') ? 0x10 : 0) | (down('KeyZ') || down('Enter') ? 0x20 : 0); // shifting: A / Z, or the original's Space / Enter
  tapped.clear();
  const pad = padByte();
  return b | (b & 12 ? pad & 0x3f : pad); // the keyboard steers at full deflection
}

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
    tweaks: describeTweaks(), hiKey: hiKey(settings.track),
  };
  mode = gameconfig.game_opponenttype && state.opponentstate.car_crashBmpFlag === 0 ? 'finishing' : 'results';
  if (mode === 'finishing') $('status').textContent = 'Waiting for your opponent…';
  else finishToResults();
}
function finishLoop() {
  const limit = 0x5dc * fps();
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
  const rate = fps(), o = state.opponentstate;
  const r = { ...result, time: fmtTime(result.frames), penalty: result.penaltyFrames ? fmtTime(result.penaltyFrames) : 0, highscores: [] };
  if (gameconfig.game_opponenttype) {
    const oppDone = o.car_crashBmpFlag === 3;
    const oppFrames = state.game_oEndFrame + G.elapsed_time1;
    r.opponent = { id: gameconfig.game_opponenttype, name: oppName(gameconfig.game_opponenttype), crashed: o.car_crashBmpFlag && !oppDone,
      time: oppDone ? fmtTime(oppFrames) : null, won: oppDone && (!result.finished || oppFrames < result.frames),
      decided: oppDone || result.finished }; // nobody finished: no winner, no reaction
  }
  if (result.finished) {
    const key = result.hiKey, list = store.get(key, []);
    // With what a .HIG record holds: the driver's name, and the opponent as the game writes it.
    const cstr = a => { let t = ''; while (M[a]) t += String.fromCharCode(M[a++]); return t; };
    const entry = { frames: result.frames, fps: rate, car: carNames[carId(gameconfig.game_playercarid)], date: new Date().toLocaleDateString(), at: Date.now(), name: settings.name,
      opponent: gameconfig.game_opponenttype ? `${cstr(A.unk_46464)}/${cstr(A.gsna_string)}` : '', lost: !!r.opponent?.won };
    list.push(entry); list.sort((a, b) => a.frames / a.fps - b.frames / b.fps); list.length = Math.min(list.length, 10);
    store.set(key, list);
    r.highscores = list.map(h => ({ ...h, time: fmtTime(h.frames, h.fps), current: h.at === entry.at }));
    r.rename = name => { // the name typed on the results screen
      settings.name = entry.name = name; store.set('settings', settings);
      const l = store.get(key, []), e = l.find(h => h.at === entry.at);
      if (e) { e.name = name; store.set(key, l); }
    };
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
// Chase camera distances (V): how far behind and above the car, how far ahead of it the camera
// looks, and the field of view.
const CHASE = [{ back: 150, up: 48, ahead: 70, fov: 56 }, { back: 215, up: 70, ahead: 90, fov: 58 }, { back: 300, up: 110, ahead: 0, fov: 60 }];
let lean = 0; // the chase camera swings out of a turn with the steering, to show the road ahead
let chaseYaw = 0, chaseY = 0; // its direction from the car, and its height
let watchOpponent = false, dashHidden = false; // T: the outside views follow the opponent's car; D: no dashboard
// The player's view is kept for the next races and replays.
function setView(v) { camMode = settings.view = v; store.set('settings', settings); }
const camPos = new THREE.Vector3(1e9, 0, 0), camTarget = new THREE.Vector3();
function updateCamera(dt) {
  const cockpit = camMode === 1 && mode !== 'attract';
  carObj.visible = !cockpit;
  if (oppObj) oppObj.visible = true;
  let fov = 60;
  if (cockpit) {
    // In-car camera (update_frame, cameramode 0): car position + car_height - 6 along the car's up axis.
    // The view centre sits in the windshield above the dashboard, as in the original.
    camera.setViewOffset(innerWidth, innerHeight * 1.35, 0, innerHeight * 0.35, innerWidth, innerHeight);
    camera.position.copy(carObj.position).add(new THREE.Vector3(0, simd_player.car_height - 6, 0).applyQuaternion(carObj.quaternion));
    camera.quaternion.copy(carObj.quaternion);
    setFov(fov);
    return;
  }
  camera.clearViewOffset();
  const subject = watchOpponent && oppObj ? oppObj : carObj;
  const look = subject.position.clone().add(new THREE.Vector3(0, 30, 0));
  if (camMode === 2) { // TV cameras placed by track_setup (trackdata9), picked per track section
    const i = state.field_3F7[subject === oppObj ? 1 : 0], t9 = farptr(A.trackdata9);
    camPos.set(rsw(t9 + i * 6), rsw(t9 + i * 6 + 2) + G.word_44D20 + 0x5a, -rsw(t9 + i * 6 + 4));
    camTarget.copy(look);
    // The cameras stand far from the track: zoom in so the car keeps a fair size on screen.
    fov = Math.max(10, Math.min(60, 2 * Math.atan(200 / camPos.distanceTo(look)) * 180 / Math.PI));
  } else {
    // Chase camera. The car model faces -z in Three.js space, so local +z points backwards.
    // It stays at its distance whatever the speed and turns after the car's heading, so the car
    // swings a little in the frame through a bend; its height follows more slowly (jumps).
    const c = CHASE[settings.chase] ?? CHASE[1];
    const steer = (subject === carObj ? state.playerstate : state.opponentstate).car_steeringAngle / 240;
    lean += (steer * 0.2 - lean) * (1 - Math.exp(-dt * 5));
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(subject.quaternion); back.y = 0;
    const jump = camPos.distanceTo(subject.position) > 1500; // a new race, a replay seek
    if (back.lengthSq() > 0.04) { // (not while the car points straight up or down, in a loop)
      const heading = Math.atan2(back.x, back.z);
      const turn = Math.atan2(Math.sin(heading - chaseYaw), Math.cos(heading - chaseYaw));
      chaseYaw = jump ? heading : chaseYaw + turn * (1 - Math.exp(-dt * 6));
    }
    const dir = new THREE.Vector3(Math.sin(chaseYaw + lean), 0, Math.cos(chaseYaw + lean));
    const y = subject.position.y + c.up;
    chaseY = jump ? y : chaseY + (y - chaseY) * (1 - Math.exp(-dt * 8));
    camPos.copy(subject.position).addScaledVector(dir, c.back).setY(chaseY);
    look.addScaledVector(dir, -c.ahead);
    if (jump) camTarget.copy(look); else camTarget.lerp(look, 1 - Math.exp(-dt * 14));
    fov = c.fov;
  }
  camera.position.copy(camPos);
  camera.lookAt(camTarget);
  setFov(fov);
}

function setFov(fov) {
  fov = camera.fov + (fov - camera.fov) * 0.2; // eased: the trackside cameras zoom, they do not jump
  if (Math.abs(fov - camera.fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); fx.cameraChanged(); }
}

// Original dashboard art (STDAxxxx.PVS) with needles from SIMD, as in setup_car_shapes.
let dashArt = null;
function drawDash() {
  const ctx = dash.getContext('2d');
  ctx.clearRect(0, 0, dash.width, dash.height);
  if (camMode !== 1 || dashHidden || mode === 'attract' || mode === 'results') return;
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
function fmtTime(frames, rate = fps() || 20) {
  const s = frames / rate;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
}
function updateHud() {
  const p = state.playerstate;
  $('hud').innerHTML = `<span>${fmtTime(state.game_frame + G.elapsed_time1)}</span><span>${Math.round(p.car_speed2 / 256)} mph</span>` +
    `<span>${p.car_currpm} rpm</span><span>gear ${p.car_current_gear}</span>` +
    (state.game_penalty ? `<span class="pen">+${fmtTime(state.game_penalty)}</span>` : '') +
    (mode === 'replay' ? `<span>${paused ? 'paused' : replaySpeed > 1 ? replaySpeed + '×' : 'replay'}</span>` : '');
}

function download(name, data) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data]));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- App API for the UI -------------------------------------------------------------------
// Name: 'Nickname]Name' or just 'Name' as the first line(s) of the description.
const oppName = i => { const d = text(`OPP${i}.PRE`, 'edes'); return d[1] || d[0] || `Opponent ${i}`; };
const app = {
  CARS, settings,
  builds: { available, names: BUILDS, current: VERSION, choose: chooseBuild, addFiles: addUserFiles,
    note: MS ? '' : 'Stunts 1.1 rules. playstunts drives 4D Sports Driving 1.1: add that game\'s files (folder or .zip) to race and trade replays with it.' },
  save: () => { store.set('settings', settings); fx.enabled = settings.enhanced || params.has('enhanced'); },
  startRace, startReplay, toMenu,
  carName: c => carNames[c],
  carDescription: c => text(`CAR${c}.RES`, 'edes'),
  carPaints: c => { const car0 = loadShapes(`ST${c}.P3S`).car0; return [...Array(car0.npaints)].map((_, i) => paintHex(car0, i)); },
  oppName,
  trackNames: () => ['DEFAULT', ...new Set([...Object.keys(tracks), ...Object.keys(remote)].filter(n => n !== 'DEFAULT').sort())],
  isImported: n => n !== 'DEFAULT' && !!tracks[n],
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
  // Saves the last race's replay as a file, and keeps it in the list (one per track).
  saveReplay() {
    download(`${settings.track}.RPL`, lastReplay);
    replays[settings.track] = b64.enc(lastReplay); store.set('replays', replays);
  },
  replayNames: () => Object.keys(replays).sort(),
  playReplay: n => startReplay(b64.dec(replays[n])),
  deleteReplay: n => { delete replays[n]; store.set('replays', replays); },
  // Files dropped on the page: a backup, a replay, tracks, or a copy of the game (which reloads
  // the page on its build). Returns a line for the menu, if any.
  async dropFiles(files) {
    const named = re => files.filter(f => re.test(f.name));
    for (const f of named(/\.json$/i)) { const n = app.importBackup(await f.text()); return `Imported ${n.tracks} tracks, ${n.replays} replays and ${n.scores} best times.`; }
    for (const f of named(/\.rpl$/i)) return void startReplay(new Uint8Array(await f.arrayBuffer()));
    const trks = named(/\.trk$/i);
    if (trks.length && !named(/\.(exe|hdr|zip)$/i).length) {
      for (const f of trks) app.importTrack(f.name.replace(/\.trk$/i, '').toUpperCase().slice(0, 8), new Uint8Array(await f.arrayBuffer()));
      return `Imported ${trks.length} track${trks.length > 1 ? 's' : ''}.`;
    }
    const build = await addUserFiles(files);
    if (build) chooseBuild(build);
    return build ? '' : 'Nothing to load in those files.';
  },
  // playstunts' backup file (interop.js): this build's tracks, kept replays and best times, as it
  // would have saved them. Tweaked races and replays stay here: it could not play them.
  exportBackup() {
    const files = Object.entries(tracks).map(([name, t]) => ({ name, ext: 'TRK', bytes: b64.dec(t) }));
    if (MS) {
      for (const [name, r] of Object.entries(replays)) {
        const bytes = b64.dec(r);
        if (replayBuild(bytes) === 'ms' && replayTweaks(bytes, bytes.length - 8) === DEFAULTS) files.push({ name, ext: 'RPL', bytes });
      }
      for (const name of ['DEFAULT', ...Object.keys(tracks), ...Object.keys(remote)]) {
        const list = store.get(hiKey(name, DEFAULTS), []).filter(h => h.fps === 20);
        if (list.length) files.push({ name, ext: 'HIG', bytes: buildHig(list) });
      }
    }
    download(`stunts-saves-${new Date().toISOString().slice(0, 10)}.json`, buildBackup(files));
    return files.length;
  },
  // Takes what it holds: tracks, replays (kept; played on the build that recorded them) and
  // best times (merged into this build's). Returns counts for the menu.
  importBackup(text) {
    const n = { tracks: 0, replays: 0, scores: 0 };
    for (const f of parseBackup(text)) {
      if (f.ext === 'TRK' && f.bytes.length === 1802) { tracks[f.name] = b64.enc(f.bytes); n.tracks++; }
      else if (f.ext === 'RPL' && f.bytes.length > 0x18 + 1802) { replays[f.name] = b64.enc(f.bytes); n.replays++; }
      else if (f.ext === 'HIG' && f.bytes.length === 364 && MS) {
        const key = hiKey(f.name, DEFAULTS), list = store.get(key, []);
        for (const h of parseHig(f.bytes)) {
          if (list.some(e => e.frames === h.frames && (e.name ?? '') === h.name && e.car === h.car)) continue;
          list.push({ ...h, fps: 20, date: '', at: Date.now() + n.scores++ });
        }
        list.sort((a, b) => a.frames / a.fps - b.frames / b.fps); list.length = Math.min(list.length, 10);
        store.set(key, list);
      }
    }
    store.set('tracks', tracks); store.set('replays', replays);
    return n;
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
$('rb-cam').onclick = () => setView((camMode + 1) % 3);
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
// Frame rate display (F), as playstunts': now, the average, and the slowest 1 % of the last minute.
const frameTimes = [];
let fpsShown = 0;
$('fps').hidden = !settings.fps;
function showFps(now, ms) {
  frameTimes.push(ms);
  if (frameTimes.length > 3600) frameTimes.shift();
  if (now - fpsShown < 500) return;
  fpsShown = now;
  const recent = frameTimes.slice(-30), mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const slow = [...frameTimes].sort((a, b) => b - a).slice(0, Math.max(1, Math.round(frameTimes.length / 100)));
  $('fps').textContent = `FPS ${Math.round(1000 / mean(recent))} · avg ${Math.round(1000 / mean(frameTimes))} · 1% low ${Math.round(1000 / mean(slow))}`;
}
function frame(now) {
  if (settings.fps) showFps(now, now - last);
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
  const tickS = 1 / (fps() || 20);
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
const carried = sessionStorage.getItem('stunts.replay'); // a replay that asked for this build (startReplay)
sessionStorage.removeItem('stunts.replay');
if (params.has('auto') || params.has('race') || feed) startRace(); // debug: race (?auto holds the accelerator)
else if (params.has('skip')) startReplay(getFile('DEFAULT.RPL'));
else if (carried) startReplay(b64.dec(carried));
else toMenu();
$('status').textContent = '';
// Debugging/testing handle (tools/browse.mjs): stunts.ff(n) runs n ticks at once.
window.stunts = {
  app, state, G, getFile, scene, fx, tweaks, inputByte, version: VERSION,
  get mode() { return mode; },
  ff(n) { for (let i = 0; i < n && mode !== 'results'; i++) { tick(); advancePoses(); } return state.game_frame; },
  seek(f) { $('rb-seek').oninput({ target: { value: f } }); return state.game_frame; }, // a replay, to frame f
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
