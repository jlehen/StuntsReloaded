// Test helpers around the engine: a booted world with game files loaded from ../game, or with
// STUNTS_VERSION=ms from ../game-ms (the Mindscape build; STUNTS_GAME names another directory).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { addFile, getFile } from '../src/files.js';
import { boot } from '../src/race.js';
import { buildExe, exeVersion } from '../src/exe.js';
import { VERSION, MS } from '../src/version.js';

const dir = process.env.STUNTS_GAME ?? (MS && existsSync(new URL('../game-ms/', import.meta.url)) ? '../game-ms/' : '../game/');
const gameDir = new URL(dir.replace(/\/?$/, '/'), import.meta.url.replace(/[^/]*$/, ''));
for (const f of readdirSync(gameDir)) addFile(f, new Uint8Array(readFileSync(new URL(f, gameDir))));
// Retail copies carry the executable in pieces (exe.js).
if (!getFile('GAME.EXE')) addFile('GAME.EXE', buildExe(getFile));
const found = exeVersion(getFile('GAME.EXE'));
if (found !== VERSION) throw new Error(`${gameDir.pathname} holds the '${found}' build, but STUNTS_VERSION is '${VERSION}'`);
export const gameFile = n => getFile(n);
export const bootWorld = () => boot(getFile('GAME.EXE'));
export { callOrig, hook, unhook, cpu } from '../src/engine.js';
