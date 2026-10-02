// Which build of the game the simulation follows. The two builds differ in the driving code
// (and in where their globals and functions live), so each has its own address tables, and the
// ports branch on MS wherever the builds disagree.
//   'bb': Broderbund Stunts 1.1 (Feb 1991), the executable restunts disassembles.
//   'ms': Mindscape 4D Sports Driving 1.1 (Dec 1990), the build playstunts reconstructs.
// It is fixed before the simulation modules load (they resolve addresses at import): the page's
// entry point sets globalThis.STUNTS_VERSION from the executable it found, and the tools take
// the STUNTS_VERSION environment variable.
export const VERSION = globalThis.STUNTS_VERSION ?? globalThis.process?.env?.STUNTS_VERSION ?? 'bb';
export const MS = VERSION === 'ms';

// playstunts knowingly departs from the Mindscape original in one place: a stopped car that finds
// a wheel across a wall is moved clear of it, where the original divides by zero (player.js,
// wallHit). With rules.playstunts set the ports do as playstunts does. The game sets it on the
// Mindscape build; the verification tools leave it off, so the ports are compared with the
// original as it is (tools/test-playstunts.mjs checks the departure itself).
export const rules = { playstunts: false };
