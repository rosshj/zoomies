import * as THREE from "three";
import { createCat, createKartModel, disposeGroup } from "./models.js";

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
    scene.add(new THREE.HemisphereLight(0xfff3df, 0x646285, 2.2));
    const sun = new THREE.DirectionalLight(0xffefd4, 3);
    sun.position.set(-4, 8, 5);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(35, 1.6, 0.1, 100);
    camera.position.set(7.5, 5.2, 9.5);
    camera.lookAt(0, 1.05, 0);
    camera.zoom = 1.6;
    camera.updateProjectionMatrix();
    try {
      renderer.render(scene, camera);
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(renderer.domElement, 0, 0, canvas.width, canvas.height);
      canvas.dataset.ready = "true";
    } finally {
      disposeGroup(group);
    }
  };
  const result = queue.then(job);
  queue = result.catch(() => {});
  return result;
}
