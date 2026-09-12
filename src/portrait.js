// 2D portraits for found cats and karts — a stylised face / side view painted
// on a canvas straight from the genome, so the atlas card, the hatch ceremony,
// the racer grid and the Cat-alog get an instant thumbnail with no 3D render
// (the preset cats have baked jpgs from tools/catalog-shots.mjs; a found cat
// exists only as a seed). Same vocabulary as the 3D cat: fur, markings,
// white bib, mask, eye colour, ears, whiskers, the accessory as a glyph.
import { hexToHsl, hslToHex } from "./genome.js";

const hex = (v) => "#" + (v >>> 0).toString(16).padStart(6, "0");
const ACC_GLYPH = {
  none: "", cap: "🧢", headphones: "🎧", beanie: "🧶", flower: "🌸", fedora: "🎩", sunglasses: "🕶️", bandana: "🔻", collar: "⭕", bow: "🎀",
  party: "🎉", crown: "👑", pirate: "🏴‍☠️", tophat: "🎩", cowboy: "🤠", aviator: "🥽", helmet: "⛑️", chef: "👨‍🍳", wizard: "🧙", viking: "⚔️", scarf: "🧣", charm: "🐟",
};
const EXTRA_GLYPH = { propeller: "🌀", feather: "🪶", googly: "👀", sticker: "⭐", bell: "🔔", antenna: "📡", tinyhat: "🎩", sprout: "🌱" };

