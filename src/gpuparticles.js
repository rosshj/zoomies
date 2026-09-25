// GPU compute particles (WebGPU): a camera-following field of drifting ambient
// motes — subtle, matte biome dust/pollen — simulated entirely on the
// GPU via a TSL compute shader. The CPU never touches per-particle data: a compute
// pass integrates positions in storage buffers each frame, and the motes render as
// instanced billboarded sprites reading those buffers. This is the "many dynamic
// objects" headroom the WebGPU migration unlocked — thousands of them are cheap.
//
// Compute runs on both the WebGPU backend and the WebGL2 fallback (the renderer
// emulates it), so it works everywhere the game does. Wrapped in try/catch so a
// device that can't run it just skips the motes rather than breaking the race.
import * as THREE from "three";
import { debrisLight, environmentProfile } from "./environment-particles.js";
import { uWindDir, uWindAir } from "./wind.js";
import { instancedArray, instanceIndex, Fn, deltaTime, hash, vec3, float, uniform, uv, color, smoothstep } from "three/tsl";

export async function initGpuParticles(scene, renderer, opts = {}) {
  try {
    return await build(scene, renderer, opts);
  } catch (e) {
    console.warn("[zoomies] GPU particles disabled:", e);
    return null;
  }
}

async function build(scene, renderer, opts) {
  const COUNT = opts.count ?? 240;
  const BOX = opts.box ?? 60; // half-extent (x,z) of the box that follows the camera
  const HEIGHT = opts.height ?? 16; // camera-relative band follows hills
  const tint = new THREE.Color(opts.tint ?? 0xfff0c8);

  const positions = instancedArray(COUNT, "vec3");
  const velocities = instancedArray(COUNT, "vec3");
  const uCam = uniform(new THREE.Vector3());
  const uTint = uniform(tint);
  const uOpacity = uniform(opts.opacity ?? 0.5);

  // Init: scatter through the box with a slow DOWNWARD drift + lateral spread, so
  // the motes gently settle like drifting dust/pollen rather than hanging in place
  // (they read as non-falling snow when they just float — the reported bug).
  const init = Fn(() => {
    const pos = positions.element(instanceIndex);
    const vel = velocities.element(instanceIndex);
    const hx = hash(instanceIndex.mul(7.13));
    const hy = hash(instanceIndex.mul(3.71).add(11.0));
    const hz = hash(instanceIndex.mul(5.27).add(23.0));
    pos.assign(vec3(hx.sub(0.5).mul(BOX * 2), hy.mul(HEIGHT), hz.sub(0.5).mul(BOX * 2)));
    // Slow fall (-0.18 .. -0.5) + a little lateral spread per mote.
    vel.assign(vec3(hx.sub(0.5).mul(0.7), hy.mul(-0.32).sub(0.18), hz.sub(0.5).mul(0.7)));
  })().compute(COUNT);
  await renderer.computeAsync(init);

  // Update: integrate with a gentle position-driven sway (so motes WEAVE as they
  // fall instead of dropping straight like snow), then wrap into a box centred on
  // the camera so the field is always around the player. The big even multiple of
  // the box keeps the mod input positive (TSL mod, like GLSL, misbehaves on negatives).
  const update = Fn(() => {
    const pos = positions.element(instanceIndex);
    const vel = velocities.element(instanceIndex);
    // Swirl: lateral nudge from a slow sine of height — turns straight fall into a
    // lazy weave. Cheap (no time uniform; the changing y drives the phase).
    const sway = pos.y.mul(0.7).sin().mul(0.25);
    pos.x.addAssign(vel.x.add(sway).add(uWindDir.x.mul(uWindAir).mul(.25)).mul(deltaTime));
    pos.y.addAssign(vel.y.mul(deltaTime));
    pos.z.addAssign(vel.z.sub(sway).add(uWindDir.y.mul(uWindAir).mul(.25)).mul(deltaTime));
    const relX = pos.x.sub(uCam.x).add(BOX).add(BOX * 2000.0).mod(BOX * 2.0).sub(BOX);
    const relZ = pos.z.sub(uCam.z).add(BOX).add(BOX * 2000.0).mod(BOX * 2.0).sub(BOX);
    pos.x.assign(uCam.x.add(relX));
    pos.z.assign(uCam.z.add(relZ));
    pos.y.assign(pos.y.sub(uCam.y).add(HEIGHT * 2000.5).mod(HEIGHT).sub(HEIGHT*.5).add(uCam.y));
  })().compute(COUNT);

  // Render: instanced billboarded sprites reading the position buffer per-instance.
  const mat = new THREE.SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    fog: true,
  });
  mat.positionNode = positions.toAttribute();
  mat.colorNode = uTint.mul(debrisLight);
  mat.scaleNode = float(opts.size ?? 0.14);
  // A soft round grain with no square root, glow or near-camera diamonds.
  // Fade before vertical wrap so the reset remains hidden on elevated tracks.
  const d = uv().sub(.5);
  const heightFade=smoothstep(HEIGHT*.35,HEIGHT*.5,positions.toAttribute().y.sub(uCam.y).abs()).oneMinus();
  mat.opacityNode = smoothstep(.025,.24,d.dot(d)).oneMinus().mul(uOpacity).mul(heightFade);

  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, COUNT);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.layers.set(0);
  scene.add(mesh);

  console.log(`[zoomies] GPU particles: ${COUNT} compute motes`);

  let visible = true, biome = null;
  const pale=new THREE.Color(0xe0d8c4);
  return {
    mesh,
    setEnvironment(name) {
      if(name===biome)return;biome=name;
      uTint.value.set(environmentProfile(name).colors[0]).lerp(pale,name==='volcanic'?.15:.65);
    },
    setTint(hex) { uTint.value.set(hex); },
    setOpacity(v) { uOpacity.value = v; },
    // Low quality hides the motes AND skips the per-frame GPU compute step.
    setVisible(v) { visible = v; mesh.visible = v; },
    update(dt, camPos) {
      if (!visible) return;
      if (camPos) uCam.value.copy(camPos);
      renderer.compute(update); // step the simulation on the GPU
    },
  };
}
