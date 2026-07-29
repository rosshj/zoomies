# 🐱 Zoomies GP — Cat Kart Racing

A web-based go-kart racing game built with [three.js](https://threejs.org/),
where cats drive the karts. Steer with your phone's accelerometer, race three
laps, and pelt your rivals with hairballs.

![type: web game](https://img.shields.io/badge/web-three.js-orange)

## Controls

**On a phone (landscape required):**

| Action | Control |
| --- | --- |
| Steer | **Tilt** the phone left / right |
| Accelerate | Hold the **left slider up** |
| Brake | Hold the **left slider down** |
| Reverse | Keep holding **down** once stopped |
| Jump / Drift | **⬆ button** — hop into a corner while turning to drift |
| Shoot hairball 🐾 | **🐾 button** (bottom-right) |
| Boost 💨 | **💨 button** — a turbo cat toot; the meter recharges |

**Drifting:** jump while steering into a corner to start a slide. Hold the
drift to charge a mini-turbo (sparks turn blue → orange → red); straighten out
to release the boost. **Boost** is a recharging meter — about three turbos when
full — so there's always a way to claw back into the race.

Getting hit by a hairball makes a kart **spin out and stop**. First kart to
finish **3 laps** wins. Furballs are **locked for the first 15 seconds** of a
race (a countdown shows while they charge), so the start is decided by driving
and making a gap — not an instant hairball brawl off the line.

**Power-up boxes** are crates that **float** along the racing line (the ones
sitting on the ground just tumble when you hit them — only the floating ones hold
anything). Drive through one for a power-up:

- 🛡️ **Shield** — a 15-second bubble that blocks hairballs, no button to hold.
- 🐾 **Tri-furball** — your next three shots fan into a wide three-way blast.
- 🌿 **Catnip boost** — a hands-free speed surge with a little extra rush (wider
  FOV, a faint rumble, and a thick dust/skid trail).

The roll is **position-weighted** to keep races tight: the leader mostly draws a
defensive shield, while karts further back are more likely to get the catnip
(catch-up speed) or tri-furball (offence). A grabbed box sinks back into an
ordinary crate, and a roadside crate **rises to replace it**, so the pool stays
steady without anything popping in from nowhere.

Steering reads the phone's gravity/tilt, so hold the device like a steering
wheel and tilt left/right. If centre drifts, tap **"↺ center steering"** at the
bottom of the screen to recalibrate neutral. The karts are kept on the road by
the barriers, so you can't drive off the track.

**On desktop (for testing):** Arrow keys / WASD to drive, `Space` to jump,
`F` to shoot.

## Running it

The game uses ES modules (three.js is vendored locally under `vendor/three/`,
so it works fully offline), so it must be served over HTTP (not opened as a
`file://`). Any static server works:

```bash
npm start          # serves on http://localhost:8080
# or
npx serve .
# or
python3 -m http.server 8080
```

Then open the URL on your computer, or — to use the accelerometer — on your
**phone**. Note that the DeviceOrientation API requires **HTTPS** on most
mobile browsers, so for phone testing use a tunneling tool (e.g. `ngrok`,
`cloudflared`) or deploy to any static host (GitHub Pages, Netlify, Vercel).

On the first tap of **START RACE**, iOS will ask permission to use motion
data — accept it, and hold the phone level to set the neutral steering point.

### Staying in landscape

Tilting hard to steer is the same motion the OS uses to decide orientation, and
iOS gives web pages no reliable way to lock it. So instead of fighting it, the
game **counter-rotates its own UI**: whatever orientation the OS picks, the game
re-rotates so it always *appears* in landscape, and steering stays continuous
through the change (the tilt reading is in the device frame, and the neutral
isn't reset on rotation).

In addition:

- **Android (Chrome):** also enters fullscreen and requests a real
  orientation lock on START.
- **iOS (Safari):** for the most immersive (full-screen, no Safari chrome)
  experience, **Add to Home Screen** and launch from the 🐱 icon.

## How it's built

Everything is procedural — no asset downloads required.

```
index.html        # markup, HUD, import map for three.js
styles.css        # HUD, slider, overlays
sw.js             # service worker (offline PWA shell cache)
src/
  main.js         # game loop, state machine, race logic, menus, multiplayer glue
  scene.js        # renderer, lights, sky, post-processing
  scenery.js      # procedural world: biomes, buildings, foliage, landmarks
  track.js        # closed Catmull-Rom circuit + lap projection
  models.js       # procedural cat + kart meshes, accessories, shared materials
  kart.js         # arcade kart physics, lap timing, AI driver
  remotekart.js   # render-only multiplayer ghost (interpolated puppet)
  input.js        # accelerometer / slider / tap-zones / keyboard
  hairball.js     # projectiles + collision
  hud.js          # HUD DOM updates
  effects.js      # instanced particles (boost, sparks, dust) + skid marks
  gpuparticles.js # GPU compute confetti (High quality tier)
  props.js        # item boxes + power-up pickups
  weather.js      # rain/snow particle overlays
  audio.js        # WebAudio synth SFX + engine loop
  gpu.js          # WebGPU/WebGL2 backend selection (?webgl=1 override)
  crashguard.js   # WebGPU device-loss watchdog + reload recovery
  rng.js          # seeded RNG for reproducible worlds
  net/            # multiplayer: transport facade, Ably relay, WebRTC P2P,
                  # interpolation, shared clock (see NETWORKING.md)
```

### Is a track playable? (`npm run check:tracks`)

Most of the checks assert that a **feature** works — the game boots, the HUD
ticks, the item roll is fairly weighted. `tools/track-audit.mjs` asks a
different question: **is this track playable at all?** It races a full AI field
and counts the things that are broken no matter what the track was going for:

| Signal | What it means |
| --- | --- |
| **wedged** | a kart that wants to drive forward and covers no ground — caught on a barrier, a feature wall, a prop |
| **grind** | share of race time spent scraping barriers; effectively a corner-quality score, since a spike is a bend the AI can't take cleanly |
| **stalled** | a kart whose lap progress stops advancing — it can't get round |
| **offroad** | a kart outside the barriers (containment clamp failing) |
| **pace** | the field's mean speed; well under top speed means they're fighting the geometry all the way round |
| **air / NaN** | absurd hang time off a crest, or non-finite kart state |

None of these need a judgement about whether a track is *fun*, so they can gate
CI. That matters most for the **procedural generator**: custom tracks come from
a seed plus a handful of knobs, and nobody has driven the overwhelming majority
of what it can produce. Sweeping seeds and gating on pathologies turns "the
generator is probably fine" into something measured.

```bash
npm run check:tracks           # the shipped featured tracks
npm run check:tracks:random    # 6 random generator recipes
TRACKS=extreme SEEDS=5 node tools/track-audit.mjs    # every slider maxed
TRACKS="Whisker Canyon" node tools/track-audit.mjs   # re-run one failure
```

There are three outcomes, kept deliberately distinct: **pass**, **fail** (a
pathology was found), and **inconclusive** (the run hit its wall-clock budget
before gathering enough racing to judge). Only a real failure sets the exit
code — a harness that reports its own slowness as a broken track trains you to
ignore red. Maxed-out recipes are the biggest thing the generator makes and
need a bigger budget: raise it with `WALLCAP=900`.

Timings are in **simulated race seconds**, not wall-clock: under the headless
software renderer the sim runs several times slower than real time, so
wall-clock thresholds would flag a healthy kart as wedged just because the
renderer is slow. Budget roughly three wall minutes per track at the default
30s.

It measures the **absence of bad, not the presence of good** — a track can pass
every gate here and still be dull.

### Ideas for later

- More tracks and biomes
- Loading real GLTF cat/kart models in place of the procedural ones
- Item/hazard variety beyond the current three power-ups
