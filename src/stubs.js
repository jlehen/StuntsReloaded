// JS replacements for the original's DOS-facing functions (memory manager, file loading, audio
// driver), provided as ports so both JS and original callers use them. Always enabled.
import { M, farAlloc } from './mem.js';
import { provide, defineSigs, enable } from './calls.js';
import { loadResfile, loadBinary, loadDecomp } from './files.js';

defineSigs({ mmgr_alloc_resbytes: 'nl', file_load_resfile: 'n', file_load_resource: 'wn', file_decomp_nofatal: 'n',
  file_decomp_fatal: 'n', mmgr_free: 'f', mmgr_release: 'f', ensure_file_exists: 'w', audio_carstate: '' });

const cstr = a => { let s = ''; while (M[a]) s += String.fromCharCode(M[a++]); return s; };
const far = lin => lin ? (((lin >>> 4) << 16) | (lin & 15)) >>> 0 : 0; // linear -> normalized dx:ax
const nothing = () => 0;

provide({
  mmgr_alloc_resbytes: (name, size) => far(farAlloc(size >>> 0)),
  file_load_resfile: name => far(loadResfile(cstr(name))),
  file_load_resource: (type, name) => far(type === 7 ? loadDecomp(cstr(name)) : loadBinary(cstr(name))),
  file_decomp_nofatal: name => far(loadDecomp(cstr(name))),
  file_decomp_fatal: name => far(loadDecomp(cstr(name))),
  mmgr_free: nothing, mmgr_release: nothing, // memory is reset between races instead
  ensure_file_exists: nothing, // no disk swapping
  audio_carstate: nothing, // audio only (see audio.js); writes no simulation state
});
export const PORTS = ['mmgr_alloc_resbytes', 'file_load_resfile', 'file_load_resource', 'file_decomp_nofatal', 'file_decomp_fatal',
  'mmgr_free', 'mmgr_release', 'ensure_file_exists', 'audio_carstate'];
export const enableStubs = () => enable(PORTS);
