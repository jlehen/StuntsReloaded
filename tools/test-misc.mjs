// misc.js: startup functions compared against the original (boot with vs without the ports).
import { M, DS } from '../src/mem.js';
import { bootWorld } from './oracle.mjs';
import { enable, disable } from '../src/calls.js';
import { PORTS } from '../src/misc.js';

const bootMem = ports => { enable(ports); bootWorld(); disable(ports); return M.slice(DS, DS + 0xb000); };
const a = bootMem([]), b = bootMem(PORTS);
const diffs = []; for (let i = 0; i < a.length && diffs.length < 10; i++) if (a[i] !== b[i]) diffs.push(`ds:${i.toString(16)}=${b[i]}/${a[i]}`);
console.log(diffs.length ? 'FAIL boot: ' + diffs.join(' ') : 'ok   boot (init_polyinfo, calc_sincos80, init_unknown, set_default_car)');
