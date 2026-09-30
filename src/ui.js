// Menu screens (DOM). main.js passes an `app` object with the game actions and state.
import { bitmap, text, OPPONENTS } from './art.js';

const $ = id => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const SCREENS = ['main', 'cars', 'opps', 'tracks', 'results'];

export function show(screen) {
  for (const s of SCREENS) $(s).hidden = s !== screen;
}

// Track mini-map, north up: element file row 0 is the south edge, terrain rows run north to south.
export function trackMap(bytes, size = 150) {
  const c = el('canvas', { width: 30, height: 30, className: 'map' });
  const ctx = c.getContext('2d');
  for (let row = 0; row < 30; row++) for (let col = 0; col < 30; col++) {
    const e = bytes[(29 - row) * 30 + col], t = bytes[901 + row * 30 + col];
    const start = [1, 0x86, 0x87, 0x88, 0x89, 0x93, 0x94, 0x95, 0x96, 0xb3, 0xb4, 0xb5].includes(e);
    const scenery = e >= 0x97 && e <= 0xb2;
    ctx.fillStyle = start ? '#ffcf3f' : e && !scenery ? '#333' : scenery ? '#4d6b35'
      : t >= 1 && t <= 5 ? '#3d6fb6' : t >= 6 ? '#7fae63' : '#2f6b2a';
    ctx.fillRect(col, row, 1, 1);
  }
  c.style.width = c.style.height = size + 'px';
  return c;
}

export function initUI(app) {
  // Main menu: original title art.
  const title = bitmap('SDTITL.PVS', 'titl', { opaque: true });
  if (title) { title.className = 'title-art'; $('main').prepend(title); }
  $('m-drive').onclick = () => app.startRace();
  $('m-car').onclick = () => { show('cars'); renderCars(); app.showroom(true); };
  $('m-opp').onclick = () => { show('opps'); renderOpps(); };
  $('m-track').onclick = () => { show('tracks'); renderTracks(); };
  $('m-enhanced').checked = app.settings.enhanced;
  $('m-enhanced').onchange = e => { app.settings.enhanced = e.target.checked; app.save(); };
  $('m-replay').onchange = async e => {
    const f = e.target.files[0];
    if (f) app.startReplay(new Uint8Array(await f.arrayBuffer()));
    e.target.value = '';
  };
  for (const b of document.querySelectorAll('[data-back]')) b.onclick = () => { app.showroom(false); show('main'); updateSummary(); };

  function updateSummary() {
    const s = app.settings;
    $('m-summary').textContent = `${app.carName(s.car)} · ${s.manual ? 'manual' : 'automatic'} · ` +
      `${s.opponent ? app.oppName(s.opponent) : 'no opponent'} · ${s.track}`;
  }
  updateSummary();

  // Car selection with the showroom behind.
  function renderCars() {
    const s = app.settings, list = $('car-list');
    list.replaceChildren(...app.CARS.map(c => el('button', {
      textContent: app.carName(c), className: c === s.car ? 'on' : '',
      onclick: () => { s.car = c; s.paint = 0; app.save(); app.showroom(true); renderCars(); },
    })));
    const lines = app.carDescription(s.car);
    $('car-info').replaceChildren(...lines.map(l => el('div', { textContent: l || ' ' })));
    $('car-paints').replaceChildren(...app.carPaints(s.car).map((color, i) => el('button', {
      className: 'swatch' + (i === s.paint ? ' on' : ''), style: `background:${color}`, title: `Paint ${i + 1}`,
      onclick: () => { s.paint = i; app.save(); app.showroom(true); renderCars(); },
    })));
    $('car-manual').checked = s.manual;
    $('car-manual').onchange = () => { s.manual = $('car-manual').checked; app.save(); };
  }

  // Opponent selection with the original portraits.
  function renderOpps() {
    const s = app.settings;
    const cards = [el('button', { className: 'opp' + (s.opponent === 0 ? ' on' : ''), onclick: () => { s.opponent = 0; app.save(); renderOpps(); } },
      el('div', { className: 'portrait none', textContent: '—' }), el('span', { textContent: 'Nobody' }))];
    for (const o of OPPONENTS) {
      const pic = bitmap('SDOSEL.PVS', 'opp' + o.id, { opaque: true });
      pic.className = 'portrait';
      cards.push(el('button', { className: 'opp' + (s.opponent === o.id ? ' on' : ''), onclick: () => { s.opponent = o.id; app.save(); renderOpps(); } },
        pic, el('span', { textContent: app.oppName(o.id) })));
    }
    $('opp-list').replaceChildren(...cards);
    $('opp-info').replaceChildren(...(s.opponent ? text(`OPP${s.opponent}.PRE`, 'edes') : ['Race alone against the clock.'])
      .map(l => el('div', { textContent: l || ' ' })));
    const sel = $('opp-car');
    sel.replaceChildren(...app.CARS.map(c => new Option(app.carName(c), c)));
    sel.value = s.oppCar;
    sel.onchange = () => { s.oppCar = sel.value; app.save(); };
    $('opp-car-row').hidden = !s.opponent;
  }

  // Tracks: built-in DEFAULT plus imported ones (kept in localStorage).
  function renderTracks() {
    const s = app.settings;
    $('track-list').replaceChildren(...app.trackNames().map(n => el('button', { className: 'track' + (n === s.track ? ' on' : ''),
      onclick: () => { s.track = n; app.save(); renderTracks(); } }, trackMap(app.trackBytes(n), 96), el('span', { textContent: n }))));
    $('track-delete').disabled = s.track === 'DEFAULT';
  }
  $('track-import').onchange = async e => {
    for (const f of e.target.files) app.importTrack(f.name.replace(/\.trk$/i, '').toUpperCase().slice(0, 8), new Uint8Array(await f.arrayBuffer()));
    e.target.value = '';
    renderTracks();
  };
  $('track-delete').onclick = () => { app.deleteTrack(app.settings.track); renderTracks(); };
  $('track-edit').onclick = () => app.editTrack?.(app.settings.track);

  return { updateSummary };
}

