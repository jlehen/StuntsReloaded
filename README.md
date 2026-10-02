# Stunts Reloaded

> **A much better version exists:** [playstunts](https://github.com/ACatWithEbola/playstunts), playable at https://playstunts.com.

Stunts (1990, a.k.a. *4D Sports Driving*) in the browser. The driving simulation is the original game's, ported function by function to JavaScript and verified bit-exact against the original machine code, for two releases of the game: Mindscape's *4D Sports Driving 1.1* (the one [playstunts](https://github.com/ACatWithEbola/playstunts) reconstructs, so races, replays and saves are interchangeable with it) and Broderbund's *Stunts 1.1*. The rendering is new: the original low-poly shapes drawn with Three.js, with lighting, shadows, anti-aliasing, widescreen and a smooth frame rate.

**Play it now: https://jlehen.github.io/StuntsReloaded/**

## Running

You need the data files of the game. They are not included, because they belong to the original publisher. Either release works, and the two can sit side by side:

- **4D Sports Driving 1.1** (Mindscape, 13 December 1990), the release playstunts uses: the "4D Sports Driving v1.1 (Dec 13 1990)" archive of the [Stunts community's download page](https://wiki.stunts.hu/wiki/Download). Unzip it into `game-ms/`, or give the .zip to the page (main menu, *Add files*, or drop it on the page): it is kept in the browser for later visits. This copy has no `GAME.EXE`; the page builds it from `MCGA.HDR`, `EGA.CMN`, `MCGA.DIF` and `MCGA.COD`, as the game's own loader does.
- **Stunts 1.1** (Broderbund, February 1991): put its files (`GAME.EXE`, `GAME1.P3S`, `CAR*.RES`, `ST*.P3S`, `OPP*.PRE`, ...) in `game/`. Without any copy, the page downloads this one from the [restunts](https://github.com/4d-stunts/restunts/tree/master/stunts) repository. To fetch it into `game/` yourself, from this folder:
  ```sh
  mkdir -p game && curl -L https://github.com/4d-stunts/restunts/archive/refs/heads/master.tar.gz | tar xz -C game --strip-components=2 restunts-master/stunts && mv game/game.exe game/GAME.EXE
  ```

Then serve this folder with any static web server and open it, for example `python3 -m http.server`, then http://localhost:8000. The page plays the Mindscape release when it has a copy of it (*Game* in the main menu switches).

There is no build step: plain ES modules, with Three.js vendored in `vendor/`. It needs a browser with WebGL.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Accelerate / brake | ↑ / ↓ | RT or A / LT or B |
| Steer | ← / → | Left stick or d-pad |
| Shift up / down (manual gearbox) | A / Z, or Space / Enter | RB / LB |
| Camera: chase, cockpit, TV | C, or F2 / F1 / F3 | |
| Chase camera distance | V | |
| Watch the opponent | T | |
| Dashboard on/off (cockpit) | D | |
| Frame rate display | F | |
| Restart | R | |
| Sound on/off | M | |
| Menu | Esc | |

In replays, Space pauses. The replay bar also sets the speed and seeks.

In the track editor, click to place a piece, right-click or R rotates it, drag paints terrain, and Ctrl+Z undoes.

## Features

- **Cars and opponents:** all 11 cars, with their original specs and paint jobs, and a manual or automatic gearbox. The six opponents drive with the original AI and react with their original win/lose pictures and lines.
- **Tracks:** any `.TRK` file, including community tracks, with their scenery horizons.
- **Race start:** the car rolls out of the transporter truck, as in the original.
- **Cameras:**
  - chase camera
  - cockpit with the car's real dashboard and working needles
  - the original's trackside TV cameras
- **Track editor:** built on the original track checker, so you get the same errors as in the original editor ("pieces do not connect", "jump is too long", ...), and the faulty tile is highlighted. You can test-drive, save, and export a `.TRK`.
- **Replays:** view them with pause, speed and seeking, save and load them as `.RPL` (compatible with the original game and, on the Mindscape release, with playstunts), and keep best times per track. A replay only plays back on the release that recorded it; the page tells them apart and offers to switch.
- **Two releases of the game:** the Mindscape and Broderbund 1.1 releases drive differently (a hard landing wrecks the car in one and not the other, rounding, the opponents' steering, the corkscrew's width, how the roof is checked...), so each has its own replays and best times.
- **playstunts interchange:** replays and tracks go both ways as they are; *Replays & backup* imports and exports playstunts' backup file, with tracks, replays and best times (the original `.HIG` records).
- **Driving options** (main menu). Races driven with either keep their own best times, and their replays record the options, so they play back here but not in the original game.
  - Steering assist (off by default): the original wheel turns slowly, returns slowly, and keeps turning past what the tyres hold, so the car slides and spins. With the assist, the wheel goes straight to the tightest turn the tyres hold at the current speed and centres when you let go. A tap shorter than a simulation tick still counts, and a gamepad stick steers in proportion.
  - Car fragility (a slider): 100% is the original, where touching a tree or clipping a wall at speed wrecks the car. Lower values let it take harder hits: a wall takes the excess speed instead, the car bounces off trees, posts and corners, and lands back on its wheels after a rollover. At 0% nothing wrecks it; water still ends the race.
- **Sound:** a synthesized engine, tyres, scrapes and crashes.
- **Enhanced graphics** (on by default): the original palette's colours under a sun and soft cascaded shadows, light procedural detail on the surfaces, the original's patterned materials as real gratings (the loop, bridge decks, nets, lamps), a sky with clouds and 3D distant scenery, skid marks, smoke, dust and crash fire. Off, it is the plain original look.

## How it works

`GAME.EXE` is loaded into an emulated real-mode memory (`src/mem.js`). Every original global therefore lives at its original address, and the ported code reads and writes it with the same 16-bit semantics. The simulation modules are:

| Module | Contents |
|---|---|
| `math.js` | fixed-point trigonometry and matrices |
| `gamestate.js` | frame update, snapshots, replay recording |
| `track.js` | track validation and path, opponent AI |
| `car.js` | engine, grip, suspension, crashes |
| `player.js` | wheel and terrain integration, penalties |
| `surface.js` | track surface and wall lookup |

To prove the port faithful, a small 8086 interpreter (`src/x86.js`) runs the original code over the same memory. `tools/trace.mjs` runs race scenarios in lockstep: every frame, once with the ports and once with the original, and compares all of memory. Normal play never runs original code. Add `?original` to the URL to play on the original code instead.

The ports were written from the disassembly of the Broderbund release ([restunts](https://github.com/4d-stunts/restunts)). The Mindscape release has no such listing: `tools/vermap.mjs` matches its code against the Broderbund one, instruction by instruction, to find where its functions and globals are and what differs; each difference is a branch in the port, and the same lockstep traces verify the ports against the Mindscape machine code.

The original also has an undocumented behaviour: `update_player_state` reads a few stack variables it never writes, whose value on DOS was effectively random. Here they are defined as zero. This only changes details after a crash.

The two gameplay options (`src/tweaks.js`) are branches in the ports that are only taken when an option is set, so the default game stays the verified original.

### Compatibility with playstunts

playstunts reconstructs the Mindscape release; so does this, checked against that release's machine code rather than against playstunts itself. Where playstunts knowingly leaves the original, this follows it (on the Mindscape release, outside `?original`):

- A stopped car that finds a wheel across a wall is moved clear of it. The original divides by zero there.
- A stopped car's wheels reuse the directions of its last moving tick (the original reads them from stack memory it has not written; this project otherwise defines that memory as zero).

Known remaining differences, all after a crash or in a fault: the suspension of a car wrecked by being wedged between walls starts from zero here and from leftover stack words there; and where the original's divide-overflow handler carries on, this does the same, while playstunts stops the race.

The rendering (`src/render.js`) places the original shapes with the original placement rules, but draws them with a modern renderer rather than the original's painter's algorithm.

## Development

The tools need Node 22 and the game files in `game/`:

```sh
node tools/trace-all.mjs      # every port vs the original, all scenarios (about 1 min)
node tools/profile-orig.mjs   # original code still running with the ports on (should be none)
node tools/test-tweaks.mjs    # steering assist and car fragility
node tools/world.mjs          # play DEFAULT.RPL headless and print a summary
```

They run on the Broderbund release in `game/`. With `STUNTS_VERSION=ms` they run on the Mindscape one in `game-ms/`, and `tools/test-playstunts.mjs` checks what is specific to playstunts:

```sh
STUNTS_VERSION=ms node tools/trace-all.mjs
STUNTS_VERSION=ms node tools/test-playstunts.mjs
node tools/vermap.mjs game-ms --diff update_grip   # what differs in a function between the releases
```

To read the original assembly (`tools/asm.sh <function>`) or regenerate the address tables, clone the reverse-engineering project into `ref/`: `git clone https://github.com/4d-stunts/restunts ref/restunts`. `CLAUDE.md` describes the architecture and the porting rules in detail.

## Credits

- Stunts by Distinctive Software (1990).
- The reverse-engineering work of the [restunts](https://github.com/4d-stunts/restunts) project and the [Stunts community](https://wiki.stunts.hu), without which this port would not have been possible.
- [playstunts](https://github.com/ACatWithEbola/playstunts), whose documented departures from the original and file formats this follows.
