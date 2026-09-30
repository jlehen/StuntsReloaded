// Track editor: top-down view of the real 3D track, a palette built from the original element
// table, and validation by the original track_setup (same error codes as the original editor).
import { M, A, DS, rsw, rw, rb, rsb } from './mem.js';
import { loadTrack } from './race.js';
import { call } from './calls.js';
import { THREE, buildTrack, Builder, ANGLE } from './render.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };

// Messages for track_setup's return codes (enum_track_errors; see track.js).
const ERRORS = ['', 'No start/finish line', 'A piece is entered from a side it has no road on', 'More than one start/finish line',
  'Pieces do not connect (ground/elevated mismatch)', 'Road is driven the wrong way', 'Too many pieces', 'The road never returns to the start',
  'Too many split roads', 'Not enough runway before the jump', 'Jump is too long', 'Terrain edges do not match'];

// Friendly names by 3D shape name.
const NAMES = { road: 'Road', turn: 'Sharp corner', stur: 'Corner', fini: 'Start/finish', elrd: 'Elevated road', ramp: 'Ramp',
  rban: 'Banked road (right)', lban: 'Banked road (left)', bank: 'Banked road', btur: 'Banked corner', brid: 'Bridge ramp',
  chi1: 'Chicane (left)', chi2: 'Chicane (right)', loop: 'Loop', tunn: 'Tunnel', pipe: 'Pipe', spip: 'Pipe entrance', inte: 'Crossroad',
  offl: 'Split road (left)', offr: 'Split road (right)', hpip: 'Half pipe', vcor: 'Corkscrew (up/down)', sofl: 'Highway split (left)',
  sofr: 'Highway split (right)', sram: 'Solid ramp', selr: 'Solid road', elsp: 'Elevated span', sest: 'Elevated corner',
  wroa: 'Slalom road', gwro: 'Paved slalom', barr: 'Barrier', lco0: 'Corkscrew (left)', rco0: 'Corkscrew (right)', rdup: 'Hill road',
  palm: 'Palm tree', cact: 'Cactus', tree: 'Tree', tenn: 'Tennis court', gass: 'Gas station', barn: 'Barn', offi: 'Office building',
  wind: 'Windmill', boat: 'Boat', rest: 'Restaurant' };
const SURFACES = ['', ' (dirt)', ' (ice)'];
const TERRAIN = [
  { name: 'Grass', codes: [0] }, { name: 'Water', codes: [1] }, { name: 'Coast', codes: [2, 5, 4, 3] },
  { name: 'Hill top', codes: [6] }, { name: 'Hill slope', codes: [7, 10, 9, 8] },
  { name: 'Hill corner (outer)', codes: [11, 14, 13, 12] }, { name: 'Hill corner (inner)', codes: [15, 18, 17, 16] },
];

// Groups element codes 1..0xB5 into palette items: same shape/surface, one code per rotation.
function catalogue() {
  const names = [];
  for (let i = 0; i < 0x74; i++) { let s = ''; for (let j = 0; j < 4; j++) { const c = M[A.aBarn + i * 5 + j]; if (c) s += String.fromCharCode(c); } names.push(s); }
  const G3D = A.game3dshapes - DS;
  const groups = new Map();
  for (let code = 1; code <= 0xb5; code++) {
    if (code === 2 || code === 3) continue;
    const o = A.trkObjectList + code * 14;
    const shape = names[(rw(o + 4) - G3D) / 22];
    if (!shape || shape === 'rdup') continue;
    const surf = Math.max(rsb(o + 9), 0);
    const key = shape + '/' + surf + '/' + rb(o + 12);
    if (!groups.has(key)) groups.set(key, { name: (NAMES[shape] ?? shape) + (surf < 3 ? SURFACES[surf] ?? '' : ''), shape, codes: [], multi: rb(o + 11), scenery: code >= 0x97 && code <= 0xb2 });
    groups.get(key).codes.push({ code, rot: rsw(o + 2) & 0x3ff });
  }
  for (const g of groups.values()) { g.codes.sort((a, b) => a.rot - b.rot); g.codes = g.codes.map(c => c.code); }
  return [...groups.values()];
}
const multiOf = code => rb(A.trkObjectList + code * 14 + 11);

