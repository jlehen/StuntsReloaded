// The original's stack, emulated for ports. Some original code reads uninitialized locals
// (e.g. update_player_state's var_16 / var_140someWhlData), which see whatever earlier calls
// left below their stack frames. To stay bit-exact, ports write the same residue: their frame
// (saved bp/regs, locals), call arguments, return addresses and helper frames, and they call
// other functions with the stack pointer where the original's call would put it.
import { M, rw, ww, u16 } from './mem.js';
import { call, isEnabled, setNextReturn } from './calls.js';
import { cpu, PROCS, procPtr } from './engine.js';
import { MS } from './version.js';

// Convention: when a port runs, cpu.sp is its entry sp (pointing at the return address), as
// when hooked from original code. JS callers get this by calling through origStack().invoke.
// Writing below sp never clobbers live data.

// Return addresses of the original's calls: { cs, sites: [[target linear, return ip], ...] }.
const sitesCache = {};
export function callSites(proc) {
  if (sitesCache[proc]) return sitesCache[proc];
  const start = PROCS[proc], [cs] = procPtr(proc);
  const end = Math.min(...Object.values(PROCS).filter(a => a > start));
  const sites = [];
  for (let a = start; a < end; a += cpu.length(a)) {
    if (M[a] === 0x9a) sites.push([rw(a + 3) * 16 + rw(a + 1), a + 5 - cs * 16]); // call far
    else if (M[a] === 0xe8) sites.push([cs * 16 + ((a + 3 - cs * 16 + rw(a + 1)) & 0xffff), a + 3 - cs * 16]); // push cs; call near
  }
  return (sitesCache[proc] = { cs, sites });
}
// [cs, ip] pushed by the nth call from proc `from` to proc `to`.
export function retAddr(from, to, nth) {
  const { cs, sites } = callSites(from);
  return [cs, sites.filter(s => s[0] === PROCS[to])[nth][1]];
}

// The Mindscape build's frames and call sites differ, and nothing reads the residue now that
// update_player_state's frame is cleared (engine.js), so there the stack is not reproduced:
// writes go nowhere, calls just call, and bp = 0 tells a port its frame is not in memory.
const nop = () => {};
const noStack = () => ({ sp: cpu.sp, bp: 0, word: () => 0, push: nop, pop: nop, enter: nop, local: nop, localByte: nop, arg: nop, call: nop,
  invoke: (to, nth, args) => call[to](...args) });

// The original's stack as `proc` runs, from its entry sp.
export function origStack(proc) {
  if (MS) return noStack();
  const base = cpu.ss << 4;
  const put = (off, v) => ww(base + (off & 0xffff), v);
  const st = {
    sp: cpu.sp, bp: 0,
    word: off => rw(base + (off & 0xffff)),
    push(...vals) { for (const v of vals) { st.sp = (st.sp - 2) & 0xffff; put(st.sp, v); } },
    pop(n) { st.sp = (st.sp + 2 * n) & 0xffff; },
    // Prologue: push bp; mov bp, sp; sub sp, locals; push regs.
    enter(locals, ...regs) { st.push(cpu.bp); st.bp = st.sp; st.sp = (st.sp - locals) & 0xffff; st.push(...regs); },
    local(k, v) { put(st.bp - k, v); }, // word local at bp-k
    localByte(k, v) { M[base + ((st.bp - k) & 0xffff)] = v; },
    arg(i, v) { put(st.bp + 6 + 2 * i, v); }, // store into argument i (far proc)
    // A call to a helper: arguments in push order, the return address, then what the helper
    // pushes itself (inner: a list of words, or a function pushing on this stack).
    call(to, nth, args, inner = [], from = proc) {
      const save = st.sp;
      st.push(...args, ...retAddr(from, to, nth));
      if (typeof inner === 'function') inner(); else st.push(...inner);
      st.sp = save;
    },
    // call[to](...args) (word args) with its frame where the original's would be.
    invoke(to, nth, args) {
      const [cs, ip] = retAddr(proc, to, nth);
      const [sp, bp] = [cpu.sp, cpu.bp];
      const n = args.length;
      cpu.bp = st.bp;
      let r;
      cpu.sp = st.sp;
      if (isEnabled(to)) { // JS: the call layer pushes the arguments; we supply the return address
        setNextReturn(cs, ip);
        r = call[to](...args);
      } else { // original: callFar pushes them, with a sentinel return address we then correct
        r = call[to](...args);
        put(st.sp - 2 * n - 2, cs);
        put(st.sp - 2 * n - 4, ip);
      }
      [cpu.sp, cpu.bp] = [sp, bp];
      return r;
    },
  };
  return st;
}