export function drawCatPortrait(canvas, g, opts = {}) {
  const S = canvas.width;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, S, S);
  if (opts.bg !== null) {
    // Pastel complement of the fur (like the catalog shots' backdrops).
    const { h, s, l } = hexToHsl(g.fur);
    ctx.fillStyle = s < 0.15 ? (l > 0.6 ? "#6b7fb3" : "#e8d9bf") : hex(hslToHex(h + 0.5, 0.45, 0.78));
    ctx.fillRect(0, 0, S, S);
  }
  const fur = hex(g.fur), mark = hex(g.coat.stripeColor);
  const cx = S * 0.5, cy = S * 0.56, R = S * 0.3 * g.body.face;
  const earS = g.body.ears;
  // Ears.
  for (const sx of [-1, 1]) {
    ctx.fillStyle = g.point > 0.3 ? hex(darken(g.fur, 0.55)) : fur;
    ctx.beginPath();
    const bx = cx + sx * R * 0.62, by = cy - R * 0.55;
    const tipY = by - R * 0.85 * earS * (1 - g.body.fold * 0.45);
    ctx.moveTo(bx - sx * R * 0.34, by + R * 0.1);
    ctx.lineTo(bx + sx * R * (0.18 + g.body.fold * 0.2), tipY);
    ctx.lineTo(bx + sx * R * 0.4, by + R * 0.2);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#ffb3c7";
    ctx.beginPath();
    ctx.moveTo(bx - sx * R * 0.16, by + R * 0.08);
    ctx.lineTo(bx + sx * R * (0.12 + g.body.fold * 0.15), tipY + R * 0.28);
    ctx.lineTo(bx + sx * R * 0.24, by + R * 0.16);
    ctx.closePath(); ctx.fill();
  }
  // Head (a touch wider with fluff).
  const fw = 1 + Math.max(0, g.body.fluff - 0.4) * 0.25;
  ctx.fillStyle = fur;
  ctx.beginPath(); ctx.ellipse(cx, cy, R * 1.05 * fw, R * 0.95, 0, 0, Math.PI * 2); ctx.fill();
  // Markings on the forehead + cheeks.
  ctx.save();
  ctx.beginPath(); ctx.ellipse(cx, cy, R * 1.05 * fw, R * 0.95, 0, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = ctx.strokeStyle = mark;
  ctx.globalAlpha = 0.55 + g.coat.contrast * 0.4;
  ctx.lineCap = "round";
  const t = g.coat.type;
  if (t === "mackerel" || t === "classic") {
    ctx.lineWidth = R * 0.09;
    const n = t === "classic" ? 3 : Math.round(3 + g.coat.density * 3);
    for (let i = 0; i < n; i++) {
      const x = cx + (i - (n - 1) / 2) * R * 0.28;
      ctx.beginPath(); ctx.moveTo(x, cy - R * 0.95); ctx.lineTo(x + (i - (n - 1) / 2) * R * 0.05, cy - R * 0.3 - Math.abs(i - (n - 1) / 2) * R * 0.15); ctx.stroke();
    }
    for (const sx of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(cx + sx * R * 0.95, cy - R * 0.1); ctx.lineTo(cx + sx * R * 0.55, cy + R * 0.05); ctx.stroke();
    }
  } else if (t === "spotted" || t === "rosette") {
    for (let i = 0; i < 7; i++) {
      const a = i * 2.4, rr = R * (0.07 + g.coat.scale * 0.04);
      const x = cx + Math.cos(a) * R * (0.35 + (i % 3) * 0.2), y = cy + Math.sin(a) * R * (0.3 + (i % 2) * 0.25) - R * 0.2;
      ctx.beginPath(); ctx.ellipse(x, y, rr, rr * 1.2, a, 0, Math.PI * 2); ctx.fill();
    }
  } else if (t === "ticked") {
    ctx.globalAlpha *= 0.5;
    for (let i = 0; i < 90; i++) {
      const x = cx + ((i * 37) % 100 - 50) / 50 * R, y = cy - R * 0.9 + ((i * 53) % 100) / 100 * R * 1.4;
      ctx.beginPath(); ctx.arc(x, y, R * 0.02, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (g.tortie > 0.2) {
    const { l } = hexToHsl(g.fur);
    ctx.fillStyle = l > 0.4 ? "#3a2a22" : "#c9742a";
    ctx.globalAlpha = 0.75;
    for (let i = 0; i < 3 + Math.round(g.tortie * 3); i++) {
      const a = i * 1.9;
      ctx.beginPath(); ctx.ellipse(cx + Math.cos(a) * R * 0.6, cy + Math.sin(a) * R * 0.5, R * 0.3, R * 0.22, a, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
  // Colourpoint mask.
  if (g.point > 0.3) {
    ctx.fillStyle = hex(darken(g.fur, 0.55));
    ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.05, R * 0.72, R * 0.5, 0, 0, Math.PI * 2); ctx.fill();
  }
  // White muzzle / bib rising with the white-spotting grade.
  if (g.white >= 2 || g.point > 0.3) {
    ctx.fillStyle = "#fbfbfb";
    const h = 0.25 + Math.min(1, g.white / 10) * 0.55;
    ctx.beginPath(); ctx.ellipse(cx, cy + R * (0.95 - h * 0.5), R * (0.5 + h * 0.45), R * h * 0.75, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  // Eyes.
  const ey = cy - R * 0.08, ex = R * 0.4 * g.body.face;
  for (const sx of [-1, 1]) {
    const col = hex(sx > 0 && g.eyes.odd ? g.eyes.color2 : g.eyes.color);
    ctx.save();
    ctx.translate(cx + sx * ex, ey);
    ctx.rotate(sx * g.body.brow * 0.25);
    ctx.fillStyle = "#fbfbfb"; ctx.beginPath(); ctx.ellipse(0, 0, R * 0.19, R * 0.24, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(0, 0, R * 0.14, R * 0.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#111"; ctx.beginPath(); ctx.ellipse(0, 0, R * 0.05, R * 0.17, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(-R * 0.05, -R * 0.08, R * 0.04, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // Nose + mouth + whiskers.
  ctx.fillStyle = "#ff8fab";
  ctx.beginPath(); ctx.moveTo(cx - R * 0.09, cy + R * 0.28); ctx.lineTo(cx + R * 0.09, cy + R * 0.28); ctx.lineTo(cx, cy + R * 0.38); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "#3a2a2a"; ctx.lineWidth = Math.max(1, R * 0.03); ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(cx, cy + R * 0.38); ctx.lineTo(cx, cy + R * 0.46);
  ctx.moveTo(cx - R * 0.16, cy + R * 0.5); ctx.quadraticCurveTo(cx - R * 0.08, cy + R * 0.58, cx, cy + R * 0.46);
  ctx.moveTo(cx + R * 0.16, cy + R * 0.5); ctx.quadraticCurveTo(cx + R * 0.08, cy + R * 0.58, cx, cy + R * 0.46);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = Math.max(1, R * 0.025);
  const wl = R * 0.75 * g.body.whiskers;
  for (const sx of [-1, 1]) for (const dy of [-0.06, 0.06, 0.18]) {
    ctx.beginPath(); ctx.moveTo(cx + sx * R * 0.3, cy + R * (0.3 + dy)); ctx.lineTo(cx + sx * (R * 0.3 + wl), cy + R * (0.22 + dy * 1.6)); ctx.stroke();
  }
  // Accessory glyph, sized and tilted by the flair.
  const glyph = ACC_GLYPH[g.accessory] || "";
  if (glyph) {
    const neck = ["bandana", "collar", "bow", "scarf", "charm"].includes(g.accessory);
    ctx.save();
    ctx.translate(cx, neck ? cy + R * 0.98 : cy - R * 1.05);
    ctx.rotate(g.flair.tilt * 0.8 + (g.flair.backwards && !neck ? 0.5 : 0));
    ctx.font = `${Math.round(R * 0.62 * (neck ? 0.8 : 1) * g.flair.scale)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(glyph, 0, 0);
    if (g.flair.extra && EXTRA_GLYPH[g.flair.extra]) {
      ctx.font = `${Math.round(R * 0.36)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
      ctx.fillText(EXTRA_GLYPH[g.flair.extra], R * 0.42, -R * 0.3);
    }
    ctx.restore();
  }
  if (g.shiny) {
    ctx.font = `${Math.round(S * 0.14)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText("✨", S * 0.04, S * 0.04);
  }
  return canvas;
}

export function drawKartPortrait(canvas, g, opts = {}) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, W, H);
  if (opts.bg !== null) {
    const { h } = hexToHsl(g.color);
    ctx.fillStyle = hex(hslToHex(h + 0.5, 0.4, 0.8));
    ctx.fillRect(0, 0, W, H);
  }
  const body = hex(g.color), accent = hex(g.accent);
  const cx = W * 0.5, base = H * 0.68, L = W * 0.62 * (0.9 + (g.blend.nose - 1) * 0.5), hgt = H * 0.2;
  const ride = g.blend.ride * H * 0.4;
  // Wheels.
  const wr = H * 0.13 * g.blend.wheel;
  ctx.fillStyle = "#1c1c20";
  for (const wx of [cx - L * 0.36, cx + L * 0.34]) { ctx.beginPath(); ctx.arc(wx, base, wr, 0, Math.PI * 2); ctx.fill(); }
  ctx.fillStyle = "#c7cdd6";
  for (const wx of [cx - L * 0.36, cx + L * 0.34]) { ctx.beginPath(); ctx.arc(wx, base, wr * 0.5, 0, Math.PI * 2); ctx.fill(); }
  // Body: a low wedge with a raised cockpit.
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(cx - L * 0.5, base - ride);
  ctx.lineTo(cx + L * 0.55, base - ride);
  ctx.lineTo(cx + L * 0.5, base - hgt * 0.5 - ride);
  ctx.lineTo(cx + L * 0.1, base - hgt * 0.7 - ride);
  ctx.lineTo(cx - L * 0.1, base - hgt * 1.4 - ride);
  ctx.lineTo(cx - L * 0.35, base - hgt * 1.4 - ride);
  ctx.lineTo(cx - L * 0.5, base - hgt * 0.5 - ride);
  ctx.closePath(); ctx.fill();
  // Wing / fin by style + fin gene.
  const finH = hgt * (0.6 + g.blend.fin * 1.0);
  ctx.fillStyle = [0, 3].includes(g.style) ? body : accent;
  if (g.style === 0) { ctx.fillRect(cx - L * 0.5, base - hgt * 1.3 - finH - ride, L * 0.22, hgt * 0.16); ctx.fillRect(cx - L * 0.42, base - hgt * 1.3 - finH - ride, hgt * 0.12, finH); }
  else if (g.style === 3) { ctx.beginPath(); ctx.moveTo(cx - L * 0.45, base - hgt * 0.6 - ride); ctx.lineTo(cx - L * 0.5, base - hgt * 0.6 - finH - ride); ctx.lineTo(cx - L * 0.3, base - hgt * 0.7 - ride); ctx.closePath(); ctx.fill(); }
  else if (g.style === 2 || g.style === 4) { ctx.strokeStyle = g.style === 4 ? body : "#c7cdd6"; ctx.lineWidth = Math.max(2, H * 0.03); ctx.beginPath(); ctx.arc(cx - L * 0.15, base - hgt * 1.2 - ride, hgt * 0.7, Math.PI, 0); ctx.stroke(); }
  else { ctx.fillRect(cx - L * 0.52, base - hgt * 0.75 - ride, L * 0.14, hgt * 0.12); }
  // Livery hint: a band of the accent along the flank.
  if (g.livery.type !== "none") {
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.85;
    if (g.livery.type === "stripes") for (let i = 0; i < 3; i++) ctx.fillRect(cx - L * 0.1 + i * L * 0.12, base - hgt * 0.5 - ride, L * 0.05, hgt * 0.5);
    else if (g.livery.type === "flames") { ctx.beginPath(); ctx.moveTo(cx + L * 0.55, base - hgt * 0.3 - ride); for (let i = 0; i < 4; i++) { ctx.lineTo(cx + L * (0.4 - i * 0.12), base - hgt * (0.45 - (i % 2) * 0.2) - ride); } ctx.lineTo(cx + L * 0.55, base - hgt * 0.05 - ride); ctx.closePath(); ctx.fill(); }
    else if (g.livery.type === "checker") for (let i = 0; i < 6; i++) for (let j = 0; j < 2; j++) if ((i + j) % 2 === 0) ctx.fillRect(cx - L * 0.1 + i * L * 0.08, base - hgt * (0.5 - j * 0.22) - ride, L * 0.08, hgt * 0.22);
    else if (g.livery.type === "dots" || g.livery.type === "paws") for (let i = 0; i < 5; i++) { ctx.beginPath(); ctx.arc(cx - L * 0.05 + i * L * 0.11, base - hgt * (0.3 + (i % 2) * 0.2) - ride, hgt * 0.1, 0, Math.PI * 2); ctx.fill(); }
    else { ctx.beginPath(); ctx.moveTo(cx - L * 0.05, base - hgt * 0.6 - ride); ctx.lineTo(cx + L * 0.15, base - hgt * 0.35 - ride); ctx.lineTo(cx + L * 0.05, base - hgt * 0.35 - ride); ctx.lineTo(cx + L * 0.3, base - hgt * 0.05 - ride); ctx.lineTo(cx + L * 0.05, base - hgt * 0.28 - ride); ctx.lineTo(cx + L * 0.15, base - hgt * 0.28 - ride); ctx.closePath(); ctx.fill(); }
    ctx.globalAlpha = 1;
  }
  // Number roundel.
  ctx.fillStyle = "#f5f5f5"; ctx.beginPath(); ctx.arc(cx - L * 0.22, base - hgt * 0.55 - ride, hgt * 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#1c1c20"; ctx.font = `bold ${Math.round(hgt * 0.38)}px system-ui, sans-serif`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(g.number), cx - L * 0.22, base - hgt * 0.53 - ride);
  // Ornament on the nose.
  const ORN = { fish: "🐟", bell: "🔔", star: "⭐", antenna: "📡", duck: "🦆", horn: "📯", crown: "👑" };
  if (g.ornament && ORN[g.ornament]) {
    ctx.font = `${Math.round(hgt * 0.7)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.fillText(ORN[g.ornament], cx + L * 0.42, base - hgt * 0.95 - ride);
  }
  if (g.shiny) { ctx.font = `${Math.round(H * 0.16)}px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText("✨", W * 0.04, H * 0.05); }
  return canvas;
}

function darken(hexv, k) {
  const { h, s, l } = hexToHsl(hexv);
  return hslToHex(h, s, l * k);
}

// A data URL for an <img> (the racer grid / summary tiles take image sources).
export function portraitDataURL(genome, size = 160) {
  const c = document.createElement("canvas");
  if (genome.kind === "kart") { c.width = Math.round(size * 1.5); c.height = size; drawKartPortrait(c, genome); }
  else { c.width = c.height = size; drawCatPortrait(c, genome); }
  return c.toDataURL("image/png");
}
