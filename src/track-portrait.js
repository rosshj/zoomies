import * as THREE from "three";
import { featureCameraClamp } from "./features.js";
import { uSunViewNode } from "./toon.js";

// A close roadside still of the existing world, with no extra animation loop.
export async function renderTrackPortrait({
  renderer,
  scene,
  track,
  world,
  canvas,
  skyMesh,
  starField,
  sun,
  anchor = 0,
}) {
  scene.updateMatrixWorld(true);
  const blockers = [];
  scene.traverseVisible((mesh) => {
    if (mesh.isMesh && mesh !== skyMesh && mesh !== starField && !mesh.userData.skyDecoration) blockers.push(mesh);
  });
  const camera = new THREE.PerspectiveCamera(58, 1.6, 0.3, 12000);
  const ray = new THREE.Raycaster();
  let roadHeight = 0;
  let clearView = false;
  // Start near the menu's scenic anchor. Try other sections when a tunnel or
  // steep bend obstructs the view, instead of lifting the camera into the sky.
  for (let i = 0; i < 32; i++) {
    const t = (anchor + i / 32) % 1;
    const point = track.getPointAt(t);
    const look = track.getPointAt((t + 42 / track.length) % 1).clone();
    const nearTunnel = track.features?.runs.some(
      (run) => run.kind === "tunnel" && run.spine.some((p) => Math.hypot(p.x - point.x, p.z - point.z) < 55),
    );
    if (nearTunnel && i < 31) continue;
    roadHeight = Math.max(point.y, world.heightAt(point.x, point.z));
    camera.position.set(point.x, roadHeight + 10, point.z);
    featureCameraClamp(track.features, track, camera.position);
    look.y += 3;
    camera.lookAt(look);
    camera.updateMatrixWorld();
    const direction = look.clone().sub(camera.position);
    ray.set(camera.position, direction.clone().normalize());
    ray.near = 0;
    ray.far = direction.length() - 2;
    if (ray.intersectObjects(blockers, false).length) continue;
    // Check the near field across the image as well as its centre, keeping
    // foreground trees, bridge pieces and tunnel walls away from the lens.
    clearView = true;
    ray.far = 6;
    for (const x of [-0.8, 0, 0.8])
      for (const y of [-0.6, 0, 0.6]) {
        ray.setFromCamera(new THREE.Vector2(x, y), camera);
        if (ray.intersectObjects(blockers, false).length) clearView = false;
      }
    if (clearView) break;
  }
  if (!clearView) throw new Error("No unobstructed roadside view found");
  const target = new THREE.RenderTarget(640, 400, { type: THREE.UnsignedByteType, depthBuffer: true });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const oldTarget = renderer.getRenderTarget();
  const skyPosition = skyMesh?.position.clone();
  const starPosition = starField?.position.clone();
  const sunView = uSunViewNode.value.clone();
  let pixels;
  try {
    skyMesh?.position.copy(camera.position);
    starField?.position.copy(camera.position);
    uSunViewNode.value.copy(sun.position).normalize().negate().transformDirection(camera.matrixWorldInverse);
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    pixels = renderer.readRenderTargetPixelsAsync(target, 0, 0, 640, 400);
  } catch (error) {
    target.dispose();
    throw error;
  } finally {
    renderer.setRenderTarget(oldTarget);
    if (skyPosition) skyMesh.position.copy(skyPosition);
    if (starPosition) starField.position.copy(starPosition);
    uSunViewNode.value.copy(sunView);
  }
  try {
    const data = await pixels;
    const image = new ImageData(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), 640, 400);
    const buffer = document.createElement("canvas");
    buffer.width = 640;
    buffer.height = 400;
    buffer.getContext("2d").putImageData(image, 0, 0);
    const ctx = canvas.getContext("2d");
    ctx.save();
    // WebGL readback starts at the bottom; WebGPU starts at the top.
    if (renderer.backend.isWebGLBackend) {
      ctx.translate(0, 400);
      ctx.scale(1, -1);
    }
    ctx.drawImage(buffer, 0, 0);
    ctx.restore();
    canvas.dataset.ready = "true";
    canvas.dataset.cameraHeight = String(camera.position.y);
    canvas.dataset.roadHeight = String(roadHeight);
    canvas.dataset.clearView = String(clearView);
  } finally {
    target.dispose();
  }
}
