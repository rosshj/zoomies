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
  new ResizeObserver(redraw).observe(canvas);
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
    const bounds = new THREE.Box3().setFromObject(group);
    const target = bounds.getCenter(new THREE.Vector3());
    const direction = new THREE.Vector3(...(subject === "cat" ? [3, 1.6, 9] : [7.5, 5.2, 9.5])).normalize();
    const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
    const up = new THREE.Vector3().crossVectors(direction, right);
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const axis = new THREE.Vector3(0, 1, 0);
    // Frame the envelope of a complete turn about the vertical axis, so the
    // framing holds still while the model is dragged around.
    const fitPoints = [];
    const sweep = (point) => {
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 32) {
        const rotated = point.clone().applyAxisAngle(axis, angle);
        fitPoints.push({ x: rotated.dot(right), y: rotated.dot(up), z: rotated.dot(direction) });
      }
    };
    if (subject === "racer") {
      // Every vertex sweeps a circle of radius r at height y, so the silhouette
      // of the turn depends only on (r, y): bin the vertices by height and keep
      // the widest radius per bin, applied to both bin edges. That is still
      // conservative, but far tighter than rotated bounding-box corners, whose
      // diagonals padded the frame by about a wheel on every side.
      const BINS = 96;
      const span = Math.max(1e-6, bounds.max.y - bounds.min.y);
      const radii = new Float32Array(BINS);
      const vertex = new THREE.Vector3();
      group.traverse((object) => {
        const position = object.isMesh && object.geometry?.attributes.position;
        if (!position) return;
        for (let i = 0; i < position.count; i++) {
          vertex.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
          const bin = Math.min(BINS - 1, Math.max(0, Math.floor(((vertex.y - bounds.min.y) / span) * BINS)));
          radii[bin] = Math.max(radii[bin], Math.hypot(vertex.x - target.x, vertex.z - target.z));
        }
      });
      for (let bin = 0; bin < BINS; bin++) {
        if (!radii[bin]) continue;
        for (const edge of [bin, bin + 1])
          sweep(new THREE.Vector3(radii[bin], bounds.min.y + (edge / BINS) * span - target.y, 0));
      }
    } else
      for (const x of [bounds.min.x, bounds.max.x])
        for (const y of [bounds.min.y, bounds.max.y])
          for (const z of [bounds.min.z, bounds.max.z]) sweep(new THREE.Vector3(x, y, z).sub(target));
    const offset = new THREE.Vector3();
    let renderWidth = 640;
    let renderHeight = 400;
    let fitted = "";
    // The card's label and footer may sit over the canvas; the stylesheet
    // declares how much of the top and bottom they cover, in CSS pixels.
    const inset = (name) => {
      const value = parseFloat(getComputedStyle(canvas).getPropertyValue(name));
      return Number.isFinite(value) && value > 0 ? value : 0;
    };
    const fit = () => {
      // Use the actual preview slot, so landscape is not letterboxed into a square.
      const measured = subject === "racer" && canvas.clientWidth > 0 && canvas.clientHeight > 0;
      const aspect = measured ? Math.max(0.5, Math.min(4, canvas.clientWidth / canvas.clientHeight)) : 1.6;
      // Safe band in NDC y, between the overlays.
      let top = measured ? 1 - (2 * inset("--portrait-inset-top")) / canvas.clientHeight : 1;
      let bottom = measured ? -1 + (2 * inset("--portrait-inset-bottom")) / canvas.clientHeight : -1;
      if (top - bottom < 0.5) ((top = 1), (bottom = -1));
      // Render at the slot's device resolution (within 640–1280 px a side), so a
      // wide card on a retina screen is not a 640 px still blown up.
      const dpr = measured ? Math.min(2, window.devicePixelRatio || 1) : 1;
      renderWidth = measured ? Math.round(Math.min(1280, Math.max(640, canvas.clientWidth * dpr))) : 640;
      if (renderWidth / aspect > 1280) renderWidth = Math.round(1280 * aspect);
      const key = `${renderWidth} ${aspect.toFixed(4)} ${top.toFixed(4)} ${bottom.toFixed(4)}`;
      if (key === fitted) return;
      fitted = key;
      renderHeight = Math.round(renderWidth / aspect);
      canvas.width = renderWidth;
      canvas.height = renderHeight;
      camera.aspect = renderWidth / renderHeight;
      let distance = 0;
      for (const point of fitPoints)
        distance = Math.max(
          distance,
          point.z + Math.max(Math.abs(point.x) / (tanV * camera.aspect), Math.abs(point.y) / tanV),
        );
      if (subject === "racer") {
        // After vertical centering, fit the projected height into the safe band
        // rather than reserving equal space around the world origin. This gives
        // wide previews more scale. 3% stays clear on every side.
        let near = fitPoints.reduce((max, point) => Math.max(max, point.z), -Infinity) + 0.01;
        let far = distance * 1.06;
        for (let step = 0; step < 20; step++) {
          const candidate = (near + far) / 2;
          let low = Infinity,
            high = -Infinity,
            width = 0;
          for (const point of fitPoints) {
            const depth = (candidate - point.z) * tanV;
            low = Math.min(low, point.y / depth);
            high = Math.max(high, point.y / depth);
            width = Math.max(width, Math.abs(point.x) / (depth * camera.aspect));
          }
          if (width <= 0.97 && high - low <= (top - bottom) * 0.97) far = candidate;
          else near = candidate;
        }
        distance = far;
      } else distance *= 1.12;
      offset.copy(direction).multiplyScalar(distance);
      camera.updateProjectionMatrix();
      if (subject === "racer") {
        // Center the projected silhouette of the whole turn in the safe band,
        // rather than its world-space bounding box in the canvas.
        let low = Infinity,
          high = -Infinity;
        for (const point of fitPoints) {
          const y = point.y / ((distance - point.z) * tanV);
          low = Math.min(low, y);
          high = Math.max(high, y);
        }
        camera.projectionMatrix.elements[9] = (low + high) / 2 - (top + bottom) / 2;
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      }
    };
    const rawMaterials = new Set();
    group.traverse((o) => {
      if (o.material)
        for (const material of Array.isArray(o.material) ? o.material : [o.material]) rawMaterials.add(material);
    });
    toonify(group);
    const draw = () => {
      fit();
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
        renderer.setSize(renderWidth, renderHeight);
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

// Turn a retained preview to an absolute yaw (radians) and redraw — the reveal
// card's turntable. A no-op until the canvas has a preview.
export function spinPortrait(canvas, yaw) {
  const preview = previews.get(canvas);
  if (!preview) return;
  const state = bindRotation(canvas);
  state.yaw = yaw;
  if (state.pending) return;
  state.pending = true;
  requestAnimationFrame(() => {
    state.pending = false;
    const result = queue.then(() => previews.get(canvas)?.draw());
    queue = result.catch((error) => console.warn("Preview rotation unavailable", error));
  });
}
