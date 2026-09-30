// Which original (interpreted) functions still run with the ports enabled? Counts instructions
// per proc during setup and a replay. usage: node tools/profile-orig.mjs [DEFAULT.RPL]
import { bootWorld, gameFile, cpu } from './oracle.mjs';
import { loadReplay, setupRace, step } from '../src/race.js';
import { enablePorts } from '../src/ports.js';
import PROCS from '../src/procs.js';

const procs = Object.entries(PROCS).filter(([k]) => !/^seg\d+$/.test(k)).sort((a, b) => a[1] - b[1]);
const procAt = a => { let lo = 0, hi = procs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (procs[m][1] <= a) lo = m; else hi = m - 1; } return procs[lo][0]; };
const counts = new Map();
const orig = cpu.step.bind(cpu);
cpu.step = () => { const a = cpu.lin(cpu.cs, cpu.ip); const p = procAt(a); counts.set(p, (counts.get(p) ?? 0) + 1); orig(); };
const report = label => { console.log(label, [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k}:${v}`).join(' ') || '(none)'); counts.clear(); };

enablePorts();
bootWorld(); report('boot:');
const n = loadReplay(gameFile(process.argv[2] ?? 'DEFAULT.RPL'));
setupRace(); report('setup:');
for (let f = 0; f < n; f++) step();
report('race:');
