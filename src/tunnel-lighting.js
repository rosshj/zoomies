// Tunnel fittings are generated once: two opaque batches and a small halo batch.
// Surface spill lives in the existing RGB buffers, never in runtime point lights.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const STYLES = {
  alpine:   { name: 'ceiling LED strips', color: 0xe3f3ff, body: 0x52606b, length: 3.8, width: .58, spacing: 15, facet: 3, lamps: 1 },
  tundra:   { name: 'sealed twin battens', color: 0xd6eaff, body: 0x697b83, length: 2.7, width: .88, spacing: 14, facet: 2, lamps: 2 },
  desert:   { name: 'sodium tunnel lamps', color: 0xffcc79, body: 0x6b5847, length: 2.4, width: .82, spacing: 17, facet: 2, lamps: 1 },
  mesa:     { name: 'guarded amber bulkheads', color: 0xffdb9e, body: 0x655345, length: 1.65, width: .95, spacing: 13, facet: 2, lamps: 1, guards: 2 },
  volcanic: { name: 'industrial panel lights', color: 0xffb66b, body: 0x45434b, length: 2.6, width: 1.05, spacing: 15, facet: 3, lamps: 3, segmented: true },
};
let haloTexture;
function glowTexture() {
  if (haloTexture) return haloTexture;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,.5)');
  gradient.addColorStop(.35, 'rgba(255,255,255,.18)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 64, 64);
  haloTexture = new THREE.CanvasTexture(canvas);
  haloTexture.colorSpace = THREE.SRGBColorSpace;
  return haloTexture;
}

