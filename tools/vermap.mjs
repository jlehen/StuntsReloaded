// Maps the functions and globals of the GAME.EXE the ports were written against (restunts'
// Broderbund Stunts 1.1, game/GAME.EXE) onto the Mindscape 4D Sports Driving 1.1 build, by
// comparing the code with address operands masked out, and writes that build's address tables
// (src/procs-ms.js, src/dseg-labels-ms.js). There is no disassembly listing of the Mindscape
// build; --diff and --dis are how to read it, with restunts' names.
// usage: node tools/vermap.mjs <Mindscape game dir> [--write] [--diff proc,...] [--dis proc,...] [--ctx n]
//   --write  regenerate the tables            --diff  differing instructions of the procs, both builds
//   a proc may be given as name..end: all the code from `name` up to the proc `end`
//   --at addr,count  the Mindscape code at a (hex) address
//   --loose  with --diff: ignore which stack slot a local is in
//   --dis    the Mindscape proc, disassembled  --ctx   matching instructions shown around each difference
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { M, DS, DSEG, loadExe } from '../src/mem.js';
import { buildExe } from '../src/exe.js';
import PROCS from '../src/procs.js';
import LABELS from '../src/dseg-labels.js';

const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(n); return i < 0 ? null : args.splice(i, 2)[1]; };
const flag = n => { const i = args.indexOf(n); if (i >= 0) args.splice(i, 1); return i >= 0; };
const loose = flag('--loose'); // locals at other frame offsets still match (frames are laid out differently)
const disProc = opt('--dis'), diffProc = opt('--diff') ?? disProc ?? (args.includes('--at') ? '' : null), ctx = +(opt('--ctx') ?? 3), write = flag('--write');
const why = opt('--why');
const dir = args[0].replace(/\/?$/, '/');
const file = n => (existsSync(dir + n) ? new Uint8Array(readFileSync(dir + n)) : null);
const MS_SEG = 0x10dd; // puts the Mindscape DGROUP at the same address as Broderbund's (mem.js)

loadExe(new Uint8Array(readFileSync(new URL('../game/GAME.EXE', import.meta.url))), 0x1000);
const A = M.slice(0, 0x100000);
const exeB = file('GAME.EXE') ?? buildExe(file);
loadExe(exeB, MS_SEG);
const B = M.slice(0, 0x100000);
const rw = (m, a) => m[a] | (m[a + 1] << 8);
// The other build's segments: every relocated word holds one.
const segsB = new Set();
for (let i = 0, n = rw(exeB, 6), t = rw(exeB, 0x18); i < n; i++) segsB.add(rw(B, (MS_SEG + rw(exeB, t + i * 4 + 2)) * 16 + rw(exeB, t + i * 4)));
const codeSegsB = [...segsB].filter(s => s >= MS_SEG && s < DSEG).sort((x, y) => x - y);
const segsA = new Set(Object.entries(PROCS).filter(([k]) => /^seg\d+$/.test(k)).map(([, v]) => v >> 4).concat(DSEG));

