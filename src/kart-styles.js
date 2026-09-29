// Stable style ids: the original five and every saved preset retain their slots.
const race = (name, extra = {}) => ({ name, racing: true, snout: 1.55, wing: "none", tire: 1, ...extra });
export const KART_STYLES = [
  { name: "GP", snout: 1.55, wing: "big", tire: 1 },
  { name: "Roadster", snout: 1.45, wing: "lip", tire: 1.06 },
  { name: "Buggy", snout: 1.3, wing: "none", tire: 1.2, hoop: true },
  { name: "Finned", snout: 1.8, wing: "fin", tire: 0.94 },
  { name: "Cage", snout: 1.35, wing: "none", tire: 1.3, cage: true },
  race("Club Racer", { kind: "club", nose: 0.48, pod: 0.3, rail: true }),
  race("Sprint", { kind: "sprint", nose: 0.92, pod: 0.5 }),
  race("Shifter", { kind: "shifter", nose: 0.65, pod: 0.4, radiator: true }),
  race("Endurance", { kind: "endurance", nose: 1.03, pod: 0.54, guard: true, lamps: true }),
  race("Rental Pro", { kind: "rental", nose: 0.96, pod: 0.5, guard: true, rubber: true }),
  race("Vintage Racer", { kind: "vintage", nose: 0.42, pod: 0.24, rail: true, vintage: true }),
  race("Dirt Oval", { kind: "oval", nose: 1.14, pod: 0.52, oval: true }),
  race("Flat Tracker", { kind: "flat", nose: 0.46, pod: 0.28, rail: true, tread: true, tire: 1.1 }),
  race("Rallycross", {
    kind: "rally",
    nose: 0.86,
    pod: 0.48,
    tread: true,
    tire: 1.1,
    cockpit: true,
    fenders: true,
    lamps: true,
  }),
  race("Crosskart", { kind: "cross", nose: 0.44, pod: 0.25, tread: true, tire: 1.15, cockpit: true, suspension: true }),
  race("Dune Racer", { kind: "dune", nose: 0.6, pod: 0.34, tread: true, tire: 1.15, suspension: true, hoopOnly: true }),
  race("Streamliner", { kind: "stream", nose: 0.64, pod: 0.46, stream: true }),
];
export const KART_LIVERIES = [
  "Team Stripe",
  "Twin Stripe",
  "Chevron",
  "GT Stripe",
  "Heritage",
  "Works",
  "Rally Blocks",
  "Endurance",
];
export function savedKartIndex(config, count) {
  if (config.kartId === "custom" || ((config.v ?? 1) < 3 && config.kart === 10)) return count;
  return Number.isInteger(config.kart) && config.kart >= 0 && config.kart < count + 1 ? config.kart : 0;
}
export const savedKartStyle = (config) => config.customKart?.style;