export function buildTunnelLighting(scene, track, run, t0, t1, profile, tubeGeometry) {
  const style = STYLES[run.biome] || STYLES.desert;
  const N = track.samples, spacing = track.length / N;
  const step = Math.max(1, Math.round(style.spacing / spacing));
  const margin = Math.max(1, Math.ceil((style.length / 2 + 2) / spacing));
  const body = [], lenses = [], halos = [], sources = [];
  const up = new THREE.Vector3(0, 1, 0), color = new THREE.Color(style.color);
  const box = (list, x, y, z, w, h, l, frame) => {
    list.push(new THREE.BoxGeometry(w, h, l).translate(x, y, z).applyMatrix4(frame));
  };
  // Both rows follow the actual faceted ceiling, including curves and grade.
  // The backing plate touches the shell; nothing hangs across the driving line.
  for (let i = t0 + margin; i <= t1 - margin; i += step) {
    const idx = (i % N + N) % N, p = track._pts[idx];
    const side = new THREE.Vector3().crossVectors(track._tans[idx], up).normalize();
    const forward = track._pts[(idx + 1) % N].clone().sub(p).normalize();
    for (const k of [style.facet, profile.length - 2 - style.facet]) {
      const a = profile[k], b = profile[k + 1];
      const across = side.clone().multiplyScalar(a[0] - b[0]).addScaledVector(up, a[1] - b[1]).normalize();
      const normal = new THREE.Vector3().crossVectors(across, forward).normalize();
      const along = new THREE.Vector3().crossVectors(across, normal).normalize();
      const position = p.clone().addScaledVector(side, (a[0] + b[0]) / 2);
      position.y += .2 + (a[1] + b[1]) / 2;
      const frame = new THREE.Matrix4().makeBasis(across, normal, along).setPosition(position);
      const {width: w, length: l} = style;
      box(body, 0, -.06, 0, w + .16, .12, l + .16, frame); // ceiling bracket
      box(body, 0, -.23, 0, w, .30, l, frame); // sealed housing
      for (const end of [-1, 1]) box(body, 0, -.40, end * (l / 2 - .10), w + .05, .14, .2, frame);
      for (let n = 0; n < style.lamps; n++) {
        const x = style.segmented ? 0 : ((n + .5) / style.lamps - .5) * (w - .12);
        const z = style.segmented ? ((n + .5) / style.lamps - .5) * (l - .4) : 0;
        box(lenses, x, -.405, z, style.segmented ? w - .22 : (w - .22) / style.lamps,
          .055, style.segmented ? (l - .55) / style.lamps : l - .40, frame);
      }
      for (let n = 0; n < (style.guards || 0); n++) {
        box(body, 0, -.46, ((n + 1) / (style.guards + 1) - .5) * (l - .4), w, .08, .08, frame);
      }
      halos.push(new THREE.PlaneGeometry(w + 1.6, l + 1.6).rotateX(Math.PI / 2).translate(0, -.51, 0).applyMatrix4(frame));
      sources.push({ position: position.clone().addScaledVector(normal, -.5), normal });
    }
  }
  if (!sources.length) return;
  const addBatch = (parts, material, name) => {
    const geometry = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `tunnel-${name}`;
    mesh.userData.tunnelLighting = { biome: run.biome, style: style.name, fixtures: sources.length };
    // Tiny fixtures do not need shadow passes or scenery LOD.
    scene.add(mesh);
    return mesh;
  };
  addBatch(body, new THREE.MeshStandardMaterial({ color: style.body, roughness: .8 }), 'housings');
  addBatch(lenses, new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(2.2) }), 'lenses');
  addBatch(halos, new THREE.MeshBasicMaterial({ map: glowTexture(), color, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: .45 }), 'halos');

  // A short-range spatial index bounds build cost. Nothing is sampled per frame.
  const reach = 22, cells = new Map();
  for (const source of sources) {
    const cx = Math.floor(source.position.x / reach), cz = Math.floor(source.position.z / reach);
    for (let x = cx - 1; x <= cx + 1; x++) for (let z = cz - 1; z <= cz + 1; z++) {
      const key = `${x}:${z}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(source);
    }
  }
  const point = new THREE.Vector3(), toLight = new THREE.Vector3(), normal = new THREE.Vector3();
  const bakeVertex = (geo, v, doubleSided) => {
    point.fromBufferAttribute(geo.attributes.position, v);
    const nearby = cells.get(`${Math.floor(point.x / reach)}:${Math.floor(point.z / reach)}`);
    if (!nearby) return;
    normal.fromBufferAttribute(geo.attributes.normal, v);
    let light = 0;
    for (const source of nearby) {
      toLight.subVectors(source.position, point);
      const d2 = toLight.lengthSq();
      if (d2 >= reach * reach) continue;
      toLight.normalize();
      const beam = Math.max(0, toLight.dot(source.normal)); // housing blocks outward emission
      const facing = doubleSided ? Math.abs(normal.dot(toLight)) : Math.max(0, normal.dot(toLight));
      const fade = 1 - d2 / (reach * reach);
      light += 150 / (d2 + 18) * beam * facing * fade * fade;
    }
    const gain = Math.min(.85, light), c = geo.attributes.color;
    c.setXYZ(v, Math.min(1, c.getX(v) * (1 + gain * color.r)),
      Math.min(1, c.getY(v) * (1 + gain * color.g)), Math.min(1, c.getZ(v) * (1 + gain * color.b)));
  };
  for (let v = 0; v < tubeGeometry.attributes.position.count; v++) bakeVertex(tubeGeometry, v, true);
  tubeGeometry.attributes.color.needsUpdate = true;
  // Restrict road spill to this span, so a nearby outside road/crossover cannot
  // get lit through the mountain. Include the duplicate seam row on wrapped runs.
  const road = track.roadSurface;
  if (road) {
    for (let i = t0; i <= t1; i++) {
      const row = (i % N + N) % N;
      for (let j = 0; j < road.rowWidth; j++) {
        bakeVertex(road.geometry, row * road.rowWidth + j, true);
        if (row === 0) {
          // End-row normals are one-sided at the lap seam. Copy the baked
          // shared position instead of giving that duplicate a different gain.
          const c = road.geometry.attributes.color;
          c.setXYZ(N * road.rowWidth + j, c.getX(j), c.getY(j), c.getZ(j));
        }
      }
    }
    road.geometry.attributes.color.needsUpdate = true;
  }
}
