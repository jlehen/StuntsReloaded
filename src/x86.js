// Minimal 8086 (+ a few 186 ops) interpreter. Runs original GAME.EXE functions: the
// reference for diff-testing JS ports, and the interim engine for not-yet-ported code.

const CF = 1, PF = 4, AF = 0x10, ZF = 0x40, SF = 0x80, TF = 0x100, IF = 0x200, DF = 0x400, OF = 0x800;
const PARITY = new Uint8Array(256).map((_, i) => { let p = 1; for (let b = i; b; b >>= 1) p ^= b & 1; return p; });

export class CPU {
  constructor(mem = new Uint8Array(0x110000)) {
    this.m = mem;
    this.r = new Uint16Array(8);   // AX CX DX BX SP BP SI DI
    this.s = new Uint16Array(4);   // ES CS SS DS
    this.ip = 0; this.flags = 0x0002;
    this.intHandlers = {};         // int number -> fn(cpu)
    this.hooks = new Map();        // linear addr -> fn(cpu) executed instead of the instruction
    this.probes = new Map();       // linear addr -> fn(cpu) run before the instruction executes
    this.steps = 0;
  }
  // --- memory
  lin(seg, off) { return ((seg << 4) + (off & 0xffff)) & 0xfffff; }
  rb(a) { return this.m[a]; }
  rw(a) { return this.m[a] | (this.m[a + 1] << 8); }
  wb(a, v) { this.m[a] = v; }
  ww(a, v) { this.m[a] = v; this.m[a + 1] = v >> 8; }
  // --- registers
  get ax() { return this.r[0]; } set ax(v) { this.r[0] = v; }
  get cx() { return this.r[1]; } set cx(v) { this.r[1] = v; }
  get dx() { return this.r[2]; } set dx(v) { this.r[2] = v; }
  get bx() { return this.r[3]; } set bx(v) { this.r[3] = v; }
  get sp() { return this.r[4]; } set sp(v) { this.r[4] = v; }
  get bp() { return this.r[5]; } set bp(v) { this.r[5] = v; }
  get si() { return this.r[6]; } set si(v) { this.r[6] = v; }
  get di() { return this.r[7]; } set di(v) { this.r[7] = v; }
  get es() { return this.s[0]; } set es(v) { this.s[0] = v; }
  get cs() { return this.s[1]; } set cs(v) { this.s[1] = v; }
  get ss() { return this.s[2]; } set ss(v) { this.s[2] = v; }
  get ds() { return this.s[3]; } set ds(v) { this.s[3] = v; }
  getR8(i) { return i < 4 ? this.r[i] & 0xff : this.r[i - 4] >> 8; }
  setR8(i, v) { if (i < 4) this.r[i] = (this.r[i] & 0xff00) | (v & 0xff); else this.r[i - 4] = (this.r[i - 4] & 0xff) | ((v & 0xff) << 8); }
  push(v) { this.sp -= 2; this.ww(this.lin(this.ss, this.sp), v); }
  pop() { const v = this.rw(this.lin(this.ss, this.sp)); this.sp += 2; return v; }
  f(bit) { return (this.flags & bit) !== 0; }
  setF(bit, on) { if (on) this.flags |= bit; else this.flags &= ~bit; }
  // --- fetch
  fb() { const v = this.m[this.lin(this.cs, this.ip)]; this.ip = (this.ip + 1) & 0xffff; return v; }
  fw() { const v = this.fb(); return v | (this.fb() << 8); }
  fsb() { return (this.fb() << 24) >> 24; }

