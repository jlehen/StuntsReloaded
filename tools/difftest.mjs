// Differential testing helpers: run a JS port and the original (oracle) from the same
// memory snapshot, compare return values and memory (DGROUP data + far heap; stacks excluded).
import { M, DS } from '../src/mem.js';
import { bootWorld, callOrig } from './oracle.mjs';

bootWorld();
export const oracle = { call: callOrig };
// Scratch area for near-pointer arguments: free DGROUP bytes after BSS (0xAD20..0xB000).
export const SCRATCH_OFF = 0xad40;

const REGIONS = [[DS, DS + 0xb000], [0x50000, 0x100000]];
export function diffMemory(a, b, limit = 20) {
  const out = [];
  for (const [lo, hi] of REGIONS) {
    for (let i = lo; i < hi && out.length < limit; i++) if (a[i] !== b[i]) out.push(i);
  }
  return out;
}

let seed = 12345;
export const rnd = (lo, hi) => { seed = (seed * 1103515245 + 12345) >>> 0; return lo + (seed >>> 8) % (hi - lo + 1); };

// Runs jsFn() and oracleFn() from the same state; returns null or a description of the mismatch.
// retMask: bits of the return value that matter (0xffff for int, 0xffffffff for long, 0 to ignore).
export function compare(jsFn, oracleFn, retMask = 0xffff) {
  const snap = M.slice();
  let jr, jerr;
  try { jr = jsFn(); } catch (e) { jerr = e; }
  const after = M.slice();
  M.set(snap);
  const or = oracleFn();
  if (jerr) return `JS threw ${jerr.message} (oracle returned ${or})`;
  if (retMask && ((jr ?? 0) & retMask) >>> 0 !== (or & retMask) >>> 0) return `return ${jr} vs oracle ${or & retMask}`;
  const d = diffMemory(after, M);
  if (d.length) return 'memory differs at ' + d.map(a => `${(a >= DS && a < DS + 0x10000 ? 'ds:' + (a - DS).toString(16) : a.toString(16))}=${after[a]}/${M[a]}`).join(' ');
  return null;
}

// Runs n random cases; gen(i) returns [label, jsFn, oracleFn, retMask?]. Reports failures.
export function fuzz(name, n, gen) {
  let fails = 0;
  for (let i = 0; i < n; i++) {
    const [label, jsFn, oFn, mask] = gen(i);
    const r = compare(jsFn, oFn, mask);
    if (r) { if (fails++ < 5) console.log(`  FAIL ${name} ${label}: ${r}`); }
  }
  console.log(`${fails ? 'FAIL' : 'ok  '} ${name}: ${n - fails}/${n}`);
  return fails === 0;
}
