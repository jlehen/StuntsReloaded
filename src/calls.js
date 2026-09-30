// Call layer between JS ports and original code. Every simulation function is called as
// call.name(...args) with the original's arguments: 'w' = 16-bit word (int, char), 'n' = near
// pointer, 'l' = 32-bit long, 'f' = far pointer. JS sees all pointers as linear addresses
// (NULL stays 0); a ':n' suffix marks a near-pointer return value. If a JS port is
// provided and enabled it runs directly; otherwise the original runs in the interpreter.
// Enabled ports are also hooked, so original code calling them reaches the JS version.
import { callOrig, hook, unhook, cpu } from './engine.js';
import { rw, rd, ww, DS, DSEG } from './mem.js';

// Argument signatures (from the asm arg_ layouts). Add entries as needed.
export const SIGS = {
  update_gamestate: '', player_op: 'w', opponent_op: '', update_car_speed: 'wwnn',
  update_rpm_from_speed: 'wwwww', upd_statef20_from_steer_input: 'w', update_grip: 'nnw',
  car_car_speed_adjust_maybe: 'nn', carState_rc_op: 'nww', update_player_state: 'nnnnw',
  build_track_object: 'nn', bto_auxiliary1: 'wwn', car_car_coll_detect_maybe: 'nnnn',
  detect_penalty: 'nn', sub_18D60: 'wnwn', update_crash_state: 'ww',
  sub_19BA0: '', sub_2298C: '', init_plantrak: '', do_opponent_op: '',
  plane_rotate_op: '', plane_origin_op: 'wwww', vec_normalInnerProduct: 'wwwf',
  track_setup: '', subst_hillroad_track: 'ww', load_opponent_data: '', init_game_state: 'w',
  restore_gamestate: 'w', init_carstate_from_simd: 'nnwlllw', setup_aero_trackdata: 'fw',
  get_kevinrandom: '', init_kevinrandom: 'n', get_kevinrandom_seed: 'n', replay_unk2: 'w',
  mat_mul_vector: 'nnn', mat_mul_vector2: 'nfn', mat_multiply: 'nnn', mat_invert: 'nn',
  mat_rot_x: 'nw', mat_rot_y: 'nw', mat_rot_z: 'nw', mat_rot_zxy: 'wwww:n', polarAngle: 'ww',
  polarRadius2D: 'ww', polarRadius3D: 'n', sin_fast: 'w', cos_fast: 'w', multiply_and_scale: 'ww',
  vector_op_unk: 'nnnw', init_polyinfo: '', init_unknown: '', set_default_car: '', calc_sincos80: '',
};

// Port modules may add signatures for functions not listed above.
export const defineSigs = sigs => Object.assign(SIGS, sigs);

const impl = {};
const enabled = new Set();

// Register a JS port (not yet active).
export function provide(fns) { Object.assign(impl, fns); }
// Activate ports by name (and hook them so original callers use them too).
export function enable(names) {
  for (const n of names) {
    if (!impl[n]) throw new Error('no JS port for ' + n);
    if (SIGS[n] === undefined) throw new Error('no signature for ' + n);
    enabled.add(n);
    const [sig, ret] = SIGS[n].split(':');
    hook(n, a => {
      const r = impl[n](...fromStack(sig, a));
      return ret === 'n' ? (r ? r - DS : 0) : r;
    });
  }
}
export function disable(names = [...enabled]) { for (const n of names) { enabled.delete(n); unhook(n); } }
export const isEnabled = n => enabled.has(n);
export const provided = () => Object.keys(impl);

function fromStack(sig, a) {
  const out = [];
  for (const t of sig) {
    if (t === 'w') { out.push(rw(a)); a += 2; }
    else if (t === 'n') { const v = rw(a); out.push(v ? DS + v : 0); a += 2; }
    else if (t === 'l') { out.push(rd(a) | 0); a += 4; }
    else { out.push(((rw(a + 2) << 4) + rw(a)) & 0xfffff); a += 4; }
  }
  return out;
}
function toWords(sig, args) {
  const out = [];
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i], v = args[i];
    if (t === 'w') out.push(v & 0xffff);
    else if (t === 'n') out.push(v ? (v - DS) & 0xffff : 0);
    else if (t === 'l') out.push(v & 0xffff, (v >>> 16) & 0xffff);
    else out.push(v & 15, v >>> 4);
  }
  return out;
}

// Return address [cs, ip] for the next JS-to-JS call (stack.js supplies the original call site's).
let nextReturn = null;
export const setNextReturn = (cs, ip) => { nextReturn = [cs, ip]; };

// call.fn(...args): JS port if enabled, else the original. Returns the raw dx:ax (unsigned 32-bit)
// for originals; JS ports return what they return (callers mask/sign as the original would).
// A JS port always starts with cpu.sp at its entry sp, as a far call leaves it: from original code
// the CPU pushed the arguments and return address; from JS they are pushed here. Original code
// reads uninitialized stack in places, so the residue of these pushes matters (see stack.js).
export const call = new Proxy({}, {
  get: (_, name) => (...args) => {
    if (enabled.has(name)) {
      const words = toWords(SIGS[name].split(':')[0], args), ret = nextReturn, sp0 = cpu.sp, ss = cpu.ss << 4;
      nextReturn = null;
      let sp = sp0;
      for (let i = words.length - 1; i >= 0; i--) { sp = (sp - 2) & 0xffff; ww(ss + sp, words[i]); }
      sp = (sp - 4) & 0xffff;
      if (ret) { ww(ss + sp + 2, ret[0]); ww(ss + sp, ret[1]); }
      cpu.sp = sp;
      try { return impl[name](...args); } finally { cpu.sp = sp0; }
    }
    nextReturn = null;
    if (SIGS[name] === undefined) throw new Error('no signature for ' + name);
    const [sig, ret] = SIGS[name].split(':');
    const r = callOrig(name, ...toWords(sig, args));
    return ret === 'n' ? ((r & 0xffff) ? DS + (r & 0xffff) : 0) : r;
  },
});

// A top-level call (from the game loop, not from simulation code): starts at the stack depth
// the interpreter uses for a top-level original call, so JS and original runs match.
export function callTop(name, ...args) {
  cpu.ds = cpu.ss = cpu.es = DSEG;
  cpu.sp = 0xfff0;
  return call[name](...args);
}