  // Decode ModR/M; sets this.mod/reg/rm/ea (linear) or register operand.
  modrm() {
    const b = this.fb();
    this.mod = b >> 6; this.reg = (b >> 3) & 7; this.rmv = b & 7;
    if (this.mod === 3) { this.isReg = true; return; }
    this.isReg = false;
    let off, seg = this.s[3];
    const r = this.r;
    switch (this.rmv) {
      case 0: off = r[3] + r[6]; break;
      case 1: off = r[3] + r[7]; break;
      case 2: off = r[5] + r[6]; seg = this.s[2]; break;
      case 3: off = r[5] + r[7]; seg = this.s[2]; break;
      case 4: off = r[6]; break;
      case 5: off = r[7]; break;
      case 6: if (this.mod === 0) off = this.fw(); else { off = r[5]; seg = this.s[2]; } break;
      case 7: off = r[3]; break;
    }
    if (this.mod === 1) off += this.fsb();
    else if (this.mod === 2) off += this.fw();
    if (this.segOv >= 0) seg = this.s[this.segOv];
    this.eaSeg = seg; this.eaOff = off & 0xffff;
    this.ea = this.lin(seg, off);
  }
  rm8() { return this.isReg ? this.getR8(this.rmv) : this.m[this.ea]; }
  rm16() { return this.isReg ? this.r[this.rmv] : this.rw(this.ea); }
  setRm8(v) { if (this.isReg) this.setR8(this.rmv, v); else this.m[this.ea] = v; }
  setRm16(v) { if (this.isReg) this.r[this.rmv] = v; else this.ww(this.ea, v); }
  ea2() { return this.lin(this.eaSeg, this.eaOff + 2); }

