// Lockstep trace diff: every frame starts from the original's state, runs update_gamestate once
// with the original code and once with JS ports hooked, then compares DGROUP + far heap.
// usage: node tools/trace.mjs [scenario-filter] [port,...|src/module.js,...|math]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { M, DS, heapMark } from '../src/mem.js';
import { bootWorld, gameFile } from './oracle.mjs';
import { enable, disable } from '../src/calls.js';
import { MATH_PORTS } from '../src/math.js';
import { loadReplay, loadTrack, setupRace, step, state, gameconfig } from '../src/race.js';
import { MS } from '../src/version.js';

// Random driver: mostly throttle, steering bursts, occasional braking/shifting. Each driver has its
// own generator, so a scenario's inputs don't depend on which scenarios ran before it.
function randomDriver(s, manual) {
  let seed = s, steer = 0, hold = 0;
  const rnd = n => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
  return () => {
    if (hold-- <= 0) { steer = [0, 0, 4, 8][rnd(4)]; hold = rnd(30); }
    let b = rnd(10) < 8 ? 1 : rnd(3) === 0 ? 2 : 0;
    if (manual && rnd(25) === 0) b |= rnd(2) ? 0x10 : 0x20;
    return b | steer;
  };
}
const setCars = (player, opp, oppType, manual) => {
  for (let i = 0; i < 4; i++) { gameconfig.game_playercarid[i] = player.charCodeAt(i); gameconfig.game_opponentcarid[i] = opp.charCodeAt(i); }
  gameconfig.game_playertransmission = manual ? 0 : 1;
  gameconfig.game_opponenttype = oppType;
};
// Every other track at hand (the Mindscape copy ships five): the opponent drives a lap over its
// stunts while the player pulls away and brakes to a stop. The same tracks serve both builds.
const tracks = new Map();
for (const dir of ['../game/', '../game-ms/'].map(d => new URL(d, import.meta.url))) {
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) if (/\.TRK$/i.test(f) && !/^DEFAULT\./i.test(f)) tracks.set(f.toUpperCase().slice(0, -4), new Uint8Array(readFileSync(new URL(f, dir))));
}
const lapScenarios = [...tracks].map(([name, trk], i) => ({
  name: `lap-${name}-opp${i % 6 + 1}`, frames: 7000,
  setup: () => { loadTrack(trk); setCars(['COUN', 'PMIN', 'JAGU', 'ANSX', 'LM02', 'AUDI'][i % 6], ['FGTO', 'VETT', 'P962', 'LANC', 'PC04', 'COUN'][i % 6], i % 6 + 1, false); },
  input: (f => () => (f++ < 40 ? 1 : 2))(0),
}));
export const SCENARIOS = [
  { name: 'default-replay', setup: () => loadReplay(gameFile('DEFAULT.RPL')), input: null },
  ...[1, 2, 3, 4, 5, 6].map(o => ({
    name: `random-opp${o}`, frames: 1500,
    setup: () => { loadTrack(gameFile('DEFAULT.TRK')); setCars(['COUN', 'VETT', 'LANC', 'FGTO', 'P962', 'ANSX'][o - 1], ['PMIN', 'AUDI', 'JAGU', 'LM02', 'PC04', 'COUN'][o - 1], o, false); },
    input: randomDriver(o * 77, false),
  })),
  { name: 'random-manual', frames: 1500, setup: () => { loadTrack(gameFile('DEFAULT.TRK')); setCars('LM02', 'PMIN', 0, true); }, input: randomDriver(5, true) },
  ...lapScenarios,
  // The Mindscape build has no 10 fps setting.
  ...(MS ? [] : [{ name: 'random-10fps', frames: 800, fps: 10, setup: () => { loadTrack(gameFile('DEFAULT.TRK')); setCars('P962', 'COUN', 2, false); }, input: randomDriver(9, false) }]),
];

const diffList = (a, b, hi) => {
  const d = [];
  for (const [lo, end] of [[DS, DS + 0xb000], [0x50000, hi]]) for (let i = lo; i < end && d.length < 12; i++) if (a[i] !== b[i]) d.push(i);
  return d.map(x => `${x >= DS && x < DS + 0x10000 ? 'ds:' + (x - DS).toString(16) : x.toString(16)}=${a[x]}/${b[x]}`).join(' ');
};
// Runs fn twice from the same memory: with the named ports enabled, then with pure original code.
// Leaves memory in the original's result state. Returns null or a mismatch description.
function lockstep(names, fn) {
  const snap = M.slice();
  enable(names);
  let err = null;
  try { fn(); } catch (e) { err = e; }
  disable(names);
  const js = M.slice(0, heapMark());
  M.set(snap);
  fn();
  const d = diffList(js, M, Math.max(js.length, heapMark()));
  return err ? 'JS threw ' + err.stack.split('\n').slice(0, 4).join(' | ') : d || null;
}

// Runs scenarios with the named JS ports enabled vs the original, frame by frame.
export function traceDiff(names, filter = '', maxReports = 3) {
  let ok = true;
  for (const sc of SCENARIOS.filter(s => s.name.includes(filter))) {
    bootWorld();
    const recorded = sc.setup();
    const frames = sc.frames ?? recorded;
    const setupErr = lockstep(names, () => setupRace(sc.fps));
    if (setupErr) { ok = false; console.log(`  ${sc.name} setup: ${setupErr}`); }
    let fails = 0;
    for (let f = 0; f < frames; f++) {
      const input = sc.input ? sc.input() : undefined;
      const r = lockstep(names, () => step(input));
      if (r) { ok = false; if (fails++ < maxReports) console.log(`  ${sc.name} frame ${f}: ${r}`); }
    }
    console.log(`${fails || setupErr ? 'FAIL' : 'ok  '} ${sc.name}: ${frames - fails}/${frames} frames match` + (fails ? '' : `, finish ${state.game_total_finish}, crash ${state.playerstate.car_crashBmpFlag}` +
      (gameconfig.game_opponenttype ? `, opponent finish ${state.field_144}, crash ${state.opponentstate.car_crashBmpFlag}` : '')));
  }
  return ok;
}

// CLI: node tools/trace.mjs [scenario-filter] [ports]
// ports: comma-separated proc names and/or module paths (a module's exported PORTS list), or 'math'.
if (import.meta.url === `file://${process.argv[1]}`) {
  const names = [];
  for (const p of (process.argv[3] ?? '').split(',').filter(Boolean)) {
    if (p === 'math') names.push(...MATH_PORTS);
    else if (p.endsWith('.js')) names.push(...(await import(new URL('../' + p, import.meta.url))).PORTS);
    else names.push(p);
  }
  console.log('ports:', names.join(' ') || '(none)');
  process.exit(traceDiff(names, process.argv[2] ?? '') ? 0 : 1);
}
