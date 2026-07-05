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

// Returns [r,g,b] for the cat mark at a normalized point, or null where no
// shape covers it (so callers can put the cat over any background).
function sampleCat(nx, ny) {
  const earL = [0.27, 0.42, 0.33, 0.1, 0.47, 0.32];
  const earR = [0.73, 0.42, 0.67, 0.1, 0.53, 0.32];
  const inL = [0.32, 0.4, 0.35, 0.18, 0.43, 0.33];
  const inR = [0.68, 0.4, 0.65, 0.18, 0.57, 0.33];

  let c = null;
  const put = (cr, cg, cb) => { c = [cr, cg, cb]; };

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

  return c;
}

// Returns [r,g,b] for a normalized point (no alpha; icon is opaque).
function sample(nx, ny) {
  // background: vertical gradient (theme navy)
  const cat = sampleCat(nx, ny);
  if (cat) return cat;
  return [mix(0x1b, 0x0b, ny), mix(0x2a, 0x13, ny), mix(0x4a, 0x22, ny)];
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

// Native splash (iOS launch screen): the same cat mark, centred on the theme
// navy that capacitor.config.json / index.html use as backgroundColor, so the
// splash blends seamlessly into the app's first frame. @capacitor/assets crops
// the 2732×2732 square per device, so the mark stays inside the centre safe
// zone. Only the badge region is supersampled — the flat background needs none.
function renderSplash(size, badgeFrac = 0.3) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 3;
  const b0 = (0.5 - badgeFrac / 2) * size;
  const b1 = (0.5 + badgeFrac / 2) * size;
  for (let y = 0; y < size; y++) {
    const ny = y / size;
    // Vertical navy gradient centred on the theme colour #0e1320.
    const bg = [mix(0x14, 0x0a, ny), mix(0x1b, 0x0f, ny), mix(0x2c, 0x1a, ny)];
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let r = bg[0], g = bg[1], bl = bg[2];
      if (x >= b0 && x < b1 && y >= b0 && y < b1) {
        let ar = 0, ag = 0, ab = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const bx = (x + (sx + 0.5) / SS - b0) / (b1 - b0);
            const by = (y + (sy + 0.5) / SS - b0) / (b1 - b0);
            const c = sampleCat(bx, by) || bg;
            ar += c[0]; ag += c[1]; ab += c[2];
          }
        }
        const n = SS * SS;
        r = ar / n; g = ag / n; bl = ab / n;
      }
      rgba[i] = Math.round(r);
      rgba[i + 1] = Math.round(g);
      rgba[i + 2] = Math.round(bl);
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

// Native app-store assets → resources/ (consumed by `npx capacitor-assets
// generate --ios --assetPath resources` on the Mac; see IOS_SETUP.md).
import { mkdirSync } from "node:fs";
mkdirSync(new URL("../resources", import.meta.url), { recursive: true });
writeFileSync(new URL("../resources/icon-only.png", import.meta.url), renderIcon(1024));
console.log("wrote resources/icon-only.png 1024");
const splash = renderSplash(2732);
writeFileSync(new URL("../resources/splash.png", import.meta.url), splash);
writeFileSync(new URL("../resources/splash-dark.png", import.meta.url), splash); // game is dark-themed either way
console.log("wrote resources/splash.png + splash-dark.png 2732");
