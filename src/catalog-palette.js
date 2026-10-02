// Shared backdrop palette for catalog renders and the live racer card.
const hexToHsl = (hex) => {
  const r = ((hex >> 16) & 255) / 255,
    g = ((hex >> 8) & 255) / 255,
    b = (hex & 255) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) / 6 : max === g ? ((b - r) / d + 2) / 6 : ((r - g) / d + 4) / 6;
  return { h, s, l };
};
const hslToHex = (h, s, l) => {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return "#" + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, "0")).join("");
};
export function contrastBg(hex) {
  const { h, s, l } = hexToHsl(hex);
  if (s < 0.18) return l >= 0.75 ? "#46568a" : l <= 0.35 ? "#f0e0c2" : "#d99a6c"; // white → slate, black → cream, grey → clay
  return hslToHex((h + 0.5) % 1, l > 0.65 ? 0.42 : 0.48, l > 0.65 ? 0.52 : 0.76); // pastel complement; darker behind light assets
}
