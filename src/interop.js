// What the original game and playstunts save, so that a player can move between them and here:
// high scores (.HIG) and playstunts' backup file. Tracks (.TRK, 1802 bytes) and replays (.RPL,
// race.js) need no conversion.

// --- .HIG: 7 records of 52 bytes, best first. Record: player name at 0 (up to 16 characters),
// car name at 17, both NUL-terminated; at 41, 1 if the opponent won (the game then shows it in
// parentheses); at 42 the opponent, "XX/CAR." (its initials and its car's code) or " " when
// alone; at 50 the time in 1/20 s (little-endian word, 0xFFFF: empty record).
export const HIG_SIZE = 364;
const RECORD = 52, RECORDS = 7;
const cstr = (b, o) => { let s = ''; for (; o < b.length && b[o]; o++) s += String.fromCharCode(b[o]); return s; };
// -> [{ name, car, opponent ('' when alone), lost, frames }], best first, without the empty ones.
export function parseHig(bytes) {
  if (bytes.length !== HIG_SIZE) throw new Error('a .HIG file is 364 bytes');
  const out = [];
  for (let i = 0; i < RECORDS; i++) {
    const r = bytes.subarray(i * RECORD, (i + 1) * RECORD), frames = r[50] | (r[51] << 8);
    if (frames === 0xffff) continue;
    out.push({ name: cstr(r, 0), car: cstr(r, 17), opponent: cstr(r, 42).trim(), lost: r[41] === 1, frames });
  }
  return out.sort((a, b) => a.frames - b.frames);
}
export function buildHig(scores) {
  const file = new Uint8Array(HIG_SIZE);
  const put = (r, o, s, max) => { for (let i = 0; i < Math.min(s.length, max); i++) r[o + i] = s.charCodeAt(i) & 0xff; r[o + Math.min(s.length, max)] = 0; };
  const best = [...scores].sort((a, b) => a.frames - b.frames).slice(0, RECORDS);
  for (let i = 0; i < RECORDS; i++) {
    const r = file.subarray(i * RECORD, (i + 1) * RECORD), s = best[i];
    if (!s) { // the game's empty record: dots through the name and car fields
      r.fill(0x2e, 0, 40);
      put(r, 42, '../....', 7);
      r[50] = r[51] = 0xff;
      continue;
    }
    put(r, 0, s.name ?? '', 16);
    put(r, 17, s.car ?? '', 23);
    r[41] = s.opponent ? (s.lost ? 1 : 0) : 2;
    put(r, 42, s.opponent || ' ', 7);
    r[50] = s.frames & 0xff; r[51] = (s.frames >> 8) & 0xff;
  }
  return file;
}

// --- playstunts' backup: JSON with every file it saved, each under its DOS path on a virtual
// C: drive, base64-encoded. { format: 'playstunts-backup', version: 1, directory: 'C:\\',
// files: [{ key: 'C:\\NAME.TRK', bytes: '<base64>', order? }] }.
const b64 = {
  enc: u => { let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(s); },
  dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0)),
};
// -> [{ name, ext ('TRK', 'RPL', 'HIG', ...), bytes }] for the files in any directory.
export function parseBackup(text) {
  const v = JSON.parse(text);
  if (v?.format !== 'playstunts-backup' || v.version !== 1 || !Array.isArray(v.files)) throw new Error('not a playstunts backup');
  const out = [];
  for (const f of v.files) {
    const m = typeof f?.key === 'string' && typeof f.bytes === 'string' && f.key.match(/([^\\]+)\.([A-Z0-9]{1,3})$/i);
    if (m) out.push({ name: m[1].toUpperCase(), ext: m[2].toUpperCase(), bytes: b64.dec(f.bytes) });
  }
  return out;
}
// files: [{ name, ext, bytes }]. playstunts accepts names of 1 to 8 letters, digits, _ and -.
export function buildBackup(files) {
  const ok = files.filter(f => /^[A-Z0-9_-]{1,8}$/i.test(f.name));
  return JSON.stringify({ format: 'playstunts-backup', version: 1, directory: 'C:\\',
    files: ok.map((f, i) => ({ key: `C:\\${f.name.toUpperCase()}.${f.ext}`, bytes: b64.enc(f.bytes), order: i + 1 })) });
}
