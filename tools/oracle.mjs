// Test helpers around the engine: a booted world with game files loaded from ../game.
import { readFileSync, readdirSync } from 'node:fs';
import { addFile } from '../src/files.js';
import { boot } from '../src/race.js';

const gameDir = new URL('../game/', import.meta.url);
for (const f of readdirSync(gameDir)) addFile(f, new Uint8Array(readFileSync(new URL(f, gameDir))));
export const gameFile = n => new Uint8Array(readFileSync(new URL(n, gameDir)));
export const bootWorld = () => boot(gameFile('GAME.EXE'));
export { callOrig, hook, unhook, cpu } from '../src/engine.js';