// Instruction layout: length plus the operand fields that hold addresses or branch distances.
// kinds: d8 d16 (modrm displacement), m16 (direct address), i8 i16 (immediate), r8 r16 (branch), far.
const PREFIX = new Set([0x26, 0x2e, 0x36, 0x3e, 0xf2, 0xf3, 0xf0]);
const IMM8 = new Set([0x04, 0x0c, 0x14, 0x1c, 0x24, 0x2c, 0x34, 0x3c, 0x6a, 0xa8, 0xcd, 0xd4, 0xd5, 0xe4, 0xe5, 0xe6, 0xe7]);
const REL8 = new Set([0xe0, 0xe1, 0xe2, 0xe3, 0xeb]);
const IMM16 = new Set([0x05, 0x0d, 0x15, 0x1d, 0x25, 0x2d, 0x35, 0x3d, 0x68, 0xa9, 0xc2, 0xca]);
function layout(m, a) {
  let p = a, op;
  for (;;) { op = m[p++]; if (!PREFIX.has(op)) break; }
  const f = [];
  const hasModrm = (op < 0x40 && (op & 7) < 4) || (op >= 0x80 && op <= 0x8f) || (op >= 0xc4 && op <= 0xc7) ||
    (op >= 0xd0 && op <= 0xd3) || (op >= 0xd8 && op <= 0xdf) || op === 0xf6 || op === 0xf7 || op === 0xfe || op === 0xff ||
    op === 0x69 || op === 0x6b || op === 0xc0 || op === 0xc1 || op === 0x62;
  if (hasModrm) {
    const b = m[p++], mod = b >> 6, rm = b & 7, reg = (b >> 3) & 7;
    if (mod === 1) { f.push([p - a, rm === 6 && loose ? 'l8' : 'd8']); p += 1; }
    else if (mod === 2 || (mod === 0 && rm === 6)) { f.push([p - a, mod === 0 ? 'm16' : rm === 6 || rm === 2 || rm === 3 ? 'l16' : 'd16']); p += 2; }
    if (op === 0x80 || op === 0x82 || op === 0x83 || op === 0xc6 || op === 0x6b || op === 0xc0 || op === 0xc1 || (op === 0xf6 && reg < 2)) { f.push([p - a, 'i8']); p += 1; }
    else if (op === 0x81 || op === 0xc7 || op === 0x69 || (op === 0xf7 && reg < 2)) { f.push([p - a, 'i16']); p += 2; }
  } else if ((op >= 0x70 && op < 0x80) || REL8.has(op)) { f.push([p - a, 'r8']); p += 1; }
  else if (IMM8.has(op) || (op >= 0xb0 && op < 0xb8)) { f.push([p - a, 'i8']); p += 1; }
  else if (IMM16.has(op) || (op >= 0xb8 && op < 0xc0)) { f.push([p - a, 'i16']); p += 2; }
  else if (op >= 0xa0 && op <= 0xa3) { f.push([p - a, 'm16']); p += 2; }
  else if (op === 0xe8 || op === 0xe9) { f.push([p - a, 'r16']); p += 2; }
  else if (op === 0x9a || op === 0xea) { f.push([p - a, 'far']); p += 4; }
  else if (op === 0xc8) p += 3;
  return { len: p - a, fields: f, op };
}
// l16: a local or argument, [bp+d16]; l8: the same with a short displacement, only with --loose.
const SIZE = { d8: 1, l8: 1, i8: 1, r8: 1, d16: 2, l16: 2, m16: 2, i16: 2, r16: 2, far: 4 };
const WILD = new Set(['d16', 'l16', 'i16', 'r8', 'r16', 'm16', 'far', 'l8']);
// Token: the instruction's bytes with address-like operands blanked.
function token(m, a, L) {
  const wild = new Uint8Array(L.len);
  for (const [o, k] of L.fields) if (WILD.has(k)) wild.fill(1, o, o + SIZE[k]);
  let s = '';
  for (let i = 0; i < L.len; i++) s += wild[i] ? '..' : m[a + i].toString(16).padStart(2, '0');
  return s;
}
const sweep = (m, from, to, max = Infinity) => {
  const out = [];
  for (let a = from; a < to && out.length < max;) { const L = layout(m, a); out.push({ a, L, t: token(m, a, L) }); a += L.len; }
  return out;
};
const sweepB = (a, n) => sweep(B, a, DS, n);

const procs = Object.entries(PROCS).filter(([k, v]) => v < DS && !/^seg\d+$/.test(k)).sort((x, y) => x[1] - y[1]);
const bounds = [...new Set([...Object.values(PROCS).filter(v => v < DS), DS])].sort((x, y) => x - y);
const endOf = a => bounds[bounds.findIndex(b => b > a)];
const byAddr = Object.fromEntries(procs.map(([n, a]) => [a, n]));

// Index of the other build: token K-grams -> instruction index (linear sweep; data in the code
// desynchronizes it only locally).
const bt = sweep(B, MS_SEG * 16, DS), K = 5;
const keyAt = (t, i) => t.slice(i, i + K).map(x => x.t).join(' ');
const index = new Map();
for (let i = 0; i + K <= bt.length; i++) { const k = keyAt(bt, i); let l = index.get(k); if (!l) index.set(k, l = []); l.push(i); }

