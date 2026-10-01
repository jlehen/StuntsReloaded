# Stunts Reloaded

Stunts (1990, a.k.a. *4D Sports Driving*) in the browser. The driving simulation is the original game's, ported function by function to JavaScript and verified bit-exact against the original machine code. The rendering is new: the original low-poly shapes drawn with Three.js, with lighting, shadows, anti-aliasing, widescreen and a smooth frame rate.

**Play it now: https://jlehen.github.io/StuntsReloaded/**

## Running

You need the data files of Stunts 1.1. They are not included, because they belong to the original publisher.

1. Put the Stunts files (`GAME.EXE`, `GAME1.P3S`, `CAR*.RES`, `ST*.P3S`, `OPP*.PRE`, ...) in `game/`. Alternatively, skip this step: the page then downloads them from the [restunts](https://github.com/4d-stunts/restunts/tree/master/stunts) repository, or, if that fails, asks for your Stunts folder (you can also drop the files onto it) and keeps them in the browser for later visits. To fetch them into `game/` yourself, from this folder:
   ```sh
   mkdir -p game && curl -L https://github.com/4d-stunts/restunts/archive/refs/heads/master.tar.gz | tar xz -C game --strip-components=2 restunts-master/stunts && mv game/game.exe game/GAME.EXE
   ```
2. Serve this folder with any static web server and open it, for example `python3 -m http.server`, then http://localhost:8000.

There is no build step: plain ES modules, with Three.js vendored in `vendor/`. It needs a browser with WebGL.

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Accelerate / brake | ↑ / ↓ | RT or A / LT or B |
| Steer | ← / → | Left stick or d-pad |
| Shift up / down (manual gearbox) | A / Z | RB / LB |
| Camera: chase, cockpit, TV | C | |
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
- **Replays:** view them with pause, speed and seeking, save and load them as `.RPL` (compatible with the original game), and keep best times per track.
- **Driving options** (main menu). Races driven with either keep their own best times, and their replays record the options, so they play back here but not in the original game.
  - Steering assist (off by default): the original wheel turns slowly, returns slowly, and keeps turning past what the tyres hold, so the car slides and spins. With the assist, the wheel goes straight to the tightest turn the tyres hold at the current speed and centres when you let go. A tap shorter than a simulation tick still counts, and a gamepad stick steers in proportion.
  - Car fragility (a slider): 100% is the original, where touching a tree or clipping a wall at speed wrecks the car. Lower values let it take harder hits: a wall takes the excess speed instead, the car bounces off trees, posts and corners, and lands back on its wheels after a rollover. At 0% nothing wrecks it; water still ends the race.
- **Sound:** a synthesized engine, tyres, scrapes and crashes.

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

The original also has an undocumented behaviour: `update_player_state` reads a few stack variables it never writes, whose value on DOS was effectively random. Here they are defined as zero. This only changes details after a crash.

The two gameplay options (`src/tweaks.js`) are branches in the ports that are only taken when an option is set, so the default game stays the verified original.

The rendering (`src/render.js`) places the original shapes with the original placement rules, but draws them with a modern renderer rather than the original's painter's algorithm.

## Development

The tools need Node 22 and the game files in `game/`:

```sh
node tools/trace-all.mjs      # every port vs the original, all scenarios (about 1 min)
node tools/profile-orig.mjs   # original code still running with the ports on (should be none)
node tools/test-tweaks.mjs    # steering assist and car fragility
node tools/world.mjs          # play DEFAULT.RPL headless and print a summary
```

To read the original assembly (`tools/asm.sh <function>`) or regenerate the address tables, clone the reverse-engineering project into `ref/`: `git clone https://github.com/4d-stunts/restunts ref/restunts`. `CLAUDE.md` describes the architecture and the porting rules in detail.

## Credits

- Stunts by Distinctive Software (1990).
- The reverse-engineering work of the [restunts](https://github.com/4d-stunts/restunts) project and the [Stunts community](https://wiki.stunts.hu), without which this port would not have been possible.
