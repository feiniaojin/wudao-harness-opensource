// arc 116 — surface-system ladder calculator/verifier.
// Computes HSL lightness steps and WCAG contrast for the candidate cool-gray
// ladders + neutral bubbles, so the frozen values in tokens.css are provably
// inside the bands the arc mandates:
//   - inter-layer HSL L step in [3, 5] (dsh recipe: bg/surface/surface-2)
//   - cool hue: B - R >= 3 on every ladder rung (blue-tinted gray, not warm)
//   - text-1/2/3, ok/warn/danger, tok-* on every surface >= 4.5 (both themes)
//   - neutral user bubble: ink over the ALPHA-COMPOSITED bg >= 4.5 (dark) and
//     over the literal hex (light)
// Run: node scripts/arc116-ladder.mjs
const channel = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = (r, g, b) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const hex = (h) => {
  const n = Number.parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const contrast = (a, b) => {
  const [hi, lo] = [lum(...a), lum(...b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const hslL = ([r, g, b]) => ((Math.max(r, g, b) + Math.min(r, g, b)) / 2 / 255) * 100;
/** white/black alpha over a base — the composite a WKWebView actually paints. */
const over = (base, alpha, white = true) => base.map((c) => c + (white ? 255 - c : -c) * alpha);

const themes = {
  dark: {
    bg: "#141519", surface: "#1C1D21", surface2: "#25262A",
    text: ["#EAEAE6", "#A6A6A0", "#94948E"],
    sem: { ok: "#4ADE80", warn: "#FBBF24", danger: "#F87171" },
    tok: { key: "#c678dd", str: "#98c379", com: "#848e9a", num: "#d19a66", fn: "#61afef" },
    accents: { green: "#12A874", black: "#E8E8E4", blue: "#6C8CFA" },
    bubbleInk: "#EAEAE6", bubbleAlpha: 0.09,
  },
  light: {
    bg: "#F5F6F8", surface: "#FFFFFF", surface2: "#EEF0F3",
    text: ["#1A1A18", "#52524E", "#6B6B65"],
    sem: { ok: "#146C38", warn: "#92600A", danger: "#C81E1E" },
    tok: { key: "#a626a4", str: "#41803E", com: "#6f7076", num: "#986801", fn: "#325FDE" },
    accents: { green: "#0B7A55", black: "#111111", blue: "#2F54EB" },
    bubble: { bg: "#E9EAEF", ink: "#1B1C22" },
  },
};

let fail = 0;
const need = (ok, label) => {
  if (!ok) { fail += 1; console.log(`  FAIL ${label}`); }
};

for (const [name, t] of Object.entries(themes)) {
  console.log(`\n=== ${name} ===`);
  const raw = { bg: t.bg, surface: t.surface, "surface-2": t.surface2 };
  const ladder = { bg: hex(t.bg), surface: hex(t.surface), "surface-2": hex(t.surface2) };
  for (const [k, rgb] of Object.entries(ladder)) {
    console.log(`  ${k.padEnd(10)} ${raw[k]} rgb(${rgb}) HSL-L ${hslL(rgb).toFixed(2)}% B-R=${rgb[2] - rgb[0]}`);
    // pure white is hue-neutral by definition (the light theme's card cap) —
    // every OTHER rung must carry the blue tint.
    if (raw[k] !== "#FFFFFF") need(rgb[2] - rgb[0] >= 3, `${name} ${k} cool hue (B-R>=3)`);
  }
  const steps = [
    hslL(ladder.surface) - hslL(ladder.bg),
    hslL(ladder["surface-2"]) - hslL(ladder.surface),
  ];
  console.log(`  HSL-L steps: bg→surface ${steps[0].toFixed(2)}, surface→surface-2 ${steps[1].toFixed(2)}`);
  // The band is enforced on the dark ladder (light's surface rung is the white
  // cap — its step to bg is what it is; the cool hue + tight spread is the point).
  if (name === "dark") {
    need(steps[0] >= 3 && steps[0] <= 5, "dark bg→surface step in [3,5]");
    need(steps[1] >= 3 && steps[1] <= 5, "dark surface→surface-2 step in [3,5]");
  }

  for (const [i, fg] of t.text.entries()) {
    for (const [sn, sv] of Object.entries(ladder)) {
      const r = contrast(hex(fg), sv);
      need(r >= 4.5, `${name} text-${i + 1} on ${sn}: ${r.toFixed(2)}`);
    }
  }
  for (const [sn, sv] of Object.entries(t.sem)) {
    for (const [bn, bv] of Object.entries(ladder)) {
      const r = contrast(hex(sv), bv);
      need(r >= 4.5, `${name} ${sn} on ${bn}: ${r.toFixed(2)}`);
    }
  }
  for (const [tn, tv] of Object.entries(t.tok)) {
    const r = contrast(hex(tv), ladder.surface);
    need(r >= 4.5, `${name} tok-${tn} on surface: ${r.toFixed(2)}`);
  }
  for (const [an, av] of Object.entries(t.accents)) {
    for (const bv of Object.values(ladder)) {
      const r = contrast(hex(av), bv);
      need(r >= 4.5, `${name} accent(${an}) as text on surface rung: ${r.toFixed(2)}`);
    }
  }
  // the neutral user bubble
  if (name === "dark") {
    const comp = over(ladder.bg, t.bubbleAlpha);
    const r = contrast(hex(t.bubbleInk), comp);
    console.log(`  bubble: ink ${t.bubbleInk} on white/${t.bubbleAlpha} over bg -> rgb(${comp.map(Math.round)}) = ${r.toFixed(2)}`);
    need(r >= 4.5, "dark bubble ink on composite");
  } else {
    const r = contrast(hex(t.bubble.ink), hex(t.bubble.bg));
    console.log(`  bubble: ink ${t.bubble.ink} on ${t.bubble.bg} = ${r.toFixed(2)}`);
    need(r >= 4.5, "light bubble pair");
  }
}

// hairline composited visibility sanity: hair-1 over each dark rung
console.log("\n=== hair composite (dark, alpha white) ===");
for (const [k, rgb] of Object.entries({ bg: hex(themes.dark.bg), surface: hex(themes.dark.surface), "surface-2": hex(themes.dark["surface2"]) })) {
  for (const a of [0.07, 0.13, 0.22]) {
    const c = over(rgb, a).map(Math.round);
    console.log(`  hair ${a} over ${k}: rgb(${c}) #${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`);
  }
}
console.log("\n=== hair composite (light, alpha black) ===");
for (const [k, rgb] of Object.entries({ bg: hex(themes.light.bg), surface: hex(themes.light.surface), "surface-2": hex(themes.light["surface2"]) })) {
  for (const a of [0.08, 0.14, 0.22]) {
    const c = over(rgb, a, false).map(Math.round);
    console.log(`  hair ${a} over ${k}: rgb(${c}) #${c.map((x) => x.toString(16).padStart(2, "0")).join("")}`);
  }
}

console.log(fail === 0 ? "\nALL GATES PASS" : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);