// LCS over tokens -> list of [i, j] matched pairs.
function lcs(x, y) {
  const n = x.length, m = y.length, W = m + 1, dp = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i * W + j] = x[i].t === y[j].t ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (x[i].t === y[j].t) pairs.push([i++, j++]);
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++; else j++;
  }
  return pairs;
}
// Can a function start here? Only after a return, a jump or padding (or at a segment's start).
const afterCode = a => [0xcb, 0xc3, 0x90, 0x00].includes(B[a - 1]) || [0xca, 0xc2, 0xe9].includes(B[a - 3]) || B[a - 2] === 0xeb || codeSegsB.includes(a >> 4);
// Candidate start addresses in the other build for a proc: where its rare K-grams occur,
// walked back to the proc's first instruction.
function candidates(at, addr) {
  const out = new Set();
  let used = 0;
  for (let s = 0; s + K <= at.length && used < 6; s += s < 12 ? 1 : 7) {
    const cands = index.get(keyAt(at, s));
    if (!cands || cands.length > 3) continue;
    used++;
    for (const c of cands) {
      const d = at[s].a - addr;
      if (!s) { out.add(bt[c].a); continue; }
      let best = null, bestScore = -1;
      for (let off = Math.max(0, d - 40); off <= d + 40; off++) {
        const sw = sweepB(bt[c].a - off, s + 20), hit = sw.findIndex(x => x.a === bt[c].a);
        if (hit < 0 || sw[0].t !== at[0].t || !afterCode(bt[c].a - off)) continue;
        const sc = lcs(at.slice(0, s), sw.slice(0, hit)).length - Math.abs(off - d) / 1000;
        if (sc > bestScore) { bestScore = sc; best = bt[c].a - off; }
      }
      if (best !== null) out.add(best);
    }
  }
  return out;
}
function align(at, bAddr) {
  const bproc = sweepB(bAddr, at.length + 80 + (at.length >> 3));
  const pairs = lcs(at, bproc);
  const lastA = pairs.length ? pairs[pairs.length - 1][0] : 0, lastB = pairs.length ? pairs[pairs.length - 1][1] : 0;
  return { bproc, pairs, bN: Math.min(bproc.length, lastB + 1 + (at.length - 1 - lastA)) };
}

const result = {}, votes = { m16: new Map(), d16: new Map(), i16: new Map() }, callVotes = new Map();
const vote = (map, k, v) => { let m = map.get(k); if (!m) map.set(k, m = new Map()); m.set(v, (m.get(v) ?? 0) + 1); };
const top = m => [...m.entries()].sort((x, y) => y[1] - x[1])[0];
const sweeps = Object.fromEntries(procs.map(([name, addr]) => [name, sweep(A, addr, endOf(addr))]));
// Call targets found in one pass seed the next: they locate procs exactly.
for (let pass = 0; pass < 3; pass++) {
  for (const m of Object.values(votes)) m.clear();
  const prev = new Map(callVotes);
  callVotes.clear();
  for (const [name, addr] of procs) {
    const at = sweeps[name], cands = candidates(at, addr);
    const called = prev.has(addr) ? top(prev.get(addr))[0] : null;
    if (called) cands.add(called);
    let best = null;
    for (const c of cands) {
      // A call target is the proc's exact start; a searched one may be a few bytes off.
      const r = align(at, c), score = r.pairs.length * (c === called ? 1.1 : 1) - Math.abs(r.bN - at.length) / 1000;
      if (!best || score > best.score) best = { ...r, to: c, score };
    }
    if (!best) { result[name] = { addr, found: false, n: at.length }; continue; }
    const { bproc, pairs, bN, to } = best;
    result[name] = { addr, to, n: at.length, matched: pairs.length, bN, same: pairs.length === at.length && bN === at.length, found: true };
    if (pairs.length < at.length * 0.5) continue; // too weak to trust its operands
    for (const [i, j] of pairs) {
      const x = at[i], y = bproc[j];
      for (const [o, kind] of x.L.fields) {
        if (votes[kind]) vote(votes[kind], rw(A, x.a + o), rw(B, y.a + o));
        else if (kind === 'far') vote(callVotes, rw(A, x.a + o + 2) * 16 + rw(A, x.a + o), rw(B, y.a + o + 2) * 16 + rw(B, y.a + o));
        else if (kind === 'r16' && x.L.op === 0xe8) { // near call: relative to the instruction's end
          vote(callVotes, x.a + x.L.len + ((rw(A, x.a + o) << 16) >> 16), y.a + y.L.len + ((rw(B, y.a + o) << 16) >> 16));
        }
      }
    }
  }
}

