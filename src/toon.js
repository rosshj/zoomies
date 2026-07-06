// Cel shading: convert lit (standard) materials to banded toon shading.
// This is THE game look — main.js runs toonify(scene) once at boot and again
// over each garage preview, and the asset viewer's "game look" toggle applies
// the very same conversion so what it previews is exactly what ships.
import * as THREE from "three";
import { color as tslColor, float, smoothstep, normalView, positionViewDirection, uniform } from "three/tsl";

function makeToonGradient() {
  // 4 soft bands with a lifted floor and a gentle highlight rolloff — a softer,
  // matte "toy" cel rather than a hard 3-step terminator.
  const steps = new Uint8Array([145, 195, 228, 255]);
  const tex = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
const TOON_GRADIENT = makeToonGradient();
// Sun-driven rim/backlight share two uniform nodes, updated once per frame (by
// updateAtmosphere in the game; by the viewer's frame loop in "game look"):
// the view-space sun-travel direction and the (mood sun colour × glow) tint.
export const uSunViewNode = uniform(new THREE.Vector3(0, 0, 1));
export const uSunColNode = uniform(new THREE.Color(0x000000));
// Cache the toon conversion per source material (WeakMap → auto-freed when the
// source material is GC'd between races). With the merged kart/cat meshes a few
// constant materials (chrome, tyre, dark…) are shared across every racer, so
// caching collapses them to a single toon material / render pipeline instead of
// one per occurrence.
const _toonCache = new WeakMap();
export function toToon(m) {
  if (!m || !m.isMeshStandardMaterial || (m.userData && m.userData.skipToon)) return m;
  // TSL-authored materials (leaf wake pop, water ripples, puddle fresnel, petal
  // fall) carry their behaviour in node graphs that a MeshToonMaterial can't
  // hold — converting one silently strips its vertex/colour animation. (Node
  // materials still pass the isMeshStandardMaterial check above: they copy that
  // flag from the defaults they're initialised with.)
  if (m.isNodeMaterial) return m;
  if (_toonCache.has(m)) return _toonCache.get(m);
  const params = {
    color: m.color ? m.color.clone() : new THREE.Color(0xffffff),
    map: m.map || null,
    gradientMap: TOON_GRADIENT,
    vertexColors: m.vertexColors,
    transparent: m.transparent,
    opacity: m.opacity,
    side: m.side,
    emissive: m.emissive ? m.emissive.clone() : new THREE.Color(0x000000),
    emissiveMap: m.emissiveMap || null,
    emissiveIntensity: m.emissiveIntensity,
    bumpMap: m.bumpMap || null,
    bumpScale: m.bumpScale,
  };
  const ud = m.userData || {};
  // Sun-driven add-ons (foliage backlight, hero rim) are added via emissiveNode,
  // which REPLACES the material's emissive — so only apply them to MATTE materials
  // (black emissive). Materials with a live emissive (brake lights, headlight
  // bulbs, glowing pads) keep stock toon so their dynamic emissiveIntensity works.
  const matte = !params.emissive || params.emissive.getHex() === 0;
  if ((ud.backlight || ud.rim || ud.paint) && matte) {
    const t = new THREE.MeshToonNodeMaterial(params);
    let term = null;
    if (ud.backlight) {
      // glows warm where you look toward the sun through the foliage.
      const backlit = positionViewDirection.negate().dot(uSunViewNode).max(0).pow(3);
      term = uSunColNode.mul(backlit);
    }
    if (ud.rim) {
      // a warm sun rim on the silhouette so the hero pops off the scene.
      const ndv = normalView.dot(positionViewDirection).max(0);
      const rimF = float(1).sub(ndv).pow(2.5).mul(normalView.dot(uSunViewNode.negate()).max(0));
      const rimTerm = uSunColNode.mul(rimF.mul(1.6));
      term = term ? term.add(rimTerm) : rimTerm;
    }
    if (ud.paint) {
      // A soft, banded "toy gloss" highlight on kart paint: a single crisp
      // specular bloom toward the sun. Toon-banded (smoothstep) so it reads as a
      // shaped glint, not a smooth Phong lobe; kept gentle so it never blows out.
      const lightDir = uSunViewNode.negate().normalize();
      const half = lightDir.add(positionViewDirection).normalize();
      const spec = normalView.dot(half).max(0).pow(26);
      const glint = smoothstep(0.32, 0.58, spec);
      // mostly white so the shine reads on any body colour, warmed by the sun
      // tint; kept low so the paint is a soft satin, not glossy.
      const paintTerm = tslColor(0xffffff).mul(0.22).add(uSunColNode.mul(0.6)).mul(glint);
      term = term ? term.add(paintTerm) : paintTerm;
    }
    t.emissiveNode = term;
    // A toon made from a shared source is itself shared across karts (the cache
    // hands the same instance to every user) — carry the flag so teardown code
    // (_disposeGroup) knows not to dispose it out from under the others.
    if (ud.shared) t.userData.shared = true;
    _toonCache.set(m, t);
    return t;
  }
  // Everything else: stock toon (auto-converted to a node material by WebGPU,
  // keeping the gradient banding and any dynamic emissiveIntensity).
  const stock = new THREE.MeshToonMaterial(params);
  if (ud.shared) stock.userData.shared = true;
  _toonCache.set(m, stock);
  return stock;
}
export function toonify(root) {
  root.traverse((o) => {
    if (!o.material) return;
    o.material = Array.isArray(o.material) ? o.material.map(toToon) : toToon(o.material);
  });
}
