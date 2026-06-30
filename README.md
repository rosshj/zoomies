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
finish **3 laps** wins.

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
src/
  main.js         # game loop, state machine, race logic
  scene.js        # renderer, lights, sky, ground
  track.js        # closed Catmull-Rom circuit + lap projection
  models.js       # procedural cat + kart meshes
  kart.js         # arcade kart physics, lap timing, AI driver
  input.js        # accelerometer / slider / tap-zones / keyboard
  hairball.js     # projectiles + collision
  hud.js          # HUD DOM updates
```

### Ideas for later

- More tracks, karts, and cat breeds
- Item boxes / power-ups beyond hairballs
- Drifting + mini-turbo boost
- Online multiplayer
- Loading real GLTF cat/kart models in place of the procedural ones
