import * as THREE from "three";
import { attribute, texture, mix } from "three/tsl";

// Generated once per palette; a white tile lets undecorated pieces share the
// same batch. Patterns are UV paint on the original surface, never decals.
const tiles = { plain: 0, stars: 1, spots: 2, scales: 3, seams: 4, straw: 5, stripe: 6, hem: 7 };
let atlas;
export function accessoryPaint() {
  if (atlas) return atlas;
  const color = 0xffffff;
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d"),
    base = new THREE.Color(color),
    hex = "#" + base.getHexString();
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 512, 256);
  for (const [name, tile] of Object.entries(tiles)) {
    if (name === "plain") continue;
    ctx.save();
    ctx.translate((tile % 4) * 128, Math.floor(tile / 4) * 128);
    ctx.beginPath();
    ctx.rect(0, 0, 128, 128);
    ctx.clip();
    ctx.fillStyle = hex;
    ctx.fillRect(0, 0, 128, 128);
    if (name === "stars") {
      ctx.fillStyle = "#f5cf62";
      for (const [x, y, r] of [
        [24, 35, 11],
        [85, 68, 13],
        [40, 110, 8],
        [111, 17, 7],
        [9, 78, 8],
        [116, 101, 7],
      ]) {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5,
            d = i % 2 ? r * 0.42 : r;
          ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
        }
        ctx.closePath();
        ctx.fill();
      }
    } else if (name === "spots") {
      ctx.fillStyle = "#fff0d4";
      for (const [x, y, r] of [
        [33, 36, 10],
        [92, 29, 11],
        [61, 98, 9],
        [103, 79, 8],
        [23, 76, 10],
        [70, 56, 9],
      ]) {
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 0.78, 0.25, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (name === "scales") {
      ctx.strokeStyle = "#" + base.clone().multiplyScalar(0.7).getHexString();
      ctx.lineWidth = 2;
      for (let row = -1; row < 5; row++)
        for (let col = -1; col < 5; col++) {
          ctx.beginPath();
          ctx.arc(col * 32 + (row % 2) * 16, row * 29, 15, 0, Math.PI);
          ctx.stroke();
        }
    } else if (name === "seams") {
      ctx.strokeStyle = "#" + base.clone().lerp(new THREE.Color(0xffedd1), 0.4).getHexString();
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      for (const x of [4, 64, 124]) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 128);
        ctx.stroke();
      }
    } else if (name === "straw") {
      ctx.strokeStyle = "#" + base.clone().multiplyScalar(0.8).getHexString();
      ctx.lineWidth = 1;
      for (let y = 4; y < 128; y += 12) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(128, y);
        ctx.stroke();
      }
    } else if (name === "hem") {
      ctx.fillStyle = "#f9f1de";
      ctx.fillRect(0, 95, 128, 33);
    } else if (name === "stripe") {
      ctx.fillStyle = "#f9f1de";
      ctx.fillRect(62, 0, 4, 128);
      ctx.fillRect(0, 0, 5, 128);
      ctx.fillRect(123, 0, 5, 128);
    }
    ctx.restore();
  }
  const pixels = ctx.getImageData(0, 0, 512, 256);
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 512; x++) {
      const i = (y * 512 + x) * 4,
        tile = Math.floor(y / 128) * 4 + Math.floor(x / 128);
      const accent = [1, 2, 6, 7].includes(tile);
      // RGB carries neutral shading or fixed ink; alpha chooses pigment vs ink.
      pixels.data[i + 3] = accent ? 255 - Math.min(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]) : 0;
      if (accent && pixels.data[i + 3] > 0) pixels.data[i + 3] = 255;
    }
  const tex = new THREE.DataTexture(pixels.data, 512, 256);
  tex.flipY = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  tex.anisotropy = 2;
  tex.userData.shared = true;
  tex.userData.accessoryPaint = true;
  atlas = tex;
  return tex;
}
export function paintUV(geometry, pattern = "plain") {
  const tile = tiles[pattern],
    uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    // Inset into each tile avoids neighboring colors in mip/filter footprints.
    const u = pattern === "plain" ? 0.5 : THREE.MathUtils.clamp(uv.getX(i), 0, 1);
    const v = pattern === "plain" ? 0.5 : THREE.MathUtils.clamp(uv.getY(i), 0, 1);
    uv.setXY(i, ((tile % 4) * 128 + 3 + u * 122) / 512, 1 - (Math.floor(tile / 4) * 128 + 3 + (1 - v) * 122) / 256);
  }
  return geometry;
}

export function pigment(geometry, color) {
  const c = color?.isColor ? color : new THREE.Color(color);
  const rgb = new Float32Array(geometry.attributes.position.count * 3);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] = c.r;
    rgb[i + 1] = c.g;
    rgb[i + 2] = c.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(rgb, 3));
  return geometry;
}
const materials = new Map();
export function accessoryMaterial(roughness = 0.72, side = THREE.FrontSide) {
  const key = `${roughness}|${side}`;
  if (!materials.has(key)) {
    const m = new THREE.MeshStandardNodeMaterial({ roughness, side });
    const ink = texture(accessoryPaint());
    m.colorNode = mix(attribute("color", "vec3").mul(ink.rgb), ink.rgb, ink.a);
    m.userData.shared = true;
    m.userData.surfacePaint = true;
    materials.set(key, m);
  }
  return materials.get(key);
}
