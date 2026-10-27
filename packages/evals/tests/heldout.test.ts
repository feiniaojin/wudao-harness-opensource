// 借鉴弧 C2（a reference project C4）— 盲 held-out 的机械面测试：密封清单守卫（真实
// contracts.json 有效 + 坏 fixture 每条规则咬人）、训练面排除、报告剥离、
// 泄漏扫描。sealedAt/fraction 是纪律数据——测试钉「冻结字面量不漂移」。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadContracts,
  validateContracts,
  suitesForChangedFiles,
  refinementSuitesForChangedFiles,
  heldOutSet,
  type ContractsData,
} from "../src/contracts.js";
import {
  heldOutSuites,
  isHeldOutSuite,
  validateHeldOutSeal,
  stripHeldOutReport,
  leakScan,
  main as heldoutMain,
} from "../src/heldout.js";
import { deterministicSuites } from "../src/suites/deterministic.js";

const suiteNames = deterministicSuites.map((s) => s.name);
const real = loadContracts();

describe("shipped held-out seal（真实 contracts.json）", () => {
  it("the seal exists, is non-empty, and every contract invariant holds", () => {
    expect(real.heldout).toBeDefined();
    expect(validateContracts(real, suiteNames)).toEqual([]);
    expect(validateHeldOutSeal(real, suiteNames)).toEqual([]);
  });

  it("the sealed list is frozen data the loaders never re-derive", () => {
    const sealed = heldOutSuites();
    expect(sealed.length).toBe(12);
    expect(sealed).toContain("det-42-m56-pool-cost-evidence");
    expect(isHeldOutSuite("det-42-m56-pool-cost-evidence")).toBe(true);
    expect(isHeldOutSuite("det-01-read-file-answer")).toBe(false);
  });

  it("宪法级红线套件不在盲区（每个弧必须持续面对的门）", () => {
    for (const constitutional of ["det-06-prefix-stability", "det-05-permission-ask", "det-07-resume-integrity"]) {
      expect(heldOutSet(real).has(constitutional), constitutional).toBe(false);
    }
  });
});

describe("each seal rule bites（in-memory bad fixtures）", () => {
  it("dead held-out reference / duplicate / whitelisted conflict / bad fraction / empty seal", () => {
    const dead: ContractsData = { ...real, heldout: { ...real.heldout!, suites: ["det-999-ghost"] } };
    expect(validateContracts(dead, suiteNames).some((v) => v.includes("dead held-out reference") && v.includes("det-999-ghost"))).toBe(true);

    const dup: ContractsData = { ...real, heldout: { ...real.heldout!, suites: ["det-10-verify-gate", "det-10-verify-gate"] } };
    expect(validateContracts(dup, suiteNames).some((v) => v.includes("duplicate held-out"))).toBe(true);

    const both: ContractsData = { ...real, heldout: { ...real.heldout!, suites: ["det-52-cc-plugins"] } };
    expect(validateContracts(both, suiteNames).some((v) => v.includes("also whitelisted unmapped"))).toBe(true);

    const badFraction: ContractsData = { ...real, heldout: { ...real.heldout!, fraction: 3 } };
    expect(validateContracts(badFraction, suiteNames).some((v) => v.includes("fraction"))).toBe(true);

    const empty: ContractsData = { ...real, heldout: { ...real.heldout!, suites: [] } };
    expect(validateHeldOutSeal(empty, suiteNames).some((v) => v.includes("empty"))).toBe(true);
  });

  it("drift detector: a stale seal (share collapsed) must demand a re-seal", () => {
    const stale: ContractsData = { ...real, heldout: { ...real.heldout!, suites: real.heldout!.suites.slice(0, 2) } };
    expect(validateHeldOutSeal(stale, suiteNames).some((v) => v.includes("drifted"))).toBe(true);
  });
});

describe("refinement face — 训练面排除", () => {
  it("loop.ts 的训练面不含任何 held-out 套件；--changed-all 全量面仍含", () => {
    const { training, heldOutExcluded } = refinementSuitesForChangedFiles(["packages/core/src/loop.ts"], real);
    const held = heldOutSet(real);
    for (const s of training) expect(held.has(s), s).toBe(false);
    expect(heldOutExcluded.length).toBeGreaterThan(0);
    // 全量面（CI/验收）不受影响——套件本身的守卫还在
    const full = suitesForChangedFiles(["packages/core/src/loop.ts"], real);
    expect(full.length).toBe(training.length + heldOutExcluded.length);
  });

  it("无 heldout manifest 的旧数据 → 训练面 = 全量面（向后兼容）", () => {
    const legacy: ContractsData = { contracts: real.contracts, unmapped: real.unmapped };
    const { training, heldOutExcluded } = refinementSuitesForChangedFiles(["packages/core/src/loop.ts"], legacy);
    expect(training).toEqual(suitesForChangedFiles(["packages/core/src/loop.ts"], legacy));
    expect(heldOutExcluded).toEqual([]);
  });
});