// Globals. A direct memory operand (m16) is always a global's address; displacements and
// immediates may be constants that happen to equal one, so they only count when nothing better
// exists and they agree with how the neighbouring globals moved.
const labels = Object.entries(LABELS).map(([k, [o, w]]) => [k, o, w]).sort((x, y) => x[1] - y[1]);
const extra = JSON.parse(readFileSync(new URL('./vermap-ms.json', import.meta.url)));
const globals = {};
for (const [k, o] of labels) {
  const m = votes.m16.get(o);
  if (m) { const [v, c] = top(m); globals[k] = { to: v, votes: c, of: [...m.values()].reduce((s, x) => s + x, 0), by: 'm16' }; }
}
const anchored = labels.filter(([k]) => globals[k]).map(([k, o]) => [o, globals[k].to - o]);
const nearDeltas = o => {
  const i = anchored.findIndex(x => x[0] > o);
  return [anchored[(i < 0 ? anchored.length : i) - 1]?.[1], i < 0 ? undefined : anchored[i][1]];
};
for (const [k, o] of labels) {
  if (globals[k]) continue;
  const [dp, dn] = nearDeltas(o);
  for (const kind of ['d16', 'i16']) {
    const m = votes[kind].get(o);
    if (!m) continue;
    const [v, c] = top(m), near = d => d !== undefined && Math.abs(v - o - d) <= 128;
    if (v - o === dp || v - o === dn || (m.size === 1 && v !== o && (near(dp) || near(dn)))) {
      globals[k] = { to: v, votes: c, of: [...m.values()].reduce((s, x) => s + x, 0), by: kind };
      break;
    }
  }
  // Never referenced by matched code: it moved with its neighbours if they moved together.
  if (!globals[k] && dp !== undefined && dp === dn) globals[k] = { to: o + dp, votes: 0, of: 0, by: 'neighbours' };
}
// Initialized tables that are still unplaced: where the same bytes are, if that is one place.
const DATA_END = 0x5600; // initialized data ends before this in both builds
labels.forEach(([k, o], i) => {
  const size = (labels[i + 1]?.[1] ?? o) - o;
  if (globals[k] || o >= DATA_END || size < 8) return;
  const hits = [];
  scan: for (let p = 0; p < DATA_END; p++) {
    for (let j = 0; j < size; j++) if (B[DS + p + j] !== A[DS + o + j]) continue scan;
    hits.push(p);
  }
  if (hits.length === 1 && A.subarray(DS + o, DS + o + size).some(b => b)) globals[k] = { to: hits[0], votes: 0, of: 0, by: 'content' };
});
// Two globals cannot share an address: keep the one with the best evidence, drop the others
// (they do not exist in this build, or were not found).
const RANK = ['m16', 'd16', 'i16', 'content', 'neighbours'];
const byTo = new Map();
for (const [k, g] of Object.entries(globals)) { let l = byTo.get(g.to); if (!l) byTo.set(g.to, l = []); l.push(k); }
for (const names of byTo.values()) {
  if (names.length < 2) continue;
  names.sort((x, y) => RANK.indexOf(globals[x].by) - RANK.indexOf(globals[y].by) || globals[y].votes - globals[x].votes);
  const tie = globals[names[0]].by === globals[names[1]].by && globals[names[0]].votes === globals[names[1]].votes;
  for (const k of names.slice(tie ? 0 : 1)) delete globals[k];
}
for (const [k, v] of Object.entries(extra.labels)) {
  if (v === null) delete globals[k];
  else globals[k] = { to: v[0], width: v[1], by: 'manual' };
}

