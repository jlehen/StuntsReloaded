// Mixed-mode engine: original GAME.EXE functions run in the 8086 interpreter over the shared
// memory; JS ports can replace them one by one (hook) and can call not-yet-ported originals
// (callOrig). With all ports enabled the interpreter only serves tests and ?original.
import { CPU, callFar } from './x86.js';
import PROCS_BB from './procs.js';
import PROCS_MS from './procs-ms.js';
import { M, DSEG, ww } from './mem.js';
import { MS } from './version.js';

export const PROCS = MS ? PROCS_MS : PROCS_BB;
export const cpu = new CPU(M);
const SEGS = Object.entries(PROCS).filter(([k]) => /^seg\d+$/.test(k)).map(([, v]) => v).sort((a, b) => a - b);

// seg:off of a proc, using its segment's real base (segment start rounded down to a paragraph).
export function procPtr(name) {
  const a = PROCS[name];
  if (a === undefined) throw new Error('unknown proc ' + name);
  const cs = SEGS.filter(s => s <= a).pop() >> 4;
  return [cs, a - cs * 16];
}

let depth = 0;
// Call an original function with 16-bit args (near pointers are DS offsets). Returns dx:ax.
export function callOrig(name, ...args) {
  const [cs, ip] = procPtr(name);
  if (depth === 0) { cpu.ds = cpu.ss = cpu.es = DSEG; cpu.sp = 0xfff0; }
  depth++;
  try { return callFar(cpu, cs, ip, args); } finally { depth--; }
}

// Replace an original function: fn(argAddr) gets the linear address of its first stack
// argument and returns the dx:ax value (or undefined).
export function hook(name, fn) {
  cpu.hooks.set(PROCS[name], c => {
    depth++;
    let r;
    try { r = fn(c.lin(c.ss, c.sp + 4)) ?? 0; } finally { depth--; }
    c.ax = r & 0xffff; c.dx = (r >>> 16) & 0xffff;
    c.ip = c.pop(); c.cs = c.pop(); // retf
  });
}
export const unhook = name => cpu.hooks.delete(PROCS[name]);
export const isHooked = name => cpu.hooks.has(PROCS[name]);

// The divide-overflow handler installed by init_div0. Call after loadExe().
// (DOS-facing functions are replaced by JS in stubs.js.)
export function installStubs() {
  const [hs, ho] = procPtr('intr0_handler'); // skips 2 bytes, returns ax=0
  ww(0, ho); ww(2, hs);
  // update_player_state reads some locals before writing them (var_16, var_140someWhlData). On DOS
  // they held whatever earlier calls and timer interrupts left there, i.e. nondeterministic. We
  // define them as zero: its frame is cleared after the prologue (push bp; mov bp,sp; sub sp,1E4h).
  // The JS port (player.js) does the same.
  let a = PROCS.update_player_state;
  for (let i = 0; i < 3; i++) a += cpu.length(a);
  cpu.probes.set(a, c => M.fill(0, c.lin(c.ss, c.sp), c.lin(c.ss, c.bp)));
}
