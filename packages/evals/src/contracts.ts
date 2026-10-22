// ω99-10 — det suite contract coverage guard + bidirectional reporter.
//
// Problem this file kills: "I changed packages/core/src/loop.ts — which det
// suites are my acceptance face?" used to live only in a human's memory (and
// a milestone-view comment above the 82-count pin). contracts.json is now the
// declarative answer: src region -> det suites, every suite mapped or
// explicitly whitelisted with a reason, and this module enforces the four
// invariants + reports in BOTH directions:
//   implementation -> tests: suitesForChangedFiles(["packages/core/src/loop.ts"])
//   tests -> implementation: domainsForSuite("det-75") -> compaction regions
//
// Pure reads, zero new dependencies (glob matching is a tiny RegExp
// translation), and `pnpm eval` behavior is untouched — this is test-infra.
//
// Runnable directly after `pnpm --filter @wudao/evals build`:
//   node packages/evals/dist/contracts.js --changed <file>...      # 训练面（held-out 排除）
//   node packages/evals/dist/contracts.js --changed-all <file>...  # 全量面（CI/验收）
//   node packages/evals/dist/contracts.js --suite <name>
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

/** One implementation region and the det suites that are its acceptance face. */
export interface SuiteContract {
  /** Exact file, directory (trailing "/"), or narrow glob ("**" crosses "/",
   * "*" stays inside one segment). Package-wide roots are forbidden — see
   * isForbiddenRoot. */
  readonly region: string;
  readonly suites: readonly string[];
  /** Why these suites belong to this region (the JSON is data, not JSONC). */
  readonly note?: string;
}

/** A suite that intentionally guards no implementation region. */
export interface UnmappedSuite {
  readonly suite: string;
  readonly reason: string;
}

/** 借鉴弧 C2（the upstream project C4）— 盲 held-out 密封清单：这些套件的结果永不进入
 *  任何精化输入（Dream/refine/训练面选择）；只在弧的最终盲测验收时运行。
 *  密封 = 冻结字面量（M28 密封清单纪律：先封再算，防事后挑选）；derivation
 *  记录选取规则，重开密封须换 sealedAt 并记档。 */
export interface HeldOutManifest {
  readonly sealedAt: string;
  /** The sealed fraction (informational — the FROZEN list is authoritative). */
  readonly fraction: number;
  readonly derivation?: string;
  readonly suites: readonly string[];
}

export interface ContractsData {
  readonly contracts: readonly SuiteContract[];
  readonly unmapped: readonly UnmappedSuite[];
  readonly heldout?: HeldOutManifest;
}

/** src/ and dist/ both sit one level below the package root, so the same
 * relative URL finds contracts.json before and after the build. */