describe("stripHeldOutReport — 报告剥离（精化安全视图）", () => {
  it("drops held-out rows, fixes the count, stamps the seal; keeps everything else", () => {
    const report = {
      timestamp: "t",
      total: 4,
      passed: 3,
      failed: 1,
      results: [
        { name: "det-01-read-file-answer", status: "pass", errors: [], durationMs: 1, trial: 1 },
        { name: "det-10-verify-gate", status: "fail", errors: ["x"], durationMs: 2, trial: 1 },
        { name: "det-33-m48-loop-safety-net", status: "pass", errors: [], durationMs: 3, trial: 1 },
        { name: "det-55-persona", status: "pass", errors: [], durationMs: 4, trial: 1 },
      ],
    };
    const { report: out, removed } = stripHeldOutReport(report, real);
    expect(removed.sort()).toEqual(["det-10-verify-gate", "det-55-persona"].sort());
    expect(out["total"]).toBe(2);
    expect(out["heldOutSealed"]).toBe(2);
    expect((out["results"] as { name: string }[]).map((r) => r.name)).toEqual(["det-01-read-file-answer", "det-33-m48-loop-safety-net"]);
    expect(out["timestamp"]).toBe("t");
  });

  it("never throws on odd shapes; a report with no held-out rows passes through", () => {
    expect(stripHeldOutReport(null, real).removed).toEqual([]);
    expect(stripHeldOutReport({ results: "not-an-array" }, real).removed).toEqual([]);
    const clean = { total: 1, results: [{ name: "det-01-read-file-answer", status: "pass" }] };
    const { report, removed } = stripHeldOutReport(clean, real);
    expect(removed).toEqual([]);
    expect(report["heldOutSealed"]).toBeUndefined();
  });
});

describe("leakScan + CLI", () => {
  it("leakScan finds held-out suite names in free text and stays silent on clean text", () => {
    expect(leakScan("记忆里写着 det-55-persona 的盲测结论", real)).toEqual(["det-55-persona"]);
    expect(leakScan("det-55-persona 与 det-62-night-porting-5", real).sort()).toEqual(["det-55-persona", "det-62-night-porting-5"].sort());
    expect(leakScan("一份普通的工程笔记 det-01-read-file-answer", real)).toEqual([]);
    expect(leakScan("", real)).toEqual([]);
  });

  it("--scan exits 1 and names the leak; clean text exits 0", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-heldout-cli-"));
    try {
      const dirty = join(dir, "dirty.txt");
      await writeFile(dirty, "refine 输入草稿：det-42-m56-pool-cost-evidence 挂了，建议……", "utf8");
      expect(heldoutMain(["--scan", dirty])).toBe(1);
      const clean = join(dir, "clean.txt");
      await writeFile(clean, "普通内容", "utf8");
      expect(heldoutMain(["--scan", clean])).toBe(0);
      expect(heldoutMain(["--scan", join(dir, "missing.txt")])).toBe(1);
      expect(heldoutMain([])).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("--strip writes the sealed view; --list validates the seal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-heldout-cli2-"));
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    try {
      const inPath = join(dir, "last.json");
      const outPath = join(dir, "refine.json");
      await writeFile(inPath, JSON.stringify({ total: 2, results: [{ name: "det-55-persona", status: "pass" }, { name: "det-01-read-file-answer", status: "pass" }] }), "utf8");
      process.stdout.write = ((chunk: string) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;
      expect(heldoutMain(["--strip", inPath, outPath])).toBe(0);
      const stripped = JSON.parse(await import("node:fs/promises").then((f) => f.readFile(outPath, "utf8")));
      expect(stripped["results"]).toHaveLength(1);
      expect(stripped["heldOutSealed"]).toBe(1);
      expect(heldoutMain(["--list"])).toBe(0);
      expect(writes.some((w) => w.includes("已剥离 1 行"))).toBe(true);
    } finally {
      process.stdout.write = origWrite;
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