  // --- ALU with flags. w = 8 or 16
  szp(v, w) {
    const mask = w === 8 ? 0xff : 0xffff;
    v &= mask;
    this.setF(ZF, v === 0); this.setF(SF, v & (w === 8 ? 0x80 : 0x8000)); this.setF(PF, PARITY[v & 0xff]);
    return v;
  }
  alu(op, a, b, w) {
    const mask = w === 8 ? 0xff : 0xffff, sign = w === 8 ? 0x80 : 0x8000;
    let r;
    switch (op) {
      case 0: case 2: { // add, adc
        const c = op === 2 && this.f(CF) ? 1 : 0;
        r = a + b + c;
        this.setF(CF, r > mask); this.setF(OF, (~(a ^ b) & (a ^ r)) & sign); this.setF(AF, (a ^ b ^ r) & 0x10);
        return this.szp(r, w);
      }
      case 5: case 3: case 7: { // sub, sbb, cmp
        const c = op === 3 && this.f(CF) ? 1 : 0;
        r = a - b - c;
        this.setF(CF, r < 0); this.setF(OF, ((a ^ b) & (a ^ r)) & sign); this.setF(AF, (a ^ b ^ r) & 0x10);
        return this.szp(r, w);
      }
      case 1: r = a | b; break;
      case 4: r = a & b; break;
      case 6: r = a ^ b; break;
    }
    this.setF(CF, 0); this.setF(OF, 0); this.setF(AF, 0);
    return this.szp(r, w);
  }
  incdec(v, dec, w) {
    const cf = this.f(CF);
    const r = this.alu(dec ? 5 : 0, v, 1, w);
    this.setF(CF, cf);
    return r;
  }
  shift(op, v, cnt, w) {
    const bits = w, mask = w === 8 ? 0xff : 0xffff, sign = w === 8 ? 0x80 : 0x8000;
    cnt &= 0x1f;
    if (!cnt) return v;
    let r = v, cf;
    switch (op) {
      case 0: for (let i = 0; i < cnt; i++) { cf = r & sign ? 1 : 0; r = ((r << 1) | cf) & mask; } this.setF(CF, cf); this.setF(OF, ((r & sign) ? 1 : 0) ^ cf); return r; // rol
      case 1: for (let i = 0; i < cnt; i++) { cf = r & 1; r = (r >> 1) | (cf ? sign : 0); } this.setF(CF, cf); this.setF(OF, ((r ^ (r << 1)) & sign)); return r; // ror
      case 2: for (let i = 0; i < cnt; i++) { const c = this.f(CF) ? 1 : 0; cf = r & sign ? 1 : 0; r = ((r << 1) | c) & mask; this.setF(CF, cf); } this.setF(OF, ((r & sign) ? 1 : 0) ^ (this.f(CF) ? 1 : 0)); return r; // rcl
      case 3: for (let i = 0; i < cnt; i++) { const c = this.f(CF) ? sign : 0; cf = r & 1; r = (r >> 1) | c; this.setF(CF, cf); } this.setF(OF, ((r ^ (r << 1)) & sign)); return r; // rcr
      case 4: case 6: // shl
        cf = cnt <= bits ? (v >> (bits - cnt)) & 1 : 0;
        r = cnt < 32 ? (v << cnt) & mask : 0;
        this.setF(CF, cf); this.setF(OF, ((r & sign) ? 1 : 0) ^ cf);
        return this.szp(r, w);
      case 5: // shr
        cf = cnt <= bits ? (v >> (cnt - 1)) & 1 : 0;
        r = v >>> cnt;
        this.setF(CF, cf); this.setF(OF, cnt === 1 && (v & sign));
        return this.szp(r, w);
      case 7: { // sar
        const sv = w === 8 ? (v << 24) >> 24 : (v << 16) >> 16;
        const c = Math.min(cnt, bits);
        cf = (sv >> (c - 1)) & 1;
        r = (sv >> c) & mask;
        this.setF(CF, cf); this.setF(OF, 0);
        return this.szp(r, w);
      }
    }
  }
  jcc(cc) {
    const f = this.flags;
    const c = !!(f & CF), z = !!(f & ZF), s = !!(f & SF), o = !!(f & OF), p = !!(f & PF);
    switch (cc) {
      case 0: return o; case 1: return !o; case 2: return c; case 3: return !c;
      case 4: return z; case 5: return !z; case 6: return c || z; case 7: return !c && !z;
      case 8: return s; case 9: return !s; case 10: return p; case 11: return !p;
      case 12: return s !== o; case 13: return s === o; case 14: return z || s !== o; case 15: return !z && s === o;
    }
  }
  interrupt(n) {
    const h = this.intHandlers[n];
    if (h) return h(this);
    const vec = n * 4;
    const off = this.rw(vec), seg = this.rw(vec + 2);
    if (!off && !seg) throw new Error(`unhandled int ${n.toString(16)} at ${this.cs.toString(16)}:${this.ip.toString(16)}`);
    this.push(this.flags); this.push(this.cs); this.push(this.ip);
    this.setF(IF, 0); this.setF(TF, 0);
    this.cs = seg; this.ip = off;
  }
  divide(signed, w) {
    const v = w === 8 ? this.rm8() : this.rm16();
    if (v === 0) return this.divFault();
    if (w === 8) {
      if (signed) {
        const a = (this.ax << 16) >> 16, d = (v << 24) >> 24;
        const q = Math.trunc(a / d), r = a % d;
        if (q > 127 || q < -128) return this.divFault();
        this.ax = ((r & 0xff) << 8) | (q & 0xff);
      } else {
        const a = this.ax, q = Math.floor(a / v), r = a % v;
        if (q > 0xff) return this.divFault();
        this.ax = (r << 8) | q;
      }
    } else {
      if (signed) {
        const a = ((this.dx << 16) | this.ax) | 0, d = (v << 16) >> 16;
        const q = Math.trunc(a / d), r = a % d;
        if (q > 32767 || q < -32768) return this.divFault();
        this.ax = q; this.dx = r;
      } else {
        const a = ((this.dx << 16) | this.ax) >>> 0, q = Math.floor(a / v), r = a % v;
        if (q > 0xffff) return this.divFault();
        this.ax = q; this.dx = r;
      }
    }
  }
  divFault() { this.ip = this.instrIp; this.interrupt(0); }

