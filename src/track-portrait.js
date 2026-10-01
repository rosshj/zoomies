import * as THREE from "three";
import { uSunViewNode } from "./toon.js";

// An overhead still of the already-built world; no second world or animation loop.
export async function renderTrackPortrait({ renderer, scene, track, canvas, skyMesh, starField, sun }) {
  const points = Array.from({ length: 160 }, (_, i) => track.getPointAt(i / 160));
  const road = new THREE.Box3().setFromPoints(points);
  const center = road.getCenter(new THREE.Vector3());
  const size = road.getSize(new THREE.Vector3());
  const span = Math.max(size.x, size.z, 100);
  scene.updateMatrixWorld(true);
  // Include actual mountain/tunnel/building geometry, not just the ground sampler.
  // Exclude only the sky and stars, which deliberately enclose the entire world.
  let ceiling = road.max.y;
  const box = new THREE.Box3();
  scene.traverseVisible((mesh) => {
    if (!mesh.isMesh || mesh === skyMesh || mesh === starField || mesh.userData.skyDecoration) return;
    if (mesh.isInstancedMesh) {
      if (!mesh.boundingBox) mesh.computeBoundingBox();
      box.copy(mesh.boundingBox).applyMatrix4(mesh.matrixWorld);
    } else {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
    }
    if (Number.isFinite(box.max.y)) ceiling = Math.max(ceiling, box.max.y);
  });
  const camera = new THREE.PerspectiveCamera(48, 1.6, 1, 12000);
  camera.position.set(center.x + span * 0.3, Math.max(ceiling + 60, center.y + span * 0.95), center.z + span * 0.5);
  camera.lookAt(center);
  camera.updateMatrixWorld();
  const target = new THREE.RenderTarget(640, 400, { type: THREE.UnsignedByteType, depthBuffer: true });
  target.texture.colorSpace = THREE.SRGBColorSpace;
  const oldTarget = renderer.getRenderTarget();
  const fog = scene.fog;
  const skyPosition = skyMesh?.position.clone();
  const starPosition = starField?.position.clone();
  const sunView = uSunViewNode.value.clone();
  let pixels;
  try {
    // Distant overview should show the route, rather than the driving-distance fog.
    scene.fog = null;
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
    scene.fog = fog;
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
    canvas.dataset.sceneryCeiling = String(ceiling);
  } finally {
    target.dispose();
  }
}
