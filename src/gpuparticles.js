// GPU compute particles (WebGPU): a camera-following field of drifting ambient
// motes — dust/pollen by day, faint sparkles at night — simulated entirely on the
// GPU via a TSL compute shader. The CPU never touches per-particle data: a compute
// pass integrates positions in storage buffers each frame, and the motes render as
// instanced billboarded sprites reading those buffers. This is the "many dynamic
// objects" headroom the WebGPU migration unlocked — thousands of them are cheap.
//
// Compute runs on both the WebGPU backend and the WebGL2 fallback (the renderer
// emulates it), so it works everywhere the game does. Wrapped in try/catch so a
// device that can't run it just skips the motes rather than breaking the race.
import * as THREE from "three";
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
  const COUNT = opts.count ?? 3000;
  const BOX = opts.box ?? 60; // half-extent (x,z) of the box that follows the camera
  const HEIGHT = opts.height ?? 38; // motes live in a 0..HEIGHT band
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
    pos.x.addAssign(vel.x.add(sway).mul(deltaTime));
    pos.y.addAssign(vel.y.mul(deltaTime));
    pos.z.addAssign(vel.z.sub(sway).mul(deltaTime));
    const relX = pos.x.sub(uCam.x).add(BOX).add(BOX * 2000.0).mod(BOX * 2.0).sub(BOX);
    const relZ = pos.z.sub(uCam.z).add(BOX).add(BOX * 2000.0).mod(BOX * 2.0).sub(BOX);
    pos.x.assign(uCam.x.add(relX));
    pos.z.assign(uCam.z.add(relZ));
    pos.y.assign(pos.y.add(HEIGHT * 2000.0).mod(HEIGHT)); // fall + wrap back to the top
  })().compute(COUNT);

  // Render: instanced billboarded sprites reading the position buffer per-instance.
  const mat = new THREE.SpriteNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: true,
  });
  mat.positionNode = positions.toAttribute();
  mat.colorNode = uTint;
  mat.scaleNode = float(opts.size ?? 0.5);
  // Soft round mote (radial alpha falloff over the quad), faded by uOpacity.
  const d = uv().sub(0.5).length();
  mat.opacityNode = smoothstep(0.5, 0.0, d).mul(uOpacity);

  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, COUNT);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.layers.set(0);
  scene.add(mesh);

  console.log(`[zoomies] GPU particles: ${COUNT} compute motes`);

  let visible = true;
  return {
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
