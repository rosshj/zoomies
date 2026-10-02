// Diff two STYLE_DUMP files written by tools/menu-audit.mjs (STYLE_DUMP=<file>
// npm run menu:gallery). Each capture records, for every element in #stage, its
// DOM path, an FNV hash of its full computed style and its rounded rect, so a
// stylesheet refactor can be checked for ANY visual change across every menu
// surface and viewport the gallery covers, without eyeballing 190 screenshots.
//
//   node tools/menu-style-diff.mjs before.json after.json [--by-rect]
//
// Default: elements are matched by DOM path (a CSS-only change should report
// "captures identical" for every surface). --by-rect: matched by style hash +
// rect as a multiset instead, which ignores pure DOM reordering (markup moved
// in index.html) and still catches anything that rendered differently.
import fs from "node:fs";
const args = process.argv.slice(2);
const byRect = args.includes("--by-rect");
const [a, b] = args.filter((x) => !x.startsWith("--")).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
const key = (c) => `${c.device}/${c.name}`;
const A = new Map(a.map((c) => [key(c), c]));
const B = new Map(b.map((c) => [key(c), c]));
let same = 0,
  diff = 0;
const count = (list) => {
  const m = new Map();
  for (const [p, h, r] of list) {
    const k = byRect ? `${h}|${r}` : p;
    m.set(k, (m.get(k) || []).concat(byRect ? p : `${h}|${r}`));
  }
  return m;
};
for (const [k, ca] of A) {
  const cb = B.get(k);
  if (!cb) {
    console.log(`MISSING in second dump: ${k}`);
    diff++;
    continue;
  }
  const ma = count(ca.elements),
    mb = count(cb.elements);
  const changed = [];
  for (const [p, v] of ma) {
    const w = mb.get(p);
    if (!w) changed.push(`- ${byRect ? v[0] : p}`);
    else if (byRect ? w.length !== v.length : w[0] !== v[0]) changed.push(`~ ${byRect ? v[0] : p}`);
  }
  for (const [p, v] of mb) if (!ma.has(p)) changed.push(`+ ${byRect ? v[0] : p}`);
  if (!changed.length) same++;
  else {
    diff++;
    console.log(`DIFF ${k}: ${changed.length} elements`);
    for (const c of changed.slice(0, 6)) console.log("   " + (c.length > 170 ? "…" + c.slice(-170) : c));
  }
}
for (const k of B.keys())
  if (!A.has(k)) {
    console.log(`MISSING in first dump: ${k}`);
    diff++;
  }
console.log(`captures identical: ${same}, different: ${diff}`);
process.exitCode = diff ? 1 : 0;