// Results screen after a race.
export function showResults(app, r) {
  show('results');
  const rows = [
    ['Result', r.finished ? 'Finished' : r.drowned ? 'Drowned' : 'Crashed'],
    ...(r.finished ? [['Time', r.time], ['Penalty', r.penalty || 'none']] : []),
    ['Top speed', `${r.topSpeed} mph`], ['Jumps', r.jumps], ['Impact speed', r.impact ? `${r.impact} mph` : '—'],
  ];
  if (r.opponent) rows.push([r.opponent.name, r.opponent.time ?? (r.opponent.crashed ? 'crashed' : 'did not finish')]);
  $('res-table').replaceChildren(...rows.map(([k, v]) => el('tr', {}, el('th', { textContent: k }), el('td', { textContent: v }))));
  const face = $('res-face');
  face.replaceChildren();
  if (r.opponent?.decided) {
    const won = r.opponent.won;
    const pic = bitmap(`OPP${r.opponent.id}${won ? 'WIN' : 'LOSE'}.PVS`, 'op0' + (1 + Math.floor(Math.random() * 3)), { opaque: true });
    if (pic) face.append(pic);
    const lines = [1, 2, 3, 4].flatMap(n => ['a', 'b', 'c', 'd'].map(v => text(`OPP${r.opponent.id}.PRE`, `e${won ? 'v' : 'd'}${n}${v}`)[0]).filter(Boolean));
    face.append(el('p', { textContent: `“${lines[Math.floor(Math.random() * lines.length)] ?? ''}”` }));
  }
  $('res-hi').replaceChildren(...r.highscores.map((h, i) => el('tr', { className: h.current ? 'on' : '' },
    el('td', { textContent: i + 1 }), el('td', { textContent: h.time }), el('td', { textContent: h.car }), el('td', { textContent: h.date }))));
  $('res-hi-wrap').hidden = !r.highscores.length;
  $('res-replay').onclick = () => app.viewReplay();
  $('res-save').onclick = () => app.saveReplay();
  $('res-again').onclick = () => app.startRace();
  $('res-menu').onclick = () => app.toMenu();
}
