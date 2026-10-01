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
  camera.layers.enable(1); // flora, fauna and roadside dressing, like the menu camera
  camera.layers.enable(2); // ground cover
  const ray = new THREE.Raycaster();
  ray.layers.mask = camera.layers.mask;
  const foliage = [];
  const matrix = new THREE.Matrix4();
  for (const mesh of blockers) {
    if (!mesh.userData.canopyShape || !mesh.isInstancedMesh) continue;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      foliage.push(new THREE.Vector3().setFromMatrixPosition(matrix).applyMatrix4(mesh.matrixWorld));
    }
  }
  // Prefer planted sections of the real track over a bare straight. Sparse
  // biomes still use their own scenery rather than adding unrelated vegetation.
  const candidates = Array.from({ length: 32 }, (_, i) => {
    const t = (anchor + i / 32) % 1;
    const point = track.getPointAt(t).clone();
    const score = foliage.reduce((n, p) => n + Math.max(0, 1 - Math.hypot(p.x - point.x, p.z - point.z) / 110), 0);
    return { t, point, score: score - i * 0.001 };
  }).sort((a, b) => b.score - a.score);
  let roadHeight = 0;
  let clearView = false;
  // Try both verges at scenic sections; keep the road running diagonally
  // through the frame rather than placing the camera on the racing line.
  for (let i = 0; i < candidates.length * 2; i++) {
    const { t, point } = candidates[Math.floor(i / 2)];
    const look = track.getPointAt((t + 24 / track.length) % 1).clone();
    const nearTunnel = track.features?.runs.some(
      (run) => run.kind === "tunnel" && run.spine.some((p) => Math.hypot(p.x - point.x, p.z - point.z) < 55),
    );
    if (nearTunnel) continue;
    const tangent = track.curve.getTangentAt(t);
    const side = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
    camera.position.copy(point).addScaledVector(side, (track.halfWidth + 8) * (i % 2 ? -1 : 1));
    roadHeight = Math.max(point.y, world.heightAt(camera.position.x, camera.position.z));
    if (roadHeight > point.y + 12) continue; // avoid perching on a steep hillside
    camera.position.y = roadHeight + 12;
    featureCameraClamp(track.features, track, camera.position);
    look.y += 9; // leave room for the trees and skyline above the road
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
    canvas.dataset.sceneryLayers = String(camera.layers.mask);
    canvas.dataset.roadOffset = String(track.halfWidth + 8);
  } finally {
    target.dispose();
  }
}
