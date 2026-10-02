import * as THREE from "three";
import { createCat, createKartModel, disposeGroup } from "./models.js";
import { toonify, uSunViewNode, uSunColNode } from "./toon.js";

// On-demand Three.js previews share one renderer. Retained models can be orbited
// like the asset viewer without adding a continuous menu render loop.
let rendererPromise;
let queue = Promise.resolve();
const revisions = new WeakMap();
const previews = new WeakMap();
const interactions = new WeakMap();
function bindRotation(canvas) {
  if (interactions.has(canvas)) return interactions.get(canvas);
  const state = { yaw: 0, pointer: null, pending: false };
  interactions.set(canvas, state);
  canvas.classList.add("rotatable-preview");
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-description", "Drag horizontally or use left and right arrow keys to rotate the model.");
  const redraw = () => {
    if (state.pending) return;
    state.pending = true;
    requestAnimationFrame(() => {
      state.pending = false;
      const result = queue.then(() => previews.get(canvas)?.draw());
      queue = result.catch((error) => console.warn("Preview rotation unavailable", error));
    });
  };
  canvas.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    state.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => {
    const pointer = state.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x;
    const dy = event.clientY - pointer.y;
    if (!pointer.dragging) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 6) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        state.pointer = null;
        return;
      }
      pointer.dragging = true;
    }
    state.yaw -= dx * 0.006;
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    redraw();
  });
  const end = () => {
    state.pointer = null;
  };
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) canvas.addEventListener(type, end);
  canvas.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    state.yaw = event.key === "Home" ? 0 : state.yaw + (event.key === "ArrowLeft" ? 0.15 : -0.15);
    redraw();
  });
  return state;
}
export function renderRacerPortrait(canvas, cat, kart, subject = "racer") {
  const interaction = bindRotation(canvas);
  const revision = (revisions.get(canvas) || 0) + 1;
  revisions.set(canvas, revision);
  const job = async () => {
    rendererPromise ||= (async () => {
      const renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true, forceWebGL: true });
      renderer.setSize(640, 400);
      renderer.setPixelRatio(1);
      await renderer.init();
      return renderer;
    })();
    const renderer = await rendererPromise;
    if (revisions.get(canvas) !== revision) return;
    previews.get(canvas)?.dispose();
    previews.delete(canvas);
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    if (subject !== "cat") {
      const model = createKartModel(kart.color, { style: kart.style, number: kart.number, livery: kart.livery });
      group.add(model.group);
    }
    if (subject !== "kart") {
      const driver = createCat(cat.fur, {
        type: cat.type,
        pattern: cat.pattern,
        accessory: cat.accessory,
        accessoryColor: cat.accessoryColor,
        pose: subject === "racer" ? "kart" : "sit",
      });
      if (subject === "racer") {
        driver.scale.setScalar(0.62);
        driver.position.set(0, 0.85, -0.35);
      }
      group.add(driver);
    }
    scene.add(group);
    // Match the catalog studio lighting and the game's shared cel materials.
    scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x54493a, 1.1));
    const sun = new THREE.DirectionalLight(0xfff2dd, 2.4);
    sun.position.set(6, 10, 7);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0x9db4e6, 0.7);
    fill.position.set(-7, 4, -6);
    scene.add(fill);
    const camera = new THREE.PerspectiveCamera(35, 1.6, 0.1, 100);
    camera.position.set(7.5, 5.2, 9.5);
    camera.lookAt(0, 1.05, 0);
    camera.zoom = 1.6;
    {
      // Fit the entire standalone model, including tall accessories and wide karts.
      const bounds = new THREE.Box3().setFromObject(group);
      const center = bounds.getCenter(new THREE.Vector3());
      const direction = new THREE.Vector3(...(subject === "cat" ? [3, 1.6, 9] : [7.5, 5.2, 9.5])).normalize();
      const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
      const up = new THREE.Vector3().crossVectors(direction, right);
      const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      let distance = 0;
      const axis = new THREE.Vector3(0, 1, 0);
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) {
            const corner = new THREE.Vector3(x, y, z).sub(center);
            for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 16) {
              const rotated = corner.clone().applyAxisAngle(axis, angle);
              distance = Math.max(
                distance,
                rotated.dot(direction) +
                  Math.max(Math.abs(rotated.dot(right)) / (tanV * camera.aspect), Math.abs(rotated.dot(up)) / tanV),
              );
            }
          }
      camera.zoom = 1;
      camera.position.copy(center).addScaledVector(direction, distance * 1.12);
      camera.lookAt(center);
    }
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const rawMaterials = new Set();
    group.traverse((o) => {
      if (o.material)
        for (const material of Array.isArray(o.material) ? o.material : [o.material]) rawMaterials.add(material);
    });
    toonify(group);
    const target = new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3());
    const offset = camera.position.clone().sub(target);
    const draw = () => {
      camera.position
        .copy(offset)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), interaction.yaw)
        .add(target);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      // The live menu scene shares these uniforms. Borrow them only for this
      // synchronous still render, then restore its lighting before the next frame.
      const sunView = uSunViewNode.value.clone();
      const sunColor = uSunColNode.value.clone();
      try {
        uSunViewNode.value.copy(sun.position).normalize().negate().transformDirection(camera.matrixWorldInverse);
        uSunColNode.value.set(0xffe6b0).multiplyScalar(0.6);
        renderer.render(scene, camera);
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);
        canvas.dataset.ready = "true";
        canvas.dataset.yaw = String(interaction.yaw);
      } finally {
        uSunViewNode.value.copy(sunView);
        uSunColNode.value.copy(sunColor);
      }
    };
    const dispose = () => {
      // Converted materials are disposed with the group; also release replaced
      // source materials, while keeping the models' shared material cache alive.
      group.traverse((o) => {
        if (o.material)
          for (const material of Array.isArray(o.material) ? o.material : [o.material]) rawMaterials.delete(material);
      });
      disposeGroup(group);
      for (const material of rawMaterials) if (!material.userData?.shared) material.dispose();
    };
    previews.set(canvas, { draw, dispose });
    draw();
  };
  const result = queue.then(job);
  queue = result.catch(() => {});
  return result;
}
