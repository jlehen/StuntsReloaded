// Full verification: every module in src/ports.js enabled, all scenarios, vs the original.
import { MODULES } from '../src/ports.js';
import { traceDiff } from './trace.mjs';
process.exit(traceDiff(Object.values(MODULES).flatMap(m => m.PORTS), process.argv[2] ?? '') ? 0 : 1);
