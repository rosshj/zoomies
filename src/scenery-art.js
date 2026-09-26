// Geometry painting runs only while building assets. The landscape grain
// helpers below additionally share one small, precomputed texture.
import * as THREE from 'three';
import { bakeGeometry } from './baked-lighting.js';

export function paintSurface(geo, { low = 0.72, high = 1, faces = 0.08 } = {}) {
  geo.computeBoundingBox();
  const p = geo.attributes.position, n = geo.attributes.normal;
  const min = geo.boundingBox.min.y, range = Math.max(0.001, geo.boundingBox.max.y - min);
  const colors = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const t = (p.getY(i) - min) / range;
    const value = low + (high - low) * t;
    const shade = value * (1 - faces * (1 - Math.max(0, n?.getY(i) || 0)));
    colors.set([shade * 0.97, shade, Math.min(1, shade * (1.06 - t * 0.06))], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

// Same 80 triangles as the old icosphere, with a broad planted base and broken
// geological planes. Coordinate-only deformation keeps duplicate vertices welded.
export function rockGeometry(radius = 1) {
  const g = new THREE.IcosahedronGeometry(radius, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / radius, y = p.getY(i) / radius, z = p.getZ(i) / radius;
    const bulge = 1 + 0.12 * Math.sin(x * 4 + z * 3) * Math.cos(y * 3);
    p.setXYZ(i, x * radius * bulge, Math.max(-0.55, y) * radius, z * radius * (1 + 0.1 * Math.cos(x * 4 - y * 2)));
  }
  g.computeVertexNormals();
  return bakeGeometry(paintSurface(g, { low: 0.64, high: 1, faces: 0.12 }), {radius:.8,strength:.2,ground:null});
}

// Six triangles, like the old triangular prism, but a pointed, arched frond.
// The narrow tip, broad middle and curved span are all in one surface.
export function palmFrond(length) {
  const p = [], colors = [], indices = [];
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const half = [0.07, 0.46, 0.32, 0][i];
    const y = Math.sin(t * Math.PI) * 0.6 - t * t * 1.6;
    p.push(t * length, y, -half, t * length, y, half);
    const v = 0.68 + t * 0.32;
    colors.push(v * 0.93, v, v * 0.9, v, v, v * 0.92);
    if (i < 3) { const j = i * 2; indices.push(j, j + 2, j + 1, j + 1, j + 2, j + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(16), 2));
  g.setIndex(indices); g.computeVertexNormals();
  return g;
}

export function paintSolid(geo, hex) {
  const c = new THREE.Color(hex), values = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < values.length; i += 3) values.set([c.r, c.g, c.b], i);
  geo.setAttribute('color', new THREE.BufferAttribute(values, 3));
  return geo;
}

// Same cylinder topology and colour attribute as the old trunk. A splayed,
// irregular foot and a slight lean replace the perfectly straight fence post.
// The canopy attaches at x=.18; both the viewer and world use this geometry.
export function treeTrunkGeometry() {
  const geo = new THREE.CylinderGeometry(0.4, 0.68, 3, 6);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const t = (y + 1.5) / 3;
    const foot = 1 + (1 - t) * (0.12 + 0.12 * Math.cos(Math.atan2(z, x) * 3));
    p.setXYZ(i, x * foot + 0.18 * t, y, z * foot);
  }
  geo.computeVertexNormals();
  return paintSurface(geo, { low: 0.64, high: 1, faces: 0.1 });
}

// One shared, linear-colour grain tile. Noise is baked once, never evaluated in
// the fragment shader. Mipmaps suppress distant speckle; the small contrast
// preserves the terrain palette and cel lighting. No world RNG is consumed.
let _landscapeGrain = null;
export function landscapeGrainTexture() {
  if (_landscapeGrain) return _landscapeGrain;
  const size = 128, data = new Uint8Array(size * size * 4);
  const hash = (x, y) => {
    let n = Math.imul(x + 71, 374761393) ^ Math.imul(y + 19, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const noise = (x, y, cells) => {
    const px = x / size * cells, py = y / size * cells;
    const ix = Math.floor(px), iy = Math.floor(py);
    let fx = px - ix, fy = py - iy;
    fx *= fx * (3 - 2 * fx); fy *= fy * (3 - 2 * fy);
    const a = hash(ix % cells, iy % cells), b = hash((ix + 1) % cells, iy % cells);
    const c = hash(ix % cells, (iy + 1) % cells), d = hash((ix + 1) % cells, (iy + 1) % cells);
    return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const grain = noise(x, y, 8) * 0.35 + noise(x, y, 32) * 0.45 + noise(x, y, 64) * 0.2;
    const v = Math.round(210 + grain * 45), i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v; data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.name = 'Shared landscape grain';
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true; tex.anisotropy = 4; tex.needsUpdate = true;
  return (_landscapeGrain = tex);
}

// Static oblique world projection: height participates so steep faces retain
// detail. One sample instead of three-way projection; shared ground vertices
// keep tile borders seamless. Call again after placing/conforming a mountain.
export function landscapeGrainUV(geo) {
  const p = geo.attributes.position;
  const uv = geo.attributes.uv || new THREE.BufferAttribute(new Float32Array(p.count * 2), 2);
  for (let i = 0; i < p.count; i++) {
    uv.setXY(i, (p.getX(i) + p.getY(i) * 0.37) / 32, (p.getZ(i) + p.getY(i) * 0.23) / 32);
  }
  geo.setAttribute('uv', uv);
  return geo;
}
