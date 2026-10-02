// Entry point: finds a copy of the game, settles which build to play (version.js), and only then
// loads the game itself, whose modules resolve that build's addresses as they are imported.
import { findCopies, addUserFiles, CARS, available } from './store.js';

const $ = id => document.getElementById(id);
const GAME_FILES = ['GAME1.P3S', 'GAME2.P3S', 'GAME.PRE', 'SDMAIN.PVS', 'SDTITL.PVS', 'SDOSEL.PVS', 'DEFAULT.TRK', 'DEFAULT.RPL',
  ...CARS.flatMap(c => [`CAR${c}.RES`, `ST${c}.P3S`, `STDA${c}.PVS`, `STDB${c}.PVS`]),
  ...[1, 2, 3, 4, 5, 6].flatMap(i => [`OPP${i}.PRE`, `OPP${i}WIN.PVS`, `OPP${i}LOSE.PVS`]),
  'DESERT.PVS', 'TROPICAL.PVS', 'ALPINE.PVS', 'CITY.PVS', 'COUNTRY.PVS'];
// The build to play: ?version=, else the one chosen in the menu, else Mindscape's (the one
// playstunts reconstructs), when a copy of it is at hand.
const wanted = new URLSearchParams(location.search).get('version') ?? localStorage.getItem('stunts.version') ?? 'ms';

let copies = await findCopies();
if (!copies.length) {
  $('status').textContent = '';
  $('files').hidden = false;
  await new Promise(resolve => {
    const take = async list => {
      if (await addUserFiles(list)) resolve();
      else $('files-msg').textContent = 'No game found in there: it needs GAME.EXE, or MCGA.HDR, MCGA.COD, MCGA.DIF and EGA.CMN, with the other files.';
    };
    $('files-pick').onchange = e => take(e.target.files);
    $('files-zip').onchange = e => take(e.target.files);
    addEventListener('dragover', e => e.preventDefault());
    addEventListener('drop', e => { e.preventDefault(); take(e.dataTransfer.files); });
  });
  $('files').hidden = true;
  $('status').textContent = 'Loading…';
  copies = await findCopies();
}
const copy = copies.find(c => c.version === wanted) ?? copies[0];
await copy.load(GAME_FILES);
available.push(...new Set(copies.map(c => c.version)));
globalThis.STUNTS_VERSION = copy.version;
await import('./main.js');
