import * as THREE from "three";
import { createCat, createKartModel, disposeGroup } from "./models.js";
import { toonify, uSunViewNode, uSunColNode } from "./toon.js";

// A still render on selection changes, not another per-frame scene. It uses the
// same models and mounting position as the race, including custom accessories.
let rendererPromise;
let queue = Promise.resolve();
const revisions = new WeakMap();
export function renderRacerPortrait(canvas, cat, kart) {
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
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    const model = createKartModel(kart.color, { style: kart.style, number: kart.number, livery: kart.livery });
    group.add(model.group);
    const driver = createCat(cat.fur, {
      type: cat.type,
      pattern: cat.pattern,
      accessory: cat.accessory,
      accessoryColor: cat.accessoryColor,
      pose: "kart",
    });
    driver.scale.setScalar(0.62);
    driver.position.set(0, 0.85, -0.35);
    group.add(driver);
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
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    const rawMaterials = new Set();
    group.traverse((o) => {
      if (o.material)
        for (const material of Array.isArray(o.material) ? o.material : [o.material]) rawMaterials.add(material);
    });
    toonify(group);
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
    } finally {
      uSunViewNode.value.copy(sunView);
      uSunColNode.value.copy(sunColor);
      // Converted materials are disposed with the group; also release replaced
      // source materials, while keeping the models' shared material cache alive.
      group.traverse((o) => {
        if (o.material)
          for (const material of Array.isArray(o.material) ? o.material : [o.material]) rawMaterials.delete(material);
      });
      disposeGroup(group);
      for (const material of rawMaterials) if (!material.userData?.shared) material.dispose();
    }
  };
  const result = queue.then(job);
  queue = result.catch(() => {});
  return result;
}
