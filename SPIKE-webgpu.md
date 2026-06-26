# WebGPU spike — `webgpu-test.html`

This branch (`claude/webgpu-spike`) is a **throwaway experiment**, not a change to
the game. It exists to answer one question before we sink effort into a full port:

> On *your phone*, how many moving lights + dynamic objects can we push under
> **WebGPU** vs the **WebGL** renderer the game uses today?

The motivation is to *add* more dynamic stuff (more headlights, props, particles),
not ration it — WebGPU is the renderer that's better at "lots of lights."

## How to use it

Open `…/webgpu-test.html` on the branch's preview deployment **on your phone**.

- The badge at the top shows which backend actually ran: **WebGPU** or **WebGL2**.
- Big FPS number updates live.
- Buttons pile on **+8 lights** / **+40 objects** (or remove them). Keep adding
  until the FPS drops, on each backend.
- **Switch backend & reload** flips between WebGPU and a forced-WebGL2 run of the
  *exact same scene* (`?backend=webgl`), so it's a fair head-to-head on your device.

Run the same test on both backends, note where each one starts dropping frames,
and that tells us whether a real migration is worth it.

## What this is NOT

It does not port the game's custom shaders (toon, water, god-rays, bloom, etc.) —
those are the heavy lift of a real migration and would all need GLSL→TSL rewrites.
This is just the renderer + stock lit materials, enough to measure the ceiling.

## Notes / caveats

- Uses three r0.171 from a CDN (the game itself stays on r0.161 — untouched).
- If your device/browser lacks WebGPU, the page auto-falls back to WebGL2 and the
  badge will say so.
- Nothing here is wired into the game or the deployed branch.
