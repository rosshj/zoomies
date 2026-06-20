// Generates the PWA / home-screen icons for Zoomies as PNGs, with no external
// image dependencies (uses Node's built-in zlib). Run: node tools/gen-icons.mjs
import zlib from "node:zlib";
import { writeFileSync } from "node:fs";

// ---- tiny PNG encoder (RGBA, 8-bit) ----
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // rows with filter byte 0
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- drawing helpers (normalized 0..1 coords) ----
const mix = (a, b, t) => a + (b - a) * t;
function inEllipse(nx, ny, cx, cy, rx, ry) {
  const dx = (nx - cx) / rx;
  const dy = (ny - cy) / ry;
  return dx * dx + dy * dy <= 1;
}
function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}
function inTri(px, py, t) {
  const d1 = sign(px, py, t[0], t[1], t[2], t[3]);
  const d2 = sign(px, py, t[2], t[3], t[4], t[5]);
  const d3 = sign(px, py, t[4], t[5], t[0], t[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// Returns [r,g,b] for a normalized point (no alpha; icon is opaque).
function sample(nx, ny) {
  // background: vertical gradient (theme navy)
  let r = mix(0x1b, 0x0b, ny);
  let g = mix(0x2a, 0x13, ny);
  let b = mix(0x4a, 0x22, ny);

  const earL = [0.27, 0.42, 0.33, 0.1, 0.47, 0.32];
  const earR = [0.73, 0.42, 0.67, 0.1, 0.53, 0.32];
  const inL = [0.32, 0.4, 0.35, 0.18, 0.43, 0.33];
  const inR = [0.68, 0.4, 0.65, 0.18, 0.57, 0.33];

  const put = (cr, cg, cb) => {
    r = cr;
    g = cg;
    b = cb;
  };

  // ears (behind head)
  if (inTri(nx, ny, earL) || inTri(nx, ny, earR)) put(0xf4, 0xa9, 0x3a);
  // head
  if (inEllipse(nx, ny, 0.5, 0.57, 0.3, 0.29)) put(0xf4, 0xa9, 0x3a);
  // inner ears
  if (inTri(nx, ny, inL) || inTri(nx, ny, inR)) put(0xff, 0x8f, 0xab);
  // chin/muzzle highlight
  if (inEllipse(nx, ny, 0.5, 0.66, 0.16, 0.1)) put(0xff, 0xe7, 0xc7);
  // eyes
  if (inEllipse(nx, ny, 0.4, 0.55, 0.055, 0.08) || inEllipse(nx, ny, 0.6, 0.55, 0.055, 0.08))
    put(0x9c, 0xcc, 0x65);
  // pupils
  if (inEllipse(nx, ny, 0.4, 0.55, 0.02, 0.06) || inEllipse(nx, ny, 0.6, 0.55, 0.02, 0.06))
    put(0x11, 0x11, 0x11);
  // nose
  if (inTri(nx, ny, [0.47, 0.62, 0.53, 0.62, 0.5, 0.67])) put(0xff, 0x6f, 0x9b);

  return [r, g, b];
}

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3; // supersample for smooth edges
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0,
        g = 0,
        bl = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const nx = (x + (sx + 0.5) / SS) / size;
          const ny = (y + (sy + 0.5) / SS) / size;
          const c = sample(nx, ny);
          r += c[0];
          g += c[1];
          bl += c[2];
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(r / n);
      rgba[i + 1] = Math.round(g / n);
      rgba[i + 2] = Math.round(bl / n);
      rgba[i + 3] = 255;
    }
  }
  return encodePNG(size, size, rgba);
}

for (const [name, size] of [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
]) {
  writeFileSync(new URL(`../${name}`, import.meta.url), renderIcon(size));
  console.log("wrote", name, size);
}