// --struct label,size: how the offsets inside one global map (m16 votes), e.g. a struct's fields.
const structArg = opt('--struct');
if (structArg) {
  const [k, size] = structArg.split(','), base = LABELS[k][0], to = globals[k].to;
  let last = null;
  for (let o = base; o < base + +size; o++) {
    const m = votes.m16.get(o) ?? votes.d16.get(o);
    if (!m) continue;
    const [v, c] = top(m), d = (v - to) - (o - base);
    if (d !== last) console.log(`+0x${(o - base).toString(16)} -> +0x${(v - to).toString(16)}  (shift ${d}, ${c} votes of ${[...m.values()].reduce((s, x) => s + x, 0)})`);
    last = d;
  }
}
if (why) for (const k of why.split(',')) {
  const o = LABELS[k][0];
  console.log(k, o.toString(16), '->', globals[k] ? globals[k].to.toString(16) + ' by ' + globals[k].by : 'unmapped', 'neighbour deltas', nearDeltas(o).join('/'),
    ['m16', 'd16', 'i16'].map(kind => kind + ':' + [...(votes[kind].get(o) ?? [])].map(([v, c]) => `${v.toString(16)}(${v - o})x${c}`).join(',')).join('  '));
}
if (diffProc !== null) {
  const tmp = new URL('../ref/tmp/', import.meta.url).pathname; // the two images, for objdump
  mkdirSync(tmp, { recursive: true });
  writeFileSync(tmp + 'verA.bin', A); writeFileSync(tmp + 'verB.bin', B);
  const dis = (f, from, to) => {
    const out = execFileSync('objdump', ['-D', '-b', 'binary', '-mi8086', '-Mintel', '--no-show-raw-insn',
      `--start-address=0x${from.toString(16)}`, `--stop-address=0x${to.toString(16)}`, tmp + f], { encoding: 'utf8', maxBuffer: 1 << 26 });
    const m = new Map();
    for (const l of out.split('\n')) { const x = l.match(/^\s*([0-9a-f]+):\s+(.*)$/); if (x) m.set(parseInt(x[1], 16), x[2].replace(/\s+/g, ' ')); }
    return m;
  };
  const labA = labels.map(([k, o]) => [o, k]);
  const labB = Object.entries(globals).map(([k, g]) => [g.to, k]).sort((x, y) => x[0] - y[0]);
  const nameAt = (tab, v) => {
    let lo = 0, hi = tab.length - 1, r = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (tab[mid][0] <= v) { r = tab[mid]; lo = mid + 1; } else hi = mid - 1; }
    return !r ? null : r[0] === v ? r[1] : v - r[0] < 64 ? `${r[1]}+${v - r[0]}` : null;
  };
  const procB = new Map(Object.entries(result).filter(([, r]) => r.found).map(([n, r]) => [r.to, n]));
  const note = (m, x, tab, procName) => {
    const out = [];
    for (const [o, kind] of x.L.fields) {
      if (votes[kind]) { const v = rw(m, x.a + o), n = v >= 0x40 ? nameAt(tab, v) : null; if (n && (kind !== 'i16' || !n.includes('+'))) out.push((kind === 'i16' ? '?' : '') + n); }
      else if (kind === 'far') out.push(procName(rw(m, x.a + o + 2) * 16 + rw(m, x.a + o)) ?? '?');
      else if (kind === 'r16' && x.L.op === 0xe8) out.push(procName(x.a + x.L.len + ((rw(m, x.a + o) << 16) >> 16)) ?? '?');
    }
    return out.length ? '   ; ' + out.join(', ') : '';
  };
  // --at addr,count: the Mindscape code at an address (hex), with the same annotations.
  const at0 = opt('--at');
  if (at0) {
    const [a, n] = at0.split(','), from = parseInt(a, 16), ins = sweepB(from, +(n ?? 60));
    const dB = dis('verB.bin', from, ins[ins.length - 1].a + 16);
    for (const x of ins) console.log(`  ${x.a.toString(16)}  ${dB.get(x.a) ?? '??'}${note(B, x, labB, t => procB.get(t))}`);
  }
  for (const spec of diffProc.split(',').filter(Boolean)) {
    // name, or name..end: everything from proc `name` up to proc `end` as one piece (for a
    // function restunts splits with inner labels).
    const [name, upto] = spec.split('..');
    const addr = PROCS[name], at = upto ? sweep(A, addr, PROCS[upto]) : sweeps[name];
    if (!result[name]?.found) { console.log(name + ': not found in the other build'); continue; }
    const { bproc, pairs, bN } = align(at, result[name].to);
    console.log(`\n=== ${name}: ${addr.toString(16)} -> ${result[name].to.toString(16)}  ${pairs.length}/${at.length} match (other build ${bN} instr)`);
    const dA = dis('verA.bin', addr, at[at.length - 1].a + at[at.length - 1].L.len), dB = dis('verB.bin', bproc[0].a, bproc[Math.min(bN + 20, bproc.length) - 1].a + 16);
    const la = x => `${x.a.toString(16)}  ${dA.get(x.a) ?? '??'}${note(A, x, labA, t => byAddr[t])}`;
    const lb = x => `${x.a.toString(16)}  ${dB.get(x.a) ?? '??'}${note(B, x, labB, t => procB.get(t))}`;
    if (disProc) { for (let j = 0; j < bN; j++) console.log('  ' + lb(bproc[j])); continue; }
    // Matched instructions hide their 16-bit operands; list those that changed to something
    // other than the same global at its new place (constants, other variables, struct offsets).
    const sameGlobal = (a, b) => { const na = nameAt(labA, a); return na !== null && na === nameAt(labB, b); };
    // An offset in GAMESTATE: the Mindscape CARSTATEs are 0x18 shorter (no car_whlWorldCrds2 at 0x8c).
    const car = rel => (rel < 0x8c ? rel : rel < 0xa4 ? NaN : rel - 0x18);
    const inState = o => (o < 0x152 ? o : o < 0x222 ? 0x152 + car(o - 0x152) : o < 0x2f2 ? 0x20a + car(o - 0x222) : o - 0x30);
    const stA = LABELS.state[0], stB = globals.state.to;
    const sameField = (a, b) => (a >= stA && a < stA + 0x460 ? b === stB + inState(a - stA) : a <= 0x460 && b === inState(a));
    const operands = [];
    for (const [pi, pj] of pairs) {
      const x = at[pi], y = bproc[pj];
      for (const [o, kind] of x.L.fields) {
        if (kind !== 'i16' && kind !== 'd16' && kind !== 'm16') continue;
        const a = rw(A, x.a + o), b = rw(B, y.a + o);
        if (a === b || sameGlobal(a, b) || sameField(a, b) || (a === 0x230 && b === 0x218)) continue; // 0x230: GAMESTATE words
        if (kind === 'i16' && segsA.has(a) && segsB.has(b)) continue; // a segment
        if (kind === 'd16' && a >= 0x8c && a < 0xd0 && b === a - 0x18) continue; // CARSTATE without car_whlWorldCrds2
        operands.push(`    ~ ${la(x)}\n      ${lb(y)}`);
      }
    }
    let i = 0, j = 0;
    const all = [...pairs, [at.length, bN]];
    for (let k = 0; k < all.length; k++) {
      const [pi, pj] = all[k];
      if (i < pi || j < pj) {
        console.log(`  --- at +${at[Math.min(i, at.length - 1)].a - addr}`);
        for (let c = Math.max(0, k - ctx); c < k; c++) console.log('      ' + la(at[all[c][0]]));
        for (; i < pi; i++) console.log('    - ' + la(at[i]));
        for (; j < pj; j++) console.log('    + ' + lb(bproc[j]));
      }
      i = pi + 1; j = pj + 1;
    }
    if (operands.length) console.log(`  --- operands of matching instructions (${operands.length})\n` + operands.join('\n'));
  }
} else {
  const r = Object.values(result);
  console.log(`procs: ${r.filter(x => x.same).length} identical, ${r.filter(x => x.found && !x.same).length} differ, ${r.filter(x => !x.found).length} not found, of ${r.length}`);
  console.log(`globals: ${Object.keys(globals).length} of ${labels.length} mapped (` +
    ['m16', 'd16', 'i16', 'neighbours', 'content', 'manual'].map(b => `${Object.values(globals).filter(g => g.by === b).length} by ${b}`).join(', ') + ')');
}