  step() {
    const addr = this.lin(this.cs, this.ip);
    const hook = this.hooks.get(addr);
    if (hook) { hook(this); return; }
    this.probes.get(addr)?.(this);
    this.steps++;
    this.instrIp = this.ip;
    this.segOv = -1;
    let rep = 0;
    let op;
    for (;;) {
      op = this.fb();
      if (op === 0x26 || op === 0x2e || op === 0x36 || op === 0x3e) { this.segOv = (op >> 3) & 3; continue; }
      if (op === 0xf2 || op === 0xf3) { rep = op; continue; }
      if (op === 0xf0) continue;
      break;
    }
    this.exec(op, rep);
  }

  exec(op, rep) {
    const r = this.r;
    if (op < 0x40 && (op & 7) < 6) { // ALU ops
      const aop = op >> 3;
      switch (op & 7) {
        case 0: { this.modrm(); const v = this.alu(aop, this.rm8(), this.getR8(this.reg), 8); if (aop !== 7) this.setRm8(v); return; }
        case 1: { this.modrm(); const v = this.alu(aop, this.rm16(), r[this.reg], 16); if (aop !== 7) this.setRm16(v); return; }
        case 2: { this.modrm(); const v = this.alu(aop, this.getR8(this.reg), this.rm8(), 8); if (aop !== 7) this.setR8(this.reg, v); return; }
        case 3: { this.modrm(); const v = this.alu(aop, r[this.reg], this.rm16(), 16); if (aop !== 7) r[this.reg] = v; return; }
        case 4: { const v = this.alu(aop, r[0] & 0xff, this.fb(), 8); if (aop !== 7) this.setR8(0, v); return; }
        case 5: { const v = this.alu(aop, r[0], this.fw(), 16); if (aop !== 7) r[0] = v; return; }
      }
    }
    if (op >= 0x40 && op < 0x50) { r[op & 7] = this.incdec(r[op & 7], op >= 0x48, 16); return; }
    if (op >= 0x50 && op < 0x58) { const v = op === 0x54 ? this.sp : r[op & 7]; this.push(v); return; }
    if (op >= 0x58 && op < 0x60) { r[op & 7] = this.pop(); return; }
    if (op >= 0x70 && op < 0x80) { const d = this.fsb(); if (this.jcc(op & 15)) this.ip = (this.ip + d) & 0xffff; return; }
    if (op >= 0x91 && op < 0x98) { const t = r[0]; r[0] = r[op & 7]; r[op & 7] = t; return; }
    if (op >= 0xb0 && op < 0xb8) { this.setR8(op & 7, this.fb()); return; }
    if (op >= 0xb8 && op < 0xc0) { r[op & 7] = this.fw(); return; }
    switch (op) {
      case 0x06: case 0x0e: case 0x16: case 0x1e: this.push(this.s[(op >> 3) & 3]); return;
      case 0x07: case 0x17: case 0x1f: this.s[(op >> 3) & 3] = this.pop(); return;
      case 0x27: case 0x2f: case 0x37: case 0x3f: throw new Error('BCD op ' + op.toString(16));
      case 0x60: { const sp = this.sp; for (const i of [0, 1, 2, 3]) this.push(r[i]); this.push(sp); this.push(r[5]); this.push(r[6]); this.push(r[7]); return; }
      case 0x61: { r[7] = this.pop(); r[6] = this.pop(); r[5] = this.pop(); this.pop(); r[3] = this.pop(); r[2] = this.pop(); r[1] = this.pop(); r[0] = this.pop(); return; }
      case 0x68: this.push(this.fw()); return;
      case 0x6a: this.push(this.fsb() & 0xffff); return;
      case 0x69: case 0x6b: {
        this.modrm();
        const a = (this.rm16() << 16) >> 16;
        const b = op === 0x69 ? (this.fw() << 16) >> 16 : this.fsb();
        const p = a * b;
        r[this.reg] = p;
        const ovf = p !== ((p << 16) >> 16);
        this.setF(CF, ovf); this.setF(OF, ovf);
        return;
      }
      case 0x80: case 0x82: { this.modrm(); const v = this.alu(this.reg, this.rm8(), this.fb(), 8); if (this.reg !== 7) this.setRm8(v); return; }
      case 0x81: { this.modrm(); const v = this.alu(this.reg, this.rm16(), this.fw(), 16); if (this.reg !== 7) this.setRm16(v); return; }
      case 0x83: { this.modrm(); const v = this.alu(this.reg, this.rm16(), this.fsb() & 0xffff, 16); if (this.reg !== 7) this.setRm16(v); return; }
      case 0x84: this.modrm(); this.alu(4, this.rm8(), this.getR8(this.reg), 8); return;
      case 0x85: this.modrm(); this.alu(4, this.rm16(), r[this.reg], 16); return;
      case 0x86: { this.modrm(); const t = this.rm8(); this.setRm8(this.getR8(this.reg)); this.setR8(this.reg, t); return; }
      case 0x87: { this.modrm(); const t = this.rm16(); this.setRm16(r[this.reg]); r[this.reg] = t; return; }
      case 0x88: this.modrm(); this.setRm8(this.getR8(this.reg)); return;
      case 0x89: this.modrm(); this.setRm16(r[this.reg]); return;
      case 0x8a: this.modrm(); this.setR8(this.reg, this.rm8()); return;
      case 0x8b: this.modrm(); r[this.reg] = this.rm16(); return;
      case 0x8c: this.modrm(); this.setRm16(this.s[this.reg & 3]); return;
      case 0x8d: this.modrm(); r[this.reg] = this.eaOff; return;
      case 0x8e: this.modrm(); this.s[this.reg & 3] = this.rm16(); return;
      case 0x8f: this.modrm(); this.setRm16(this.pop()); return;
      case 0x90: return;
      case 0x98: r[0] = ((r[0] & 0xff) << 24) >> 24; return;
      case 0x99: r[2] = r[0] & 0x8000 ? 0xffff : 0; return;
      case 0x9a: { const off = this.fw(), seg = this.fw(); this.push(this.cs); this.push(this.ip); this.cs = seg; this.ip = off; return; }
      case 0x9b: return;
      case 0x9c: this.push(this.flags | 0xf002); return;
      case 0x9d: this.flags = (this.pop() & 0x0fd5) | 2; return;
      case 0x9e: this.flags = (this.flags & 0xff00) | ((r[0] >> 8) & 0xd5) | 2; return;
      case 0x9f: this.setR8(4, this.flags & 0xff); return;
      case 0xa0: case 0xa1: case 0xa2: case 0xa3: {
        const a = this.lin(this.segOv >= 0 ? this.s[this.segOv] : this.ds, this.fw());
        if (op === 0xa0) this.setR8(0, this.m[a]); else if (op === 0xa1) r[0] = this.rw(a);
        else if (op === 0xa2) this.m[a] = r[0]; else this.ww(a, r[0]);
        return;
      }
      case 0xa8: this.alu(4, r[0] & 0xff, this.fb(), 8); return;
      case 0xa9: this.alu(4, r[0], this.fw(), 16); return;
      case 0xa4: case 0xa5: case 0xa6: case 0xa7: case 0xaa: case 0xab: case 0xac: case 0xad: case 0xae: case 0xaf:
        return this.string(op, rep);
      case 0xc0: case 0xc1: case 0xd0: case 0xd1: case 0xd2: case 0xd3: {
        this.modrm();
        const cnt = op < 0xc2 ? this.fb() : op < 0xd2 ? 1 : r[1] & 0xff;
        if (op & 1) this.setRm16(this.shift(this.reg, this.rm16(), cnt, 16));
        else this.setRm8(this.shift(this.reg, this.rm8(), cnt, 8));
        return;
      }
      case 0xc2: { const n = this.fw(); this.ip = this.pop(); this.sp += n; return; }
      case 0xc3: this.ip = this.pop(); return;
      case 0xc4: case 0xc5: { this.modrm(); r[this.reg] = this.rw(this.ea); this.s[op === 0xc4 ? 0 : 3] = this.rw(this.ea2()); return; }
      case 0xc6: this.modrm(); this.setRm8(this.fb()); return;
      case 0xc7: this.modrm(); this.setRm16(this.fw()); return;
      case 0xc8: { const n = this.fw(), lvl = this.fb(); if (lvl) throw new Error('enter level'); this.push(this.bp); this.bp = this.sp; this.sp -= n; return; }
      case 0xc9: this.sp = this.bp; this.bp = this.pop(); return;
      case 0xca: { const n = this.fw(); this.ip = this.pop(); this.cs = this.pop(); this.sp += n; return; }
      case 0xcb: this.ip = this.pop(); this.cs = this.pop(); return;
      case 0xcc: this.interrupt(3); return;
      case 0xcd: this.interrupt(this.fb()); return;
      case 0xcf: this.ip = this.pop(); this.cs = this.pop(); this.flags = (this.pop() & 0x0fd5) | 2; return;
      case 0xd4: { const b = this.fb(); const al = r[0] & 0xff; r[0] = ((Math.floor(al / b)) << 8) | (al % b); this.szp(r[0] & 0xff, 8); return; }
      case 0xd5: { const b = this.fb(); r[0] = ((r[0] & 0xff) + (r[0] >> 8) * b) & 0xff; this.szp(r[0], 8); return; }
      case 0xd7: this.setR8(0, this.m[this.lin(this.segOv >= 0 ? this.s[this.segOv] : this.ds, r[3] + (r[0] & 0xff))]); return;
      case 0xe0: case 0xe1: case 0xe2: {
        const d = this.fsb(); r[1]--;
        const z = this.f(ZF);
        if (r[1] && (op === 0xe2 || (op === 0xe1 ? z : !z))) this.ip = (this.ip + d) & 0xffff;
        return;
      }
      case 0xe3: { const d = this.fsb(); if (!r[1]) this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe4: this.fb(); this.setR8(0, 0); return;
      case 0xe5: this.fb(); r[0] = 0; return;
      case 0xe6: case 0xe7: this.fb(); return;
      case 0xec: this.setR8(0, 0); return;
      case 0xed: r[0] = 0; return;
      case 0xee: case 0xef: return;
      case 0xe8: { const d = this.fw(); this.push(this.ip); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xe9: { const d = this.fw(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xea: { const off = this.fw(), seg = this.fw(); this.cs = seg; this.ip = off; return; }
      case 0xeb: { const d = this.fsb(); this.ip = (this.ip + d) & 0xffff; return; }
      case 0xf4: throw new Error('hlt');
      case 0xf5: this.flags ^= CF; return;
      case 0xf6: case 0xf7: return this.grp3(op === 0xf6 ? 8 : 16);
      case 0xf8: this.setF(CF, 0); return;
      case 0xf9: this.setF(CF, 1); return;
      case 0xfa: this.setF(IF, 0); return;
      case 0xfb: this.setF(IF, 1); return;
      case 0xfc: this.setF(DF, 0); return;
      case 0xfd: this.setF(DF, 1); return;
      case 0xfe: { this.modrm(); if (this.reg > 1) throw new Error('bad fe'); this.setRm8(this.incdec(this.rm8(), this.reg === 1, 8)); return; }
      case 0xff: {
        this.modrm();
        switch (this.reg) {
          case 0: this.setRm16(this.incdec(this.rm16(), false, 16)); return;
          case 1: this.setRm16(this.incdec(this.rm16(), true, 16)); return;
          case 2: { const t = this.rm16(); this.push(this.ip); this.ip = t; return; }
          case 3: { const off = this.rw(this.ea), seg = this.rw(this.ea2()); this.push(this.cs); this.push(this.ip); this.cs = seg; this.ip = off; return; }
          case 4: this.ip = this.rm16(); return;
          case 5: { const off = this.rw(this.ea), seg = this.rw(this.ea2()); this.cs = seg; this.ip = off; return; }
          case 6: this.push(this.rm16()); return;
        }
        throw new Error('bad ff');
      }
    }
    if (op >= 0xd8 && op <= 0xdf) throw new Error('FPU op at ' + this.cs.toString(16) + ':' + this.instrIp.toString(16));
    throw new Error(`unknown opcode ${op.toString(16)} at ${this.cs.toString(16)}:${this.instrIp.toString(16)}`);
  }

  grp3(w) {
    this.modrm();
    const r = this.r;
    switch (this.reg) {
      case 0: case 1: this.alu(4, w === 8 ? this.rm8() : this.rm16(), w === 8 ? this.fb() : this.fw(), w); return;
      case 2: if (w === 8) this.setRm8(~this.rm8()); else this.setRm16(~this.rm16()); return;
      case 3: { const v = w === 8 ? this.rm8() : this.rm16(); const res = this.alu(5, 0, v, w); this.setF(CF, v !== 0); if (w === 8) this.setRm8(res); else this.setRm16(res); return; }
      case 4: case 5: {
        const signed = this.reg === 5;
        if (w === 8) {
          const a = signed ? ((r[0] & 0xff) << 24) >> 24 : r[0] & 0xff;
          const b = signed ? (this.rm8() << 24) >> 24 : this.rm8();
          const p = a * b; r[0] = p;
          const ovf = signed ? p !== ((p << 24) >> 24) : (p & 0xff00) !== 0;
          this.setF(CF, ovf); this.setF(OF, ovf);
        } else {
          const a = signed ? (r[0] << 16) >> 16 : r[0];
          const b = signed ? (this.rm16() << 16) >> 16 : this.rm16();
          const p = a * b; // fits in double exactly
          const lo = p & 0xffff, hi = Math.floor(p / 65536) & 0xffff;
          r[0] = lo; r[2] = hi;
          const ovf = signed ? p !== ((p << 16) >> 16) : hi !== 0;
          this.setF(CF, ovf); this.setF(OF, ovf);
        }
        return;
      }
      case 6: return this.divide(false, w);
      case 7: return this.divide(true, w);
    }
  }

  string(op, rep) {
    const w = op & 1 ? 2 : 1;
    const d = this.f(DF) ? -w : w;
    const srcSeg = this.segOv >= 0 ? this.s[this.segOv] : this.ds;
    const r = this.r;
    const once = () => {
      switch (op) {
        case 0xa4: this.m[this.lin(this.es, r[7])] = this.m[this.lin(srcSeg, r[6])]; r[6] += d; r[7] += d; break;
        case 0xa5: this.ww(this.lin(this.es, r[7]), this.rw(this.lin(srcSeg, r[6]))); r[6] += d; r[7] += d; break;
        case 0xa6: this.alu(7, this.m[this.lin(srcSeg, r[6])], this.m[this.lin(this.es, r[7])], 8); r[6] += d; r[7] += d; break;
        case 0xa7: this.alu(7, this.rw(this.lin(srcSeg, r[6])), this.rw(this.lin(this.es, r[7])), 16); r[6] += d; r[7] += d; break;
        case 0xaa: this.m[this.lin(this.es, r[7])] = r[0]; r[7] += d; break;
        case 0xab: this.ww(this.lin(this.es, r[7]), r[0]); r[7] += d; break;
        case 0xac: this.setR8(0, this.m[this.lin(srcSeg, r[6])]); r[6] += d; break;
        case 0xad: r[0] = this.rw(this.lin(srcSeg, r[6])); r[6] += d; break;
        case 0xae: this.alu(7, r[0] & 0xff, this.m[this.lin(this.es, r[7])], 8); r[7] += d; break;
        case 0xaf: this.alu(7, r[0], this.rw(this.lin(this.es, r[7])), 16); r[7] += d; break;
      }
    };
    if (!rep) return once();
    const cmp = op === 0xa6 || op === 0xa7 || op === 0xae || op === 0xaf;
    while (r[1]) {
      once(); r[1]--;
      if (cmp && (rep === 0xf3 ? !this.f(ZF) : this.f(ZF))) break;
    }
  }

  // Instruction length at linear address (decode without executing).
  length(addr) {
    const saveIp = this.ip, saveCs = this.cs;
    this.cs = addr >> 4; this.ip = addr & 15;
    let op, n = 0;
    this.segOv = -1;
    for (;;) { op = this.fb(); n++; if ([0x26, 0x2e, 0x36, 0x3e, 0xf2, 0xf3, 0xf0].includes(op)) continue; break; }
    const hasModrm = (op < 0x40 && (op & 7) < 4) || (op >= 0x80 && op <= 0x8f) || (op >= 0xc4 && op <= 0xc7) ||
      (op >= 0xd0 && op <= 0xd3) || (op >= 0xd8 && op <= 0xdf) || op === 0xf6 || op === 0xf7 || op === 0xfe || op === 0xff ||
      op === 0x69 || op === 0x6b || op === 0xc0 || op === 0xc1 || op === 0x62;
    let len = n;
    if (hasModrm) {
      const b = this.fb(); len++;
      const mod = b >> 6, rm = b & 7;
      if (mod === 1) len += 1; else if (mod === 2 || (mod === 0 && rm === 6)) len += 2;
      const reg = (b >> 3) & 7;
      if (op === 0x80 || op === 0x82 || op === 0x83 || op === 0xc6 || op === 0x6b || op === 0xc0 || op === 0xc1) len += 1;
      else if (op === 0x81 || op === 0xc7 || op === 0x69) len += 2;
      else if (op === 0xf6 && reg < 2) len += 1;
      else if (op === 0xf7 && reg < 2) len += 2;
    } else {
      const imm8 = [0x04, 0x0c, 0x14, 0x1c, 0x24, 0x2c, 0x34, 0x3c, 0x6a, 0xa8, 0xcd, 0xd4, 0xd5, 0xe0, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xeb];
      const imm16 = [0x05, 0x0d, 0x15, 0x1d, 0x25, 0x2d, 0x35, 0x3d, 0x68, 0xa0, 0xa1, 0xa2, 0xa3, 0xa9, 0xc2, 0xca, 0xe8, 0xe9];
      if ((op >= 0x70 && op < 0x80) || imm8.includes(op) || (op >= 0xb0 && op < 0xb8)) len += 1;
      else if (imm16.includes(op) || (op >= 0xb8 && op < 0xc0)) len += 2;
      else if (op === 0x9a || op === 0xea) len += 4;
      else if (op === 0xc8) len += 3;
    }
    this.ip = saveIp; this.cs = saveCs;
    return len;
  }
}

// Far-call cs:ip with cdecl word args; returns dx:ax. Runs until the sentinel returns.
// Re-entrant: registers are restored afterwards, so JS hooks can call back into original code.
const SENTINEL_SEG = 0xf000;
export function callFar(cpu, seg, off, args = [], maxSteps = 5e7) {
  const saved = [cpu.cs, cpu.ip, cpu.sp, cpu.bp, cpu.si, cpu.di, cpu.ds, cpu.es, cpu.bx, cpu.cx, cpu.flags];
  for (let i = args.length - 1; i >= 0; i--) cpu.push(args[i] & 0xffff);
  cpu.push(SENTINEL_SEG); cpu.push(0);
  cpu.cs = seg; cpu.ip = off;
  const start = cpu.steps;
  while (!(cpu.cs === SENTINEL_SEG && cpu.ip === 0)) {
    cpu.step();
    if (cpu.steps - start > maxSteps) throw new Error('callFar: step limit');
  }
  const ret = (cpu.dx << 16 | cpu.ax) >>> 0;
  [cpu.cs, cpu.ip, cpu.sp, cpu.bp, cpu.si, cpu.di, cpu.ds, cpu.es, cpu.bx, cpu.cx, cpu.flags] = saved;
  return ret;
}