export function loadContracts(): ContractsData {
  const url = new URL("../contracts.json", import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as ContractsData;
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** `**` matches across separators, `*` within one path segment. */
export function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("**")
    .map((seg) => seg.split("*").map(escapeRegex).join("[^/]*"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

/** Exact file, file inside a directory region, or glob hit. */
export function regionMatches(region: string, file: string): boolean {
  if (region.includes("*")) return globToRegExp(region).test(file);
  const base = region.endsWith("/") ? region.slice(0, -1) : region;
  return file === base || file.startsWith(`${base}/`);
}

function normalizedRegion(region: string): string {
  let r = region.trim();
  if (r.endsWith("/**")) r = r.slice(0, -3);
  while (r.endsWith("/")) r = r.slice(0, -1);
  return r;
}

/** Prohibition: mapping a suite to a whole package (or its whole src/) is the
 * same as mapping nothing — the contract must be narrow enough to tell an
 * implementer WHICH face to run. */
export function isForbiddenRoot(region: string): boolean {
  const r = normalizedRegion(region);
  return r === "packages" || /^packages\/[^/]+$/.test(r) || /^packages\/[^/]+\/src$/.test(r);
}

/** The three invariants + the prohibition, as violation strings. Empty = OK.
 *   1. full coverage — every suite is mapped or whitelisted
 *   2. no dead references — every mentioned suite really exists
 *   3. not both — a suite is never mapped AND whitelisted
 *   4. no forbidden roots — regions stay informative
 * Pure: callers (the guard test) feed constructed bad fixtures to prove each
 * rule actually bites. */
export function validateContracts(data: ContractsData, suiteNames: readonly string[]): string[] {
  const violations: string[] = [];
  const known = new Set(suiteNames);
  const mapped = new Map<string, string>(); // suite -> first region that claims it
  data.contracts.forEach((c, i) => {
    if (typeof c.region !== "string" || c.region.trim() === "") {
      violations.push(`contract[${i}]: missing region`);
    } else if (isForbiddenRoot(c.region)) {
      violations.push(`forbidden root: "${c.region}" (contract[${i}]) — map a file or narrow sub-path, not a package-wide src root`);
    }
    const seen = new Set<string>();
    for (const s of c.suites ?? []) {
      if (!known.has(s)) violations.push(`dead reference: "${s}" (contract[${i}] "${c.region}") is not in deterministicSuites`);
      if (seen.has(s)) violations.push(`duplicate entry: "${s}" listed twice in contract[${i}] "${c.region}"`);
      seen.add(s);
      if (!mapped.has(s)) mapped.set(s, c.region);
    }
  });
  const whitelisted = new Set<string>();
  (data.unmapped ?? []).forEach((u, i) => {
    if (!known.has(u.suite)) violations.push(`dead reference: "${u.suite}" (unmapped[${i}]) is not in deterministicSuites`);
    if (typeof u.reason !== "string" || u.reason.trim() === "") violations.push(`unmapped[${i}] "${u.suite}": a whitelist entry must carry a reason`);
    if (whitelisted.has(u.suite)) violations.push(`duplicate whitelist entry: "${u.suite}"`);
    whitelisted.add(u.suite);
    if (mapped.has(u.suite)) {
      violations.push(`"${u.suite}" is both mapped ("${mapped.get(u.suite)}") and unmapped — pick one`);
    }
  });
  for (const name of suiteNames) {
    if (!mapped.has(name) && !whitelisted.has(name)) {
      violations.push(`"${name}" is not covered by any contract or whitelist entry`);
    }
  }
  // 借鉴弧 C2: the sealed held-out manifest's own invariants (absent
  // heldout → zero new violations, so legacy fixtures stay valid).
  if (data.heldout !== undefined) {
    const seenHeld = new Set<string>();
    for (const s of data.heldout.suites ?? []) {
      if (!known.has(s)) violations.push(`dead held-out reference: "${s}" is not in deterministicSuites`);
      if (seenHeld.has(s)) violations.push(`duplicate held-out entry: "${s}"`);
      seenHeld.add(s);
      if (whitelisted.has(s)) violations.push(`held-out suite "${s}" is also whitelisted unmapped — held-out must be carved from the MAPPED pool`);
    }
    if (typeof data.heldout.fraction !== "number" || !(data.heldout.fraction > 0 && data.heldout.fraction < 1)) {
      violations.push("heldout.fraction must be a number in (0,1)");
    }
    if (typeof data.heldout.sealedAt !== "string" || data.heldout.sealedAt.trim() === "") {
      violations.push("heldout.sealedAt must be a non-empty string");
    }
  }
  return violations;
}

/** Implementation -> tests: the deduped, sorted union of suites whose regions
 * cover any of the changed files. `[]` means "no det face claims these files". */
export function suitesForChangedFiles(files: readonly string[], data: ContractsData = loadContracts()): string[] {
  const out = new Set<string>();
  for (const file of files) {
    for (const c of data.contracts) {
      if (regionMatches(c.region, file)) for (const s of c.suites) out.add(s);
    }
  }
  return [...out].sort();
}

/** 借鉴弧 C2 — the REFINEMENT face: the full face minus the sealed held-out
 *  suites. This is what the improvement loop's face selection (the heartbeat
 *  flow, refine inputs) must consume — held-out results never feed back.
 *  `--changed-all` (suitesForChangedFiles) keeps the FULL face for CI and
 *  the arc's final blind acceptance run. */
export function refinementSuitesForChangedFiles(
  files: readonly string[],
  data: ContractsData = loadContracts(),
): { readonly training: readonly string[]; readonly heldOutExcluded: readonly string[] } {
  const full = suitesForChangedFiles(files, data);
  const held = heldOutSet(data);
  const training = full.filter((s) => !held.has(s));
  const excluded = full.filter((s) => held.has(s));
  return { training: [...training].sort(), heldOutExcluded: [...excluded].sort() };
}

/** The sealed held-out names as a Set (absent manifest → empty set). */
export function heldOutSet(data: ContractsData = loadContracts()): ReadonlySet<string> {
  return new Set(data.heldout?.suites ?? []);
}

/** Tests -> implementation: which regions this suite guards. `[]` for a
 * whitelisted suite (it guards a fixture, not a region) or an unknown name. */
export function domainsForSuite(name: string, data: ContractsData = loadContracts()): string[] {
  return data.contracts.filter((c) => c.suites.includes(name)).map((c) => c.region);
}

function printUsage(): number {
  process.stderr.write("usage: node dist/contracts.js --changed <file>...   # 训练面（held-out 已密封排除）\n       node dist/contracts.js --changed-all <file>... # 全量面（CI/盲测验收用）\n       node dist/contracts.js --suite <name>\n");
  return 1;
}

/** CLI entry: the mechanical outlet the heartbeat flow uses to pick the
 * focused-test face for an arc. 借鉴弧 C2: `--changed` now answers the
 * REFINEMENT face (held-out sealed out — the improvement loop never tunes
 * against the blind set); `--changed-all` keeps the full face for CI and
 * the arc's final acceptance. */
export function main(argv: readonly string[]): number {
  const data = loadContracts();
  if (argv[0] === "--changed" || argv[0] === "--changed-all") {
    const files = argv.slice(1);
    if (files.length === 0) return printUsage();
    if (argv[0] === "--changed-all") {
      const suites = suitesForChangedFiles(files, data);
      for (const s of suites) process.stdout.write(`${s}\n`);
      process.stdout.write(suites.length > 0 ? `(${suites.length} suite(s) for ${files.length} changed file(s))\n` : "(no det suite claims these files)\n");
      return 0;
    }
    const { training, heldOutExcluded } = refinementSuitesForChangedFiles(files, data);
    for (const s of training) process.stdout.write(`${s}\n`);
    process.stdout.write(training.length > 0 ? `(${training.length} 训练面 suite(s) for ${files.length} changed file(s))\n` : "(no det suite claims these files)\n");
    if (heldOutExcluded.length > 0) {
      process.stdout.write(`(${heldOutExcluded.length} held-out 套件已密封排除——盲测面只在弧的最终验收运行，永不进精化输入)\n`);
    }
    return 0;
  }
  if (argv[0] === "--suite") {
    const name = argv[1];
    if (name === undefined) return printUsage();
    const domains = domainsForSuite(name, data);
    if (domains.length === 0) {
      const wl = data.unmapped.find((u) => u.suite === name);
      process.stdout.write(wl ? `unmapped: ${wl.reason}\n` : `unknown suite: ${name}\n`);
      return 0;
    }
    for (const r of domains) process.stdout.write(`${r}\n`);
    return 0;
  }
  return printUsage();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
