// JS ports that replace original functions in the running game. A module is listed here only
// after its PORTS pass the lockstep traces together with the modules already listed.
import { enable } from './calls.js';
import * as math from './math.js';
import * as gamestate from './gamestate.js';
import * as track from './track.js';
import * as car from './car.js';
import * as misc from './misc.js';
import * as surface from './surface.js';
import * as player from './player.js';

export const MODULES = { math, gamestate, track, car, misc, surface, player };
export function enablePorts() { enable(Object.values(MODULES).flatMap(m => m.PORTS)); }