export function createEditor({ renderer, scene, shapes, setTrackGroup, onTestDrive, onSave, onExit }) {
  let bytes = null, name = 'NEWTRACK', undo = [];
  let tool = null; // { kind: 'elem'|'terrain'|'erase', group, rot }
  let hover = null, errorTile = null, active = false;

  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100000);
  cam.up.set(0, 0, -1); // north up: element file row 0 is the south edge
  cam.position.set(15360, 30000, -15360);
  cam.lookAt(15360, 0, -15360);
  const overlay = new THREE.Group();
  const grid = new THREE.GridHelper(30720, 30, 0xffffff, 0xffffff);
  grid.material.opacity = 0.15; grid.material.transparent = true;
  grid.position.set(15360, 2000, -15360);
  const hi = new THREE.Mesh(new THREE.BoxGeometry(1024, 40, 1024), new THREE.MeshBasicMaterial({ color: 0xffcf3f, transparent: true, opacity: 0.35, depthTest: false }));
  const err = new THREE.Mesh(new THREE.BoxGeometry(1024, 40, 1024), new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.45, depthTest: false }));
  overlay.add(grid, hi, err);

  function fit() {
    const w = renderer.domElement.clientWidth - 300, h = renderer.domElement.clientHeight;
    const s = 31000 / Math.min(w, h);
    cam.left = -(w / 2 + 300) * s; cam.right = w / 2 * s; cam.top = h / 2 * s; cam.bottom = -h / 2 * s;
    cam.updateProjectionMatrix();
  }

  // --- Track bytes. Element file row r is the r-th row from the south (z = r*1024+512);
  // terrain rows run the other way: terrain byte 901 + (29-r)*30 + col is under element row r.
  const E = (c, r) => bytes[r * 30 + c];
  const T = (c, r) => bytes[901 + (29 - r) * 30 + c];
  const setE = (c, r, v) => { if (c >= 0 && c < 30 && r >= 0 && r < 30) bytes[r * 30 + c] = v; };
  // Multi-tile blocks (north-up): the owner is the north-west tile; 0xFF east, 0xFE south, 0xFD south-east.
  function owner(c, r) {
    const e = E(c, r);
    if (e === 0xff) return [c - 1, r];
    if (e === 0xfe) return [c, r + 1];
    if (e === 0xfd) return [c - 1, r + 1];
    return [c, r];
  }
  function clearAt(c, r) {
    const [oc, or] = owner(c, r);
    const m = E(oc, or) ? multiOf(E(oc, or)) : 0;
    setE(oc, or, 0);
    if (m & 2) setE(oc + 1, or, 0);
    if (m & 1) setE(oc, or - 1, 0);
    if (m === 3) setE(oc + 1, or - 1, 0);
  }
  function place(c, r, code) {
    const m = multiOf(code);
    const cells = [[c, r], ...(m & 2 ? [[c + 1, r]] : []), ...(m & 1 ? [[c, r - 1]] : []), ...(m === 3 ? [[c + 1, r - 1]] : [])];
    if (cells.some(([x, y]) => x < 0 || x > 29 || y < 0 || y > 29)) return false;
    for (const [x, y] of cells) clearAt(x, y);
    setE(c, r, code);
    if (m & 2) setE(c + 1, r, 0xff);
    if (m & 1) setE(c, r - 1, 0xfe);
    if (m === 3) setE(c + 1, r - 1, 0xfd);
    return true;
  }

  function rebuild() {
    loadTrack(bytes);
    setTrackGroup(buildTrack(shapes));
  }
  function edit(fn) {
    const before = bytes.slice();
    if (fn() !== false && bytes.some((b, i) => b !== before[i])) { undo.push(before); if (undo.length > 100) undo.shift(); errorTile = null; rebuild(); status(''); }
  }

  // Validation with the original track_setup.
  function validate() {
    loadTrack(bytes);
    const code = call.track_setup() & 0xffff;
    rebuild();
    if (!code) { errorTile = null; status('Track is valid ✓', 'ok'); return true; }
    const c = rb(A.byte_45D90), r = 29 - rb(A.byte_45E16); // track_setup reports tile_south; convert to file row
    errorTile = code === 1 ? null : [c, r]; // "no start/finish" reports no real tile
    status(`${ERRORS[code] ?? 'Error ' + code} (column ${c + 1}, row ${r + 1})`, 'bad');
    return false;
  }
  function status(msg, cls = '') { $('ed-status').textContent = msg; $('ed-status').className = cls; }

  // --- Palette with thumbnails rendered from the real shapes.
  const thumbRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  thumbRenderer.setSize(64, 64);
  const thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 2.2));
  const thumbCam = new THREE.OrthographicCamera(-600, 600, 600, -600, 1, 10000);
  thumbCam.position.set(0, 3000, 0); thumbCam.up.set(0, 0, -1); thumbCam.lookAt(0, 0, 0);
  function thumb(shapeName, rot, multi, slot = 0) {
    const b = new Builder();
    const s = shapes[shapeName];
    if (!s) return el('div', { className: 'thumb' });
    b.add(s, new THREE.Matrix4().makeRotationY(-rot * ANGLE), slot);
    const g = b.group();
    thumbScene.add(g);
    const span = multi === 3 ? 1150 : multi ? 1150 : 600;
    Object.assign(thumbCam, { left: -span, right: span, top: span, bottom: -span }); thumbCam.updateProjectionMatrix();
    thumbRenderer.render(thumbScene, thumbCam);
    thumbScene.remove(g);
    return el('img', { src: thumbRenderer.domElement.toDataURL(), className: 'thumb' });
  }
  const terrainShape = code => ({ 1: 'lake', 2: 'lakc', 3: 'lakc', 4: 'lakc', 5: 'lakc', 6: 'high' }[code] ?? (code >= 15 ? 'goui' : code >= 11 ? 'gouo' : code >= 7 ? 'goup' : null));

  const groups = catalogue();
  function buildPalette() {
    const sections = [
      ['Terrain', TERRAIN.map(t => ({ kind: 'terrain', ...t }))],
      ['Roads', groups.filter(g => !g.scenery && /Road|corner|Crossroad|Start|Split|Highway/i.test(g.name) && !/Elevated|Banked|Solid|Slalom|Hill/.test(g.name)).map(g => ({ kind: 'elem', ...g }))],
      ['Stunts', groups.filter(g => !g.scenery && !/^(Road|Sharp corner|Corner|Crossroad|Start|Split|Highway)/.test(g.name)).map(g => ({ kind: 'elem', ...g }))],
      ['Scenery', groups.filter(g => g.scenery).map(g => ({ kind: 'elem', ...g }))],
    ];
    const pal = $('ed-palette');
    pal.replaceChildren(el('button', { className: 'ed-item', onclick: () => selectTool({ kind: 'erase' }) }, el('div', { className: 'thumb erase', textContent: '⌫' }), el('span', { textContent: 'Erase' })));
    for (const [title, items] of sections) {
      pal.append(el('h3', { textContent: title }));
      for (const it of items) {
        const code = it.kind === 'terrain' ? it.codes[0] : it.codes[0];
        const o = A.trkObjectList + code * 14;
        const img = it.kind === 'terrain'
          ? (terrainShape(code) ? thumb(terrainShape(code), 0, 0) : el('div', { className: 'thumb grass' }))
          : thumb(it.shape, rsw(o + 2), it.multi, Math.max(rsb(o + 9), 0));
        const b = el('button', { className: 'ed-item', title: it.name, onclick: () => selectTool({ ...it, rot: 0 }) }, img, el('span', { textContent: it.name }));
        it.button = b;
        pal.append(b);
      }
    }
  }
  function selectTool(t) {
    tool = t;
    for (const b of document.querySelectorAll('.ed-item')) b.classList.toggle('on', b === t.button);
    $('ed-tool').textContent = t.kind === 'erase' ? 'Erase' : `${t.name}${t.codes.length > 1 ? ` · rotation ${t.rot + 1}/${t.codes.length} (R)` : ''}`;
  }

  // --- Mouse
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), planeY0 = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
  function tileAt(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set((ev.clientX - r.left) / r.width * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, cam);
    if (!ray.ray.intersectPlane(planeY0, hit)) return null;
    const c = Math.floor(hit.x / 1024), row = Math.floor(-hit.z / 1024);
    return c >= 0 && c < 30 && row >= 0 && row < 30 ? [c, row] : null;
  }
  let painting = false;
  function apply(t) {
    if (!t || !tool) return;
    const [c, r] = t;
    edit(() => {
      if (tool.kind === 'erase') { if (E(c, r)) clearAt(c, r); else bytes[901 + (29 - r) * 30 + c] = 0; }
      else if (tool.kind === 'terrain') bytes[901 + (29 - r) * 30 + c] = tool.codes[tool.rot % tool.codes.length];
      else return place(c, r, tool.codes[tool.rot % tool.codes.length]);
    });
  }
  const onDown = ev => {
    if (!active || ev.target !== renderer.domElement) return;
    if (ev.button === 2) { rotate(); return; }
    painting = tool && tool.kind !== 'elem';
    apply(tileAt(ev));
  };
  const onMove = ev => {
    if (!active) return;
    hover = tileAt(ev);
    if (painting && (ev.buttons & 1)) apply(hover);
  };
  const onUp = () => { painting = false; };
  const onKey = ev => {
    if (!active || ev.target.tagName === 'INPUT') return;
    if (ev.code === 'KeyR') rotate();
    if (ev.code === 'KeyZ' && (ev.ctrlKey || ev.metaKey)) doUndo();
    if (ev.code === 'Escape') onExit();
  };
  function rotate() { if (tool?.codes?.length > 1) selectTool({ ...tool, rot: (tool.rot + 1) % tool.codes.length }); }
  function doUndo() { if (undo.length) { bytes = undo.pop(); rebuild(); } }
  renderer.domElement.addEventListener('contextmenu', ev => active && ev.preventDefault());
  addEventListener('pointerdown', onDown); addEventListener('pointermove', onMove); addEventListener('pointerup', onUp); addEventListener('keydown', onKey);

  // --- Toolbar
  $('ed-validate').onclick = validate;
  $('ed-undo').onclick = doUndo;
  $('ed-test').onclick = () => { if (validate()) onTestDrive(name, bytes.slice()); };
  $('ed-save').onclick = () => { name = ($('ed-name').value || 'NEWTRACK').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 8) || 'NEWTRACK'; $('ed-name').value = name; onSave(name, bytes.slice()); status(`Saved as ${name}`, 'ok'); };
  $('ed-export').onclick = () => {
    const a = el('a', { href: URL.createObjectURL(new Blob([bytes])), download: `${($('ed-name').value || 'NEWTRACK').toUpperCase()}.TRK` });
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('ed-clear').onclick = () => edit(() => { bytes.fill(0, 0, 900); bytes.fill(0, 901, 1801); });
  $('ed-scenery').onchange = () => edit(() => { bytes[900] = +$('ed-scenery').value; });
  $('ed-exit').onclick = () => onExit();
  let paletteBuilt = false, fog = null;

  return {
    open(trackName, trackBytes) {
      bytes = new Uint8Array(1802); bytes.set(trackBytes.subarray(0, 1802));
      name = trackName === 'DEFAULT' ? 'NEWTRACK' : trackName;
      $('ed-name').value = name;
      $('ed-scenery').value = bytes[900] % 5;
      undo = []; errorTile = null; active = true;
      if (!paletteBuilt) { buildPalette(); paletteBuilt = true; }
      $('editor').hidden = false;
      scene.add(overlay);
      fog = scene.fog; scene.fog = null;
      fit();
      rebuild();
      status('Click to place · right-click or R rotates · drag paints terrain · Ctrl+Z undo');
    },
    close() { active = false; $('editor').hidden = true; scene.remove(overlay); scene.fog = fog; },
    get active() { return active; },
    render() {
      fit();
      hi.visible = !!hover;
      if (hover) hi.position.set(hover[0] * 1024 + 512, 1500, -(hover[1] * 1024 + 512));
      err.visible = !!errorTile;
      if (errorTile) err.position.set(errorTile[0] * 1024 + 512, 1500, -(errorTile[1] * 1024 + 512));
      renderer.clear();
      renderer.render(scene, cam);
    },
  };
}