if (write) {
  if (loose) throw new Error('--loose is for reading diffs: it weakens the matching the tables rely on');
  const out = {};
  codeSegsB.forEach((s, i) => { out['seg' + String(i).padStart(3, '0')] = s * 16; });
  for (const [name, r] of Object.entries(result)) if (r.found && r.matched >= r.n * 0.5 && !/^(algn|nullsub|nopsub)_/.test(name)) out[name] = r.to;
  Object.assign(out, extra.procs);
  writeFileSync(new URL('../src/procs-ms.js', import.meta.url),
    '// Generated by tools/vermap.mjs: function / segment linear addresses in the Mindscape build (loaded at segment 0x10DD).\nexport default ' + JSON.stringify(out) + ';\n');
  const lab = {};
  for (const [k, , w] of labels) if (globals[k]) lab[k] = [globals[k].to, w];
  for (const [k, v] of Object.entries(extra.labels)) if (v) lab[k] = v;
  writeFileSync(new URL('../src/dseg-labels-ms.js', import.meta.url),
    '// Generated by tools/vermap.mjs: label -> [offset in the Mindscape build\'s data segment, declared width].\nexport default ' + JSON.stringify(lab) + ';\n');
  console.log(`wrote ${Object.keys(out).length} procs, ${Object.keys(lab).length} labels`);
}
