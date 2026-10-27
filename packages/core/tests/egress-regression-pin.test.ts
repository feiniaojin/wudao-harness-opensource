// ω99-46 — the egress regression pin (brief §1.6): no package may install its
// own undici dispatcher or construct a bare proxy agent outside the ONE
// egress module — every outbound path must stay on the shared global seam so
// the routing table (and its attribution) covers the whole process. dsh
// enforces this with an AST gate; at wudao's M size the honest reduction is
// a REGEX pin over src (documented in the arc report), which catches every
// realistic drift shape (setGlobalDispatcher / new ProxyAgent /
// socksDispatcher / EnvHttpProxyAgent).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const REPO_PACKAGES = join(import.meta.dirname, "..", "..", "..", "packages");
const OWNERS = ["core", "providers", "cli", "server", "slack", "web", "evals"] as const;
/** The single file allowed to own dispatcher installation. */
const EGRESS_MODULE = join("core", "src", "net", "egress.ts");

const PATTERNS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "setGlobalDispatcher(", re: /\bsetGlobalDispatcher\s*\(/ },
  { name: "new ProxyAgent(", re: /\bnew\s+(?:undici\.)?ProxyAgent\s*\(/ },
  { name: "socksDispatcher(", re: /\bsocksDispatcher\s*\(/ },
  { name: "EnvHttpProxyAgent(", re: /\bnew\s+(?:undici\.)?EnvHttpProxyAgent\s*\(/ },
];

function listTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listTsFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

it("no dispatcher installation outside packages/core/src/net/egress.ts", () => {
  const offenders: string[] = [];
  for (const pkg of OWNERS) {
    const src = join(REPO_PACKAGES, pkg, "src");
    let files: string[];
    try {
      files = listTsFiles(src);
    } catch {
      continue; // package without src (or not present in this checkout)
    }
    for (const file of files) {
      const rel = join(pkg, "src", file.slice(src.length + 1));
      if (rel === EGRESS_MODULE) continue;
      const text = readFileSync(file, "utf8");
      for (const { name, re } of PATTERNS) {
        if (re.test(text)) offenders.push(`${rel}: ${name}`);
      }
    }
  }
  expect(offenders, `egress seam violations:\n${offenders.join("\n")}`).toEqual([]);
});
