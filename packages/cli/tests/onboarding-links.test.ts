// M52 §4 — the onboarding series builds without dead links: every relative
// Markdown link inside docs/onboarding/ (and the README's link INTO it)
// resolves to a file that exists in the repo.
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const onboardingDir = join(repoRoot, "docs", "onboarding");

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}

function relativeLinks(text: string): { href: string; from: string }[] {
  const out: { href: string; from: string }[] = [];
  // Markdown links [label](target); skip http(s) and anchors-only.
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const href = m[1] ?? "";
    if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("#")) continue;
    out.push({ href, from: href });
  }
  return out;
}

describe("onboarding docs build without dead links (M52 §4)", () => {
  it("the series exists with the four recomposed chapters + index", () => {
    const files = markdownFiles(onboardingDir);
    for (const expected of [
      "README.md",
      "01-constants-first.md",
      "02-loop-first.md",
      "03-mechanism-mottos.md",
      "04-reference-comparison.md",
    ]) {
      expect(files, `docs/onboarding/${expected} must exist`).toContain(expected);
    }
  });

  it("every relative link in docs/onboarding resolves", () => {
    const dead: string[] = [];
    for (const file of markdownFiles(onboardingDir)) {
      const full = join(onboardingDir, file);
      for (const { href } of relativeLinks(readFileSync(full, "utf8"))) {
        const target = join(onboardingDir, href);
        if (!existsSync(target)) dead.push(`${file} → ${href}`);
      }
    }
    expect(dead, `dead links: ${dead.join(", ")}`).toEqual([]);
  });

  it("the README links into the series and the link resolves", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const links = relativeLinks(readme).map((l) => l.href);
    expect(links, "README must link docs/onboarding/README.md").toContain("docs/onboarding/README.md");
    expect(existsSync(join(repoRoot, "docs", "onboarding", "README.md"))).toBe(true);
  });

  it("mottos cover the M52 mechanisms (boundary/dual/chain/ctx)", () => {
    const mottos = readFileSync(join(onboardingDir, "03-mechanism-mottos.md"), "utf8");
    for (const needle of ["Never cut at a tool result", "never drop a whole turn", "frozen bytes are never re-summarized", "ctx_inspect"]) {
      expect(mottos.includes(needle), `mottos page must mention: ${needle}`).toBe(true);
    }
  });
});
