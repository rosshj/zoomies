# 🐱 Zoomies — Cat Kart Racing

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
| Jump | **Tap the bottom-right** of the screen |
| Shoot hairball 🐾 | **Tap the top-right** of the screen |

Getting hit by a hairball makes a kart **spin out and stop**. First kart to
finish **3 laps** wins.

Steering reads the phone's gravity/tilt, so hold the device like a steering
wheel and tilt left/right. If centre drifts, tap **"↺ center steering"** at the
bottom of the screen to recalibrate neutral. The karts are kept on the road by
the barriers, so you can't drive off the track.

**On desktop (for testing):** Arrow keys / WASD to drive, `Space` to jump,
`F` to shoot.

## Running it

The game uses ES modules and loads three.js from a CDN, so it must be served
over HTTP (not opened as a `file://`). Any static server works:

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

### Locking to landscape (PWA)

Tilting hard to steer can make the OS rotate the screen. To prevent this:

- **Android (Chrome):** handled automatically — the game enters fullscreen and
  locks orientation to landscape on START.
- **iOS (Safari):** the web orientation-lock API isn't supported in a normal
  tab, so **Add to Home Screen** (Share → Add to Home Screen) and launch from
  the icon. The included `manifest.json` requests fullscreen + landscape, and
  iOS honors this for home-screen apps. The app icon is a 🐱.

If the screen ever does rotate mid-race, the game automatically recalibrates
steering so you're not left fighting a stale neutral.

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
