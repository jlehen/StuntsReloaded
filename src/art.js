// Original 2D art and text resources for the UI (title, portraits, dashboards, descriptions).
import { decompress, parseRes, parseShape2d, parsePalette } from './res.js';
import { getFile } from './files.js';

let palette;
const resCache = new Map();
function res(file) {
  if (!resCache.has(file)) {
    const f = getFile(file);
    resCache.set(file, f ? parseRes(/\.(PVS|PRE|P3S)$/i.test(file) ? decompress(f) : f) : new Map());
  }
  return resCache.get(file);
}

// A named bitmap as a canvas (index 0 transparent unless opaque). Returns null if missing.
export function bitmap(file, name, { opaque = false } = {}) {
  palette ??= parsePalette(res('SDMAIN.PVS'));
  const b = res(file).get(name);
  if (!b) return null;
  const s = parseShape2d(b);
  const canvas = document.createElement('canvas');
  canvas.width = s.width; canvas.height = s.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(s.width, s.height);
  for (let i = 0; i < s.pixels.length; i++) {
    const c = s.pixels[i];
    if (!c && !opaque) continue;
    img.data.set(palette[c], i * 4);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  canvas.dataset.x = s.x; canvas.dataset.y = s.y;
  return canvas;
}

// Text resource: ']' separates lines.
export function text(file, name) {
  const b = res(file).get(name);
  if (!b) return [];
  let s = '';
  for (const c of b) { if (!c) break; s += String.fromCharCode(c); }
  return s.split(']');
}
export const OPPONENTS = [1, 2, 3, 4, 5, 6].map(i => ({ id: i, file: `OPP${i}.PRE` }));
