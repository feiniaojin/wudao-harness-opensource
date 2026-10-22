// 借鉴弧 C2（the upstream project C4）— 双门验收裁决报告器的判例矩阵：双门全过、
// 能力回退拒绝（逐套件，聚合掩盖不了）、无效率收益拒绝、坏输入 fail-closed、
// 方向感知（higher-better）、容差内下降的诚实标注、中文人话输出、CLI 退出码。
// 原话锚点：双门 rule out "savings that come from getting less done"。
import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adjudicateDoubleGate,
  formatDoubleGateReport,
  parseGateJson,
  main as doubleGateMain,
  type DoubleGateInput,
} from "../src/double-gate.js";

const PASSING: DoubleGateInput = {
  label: "上下文压缩时机弧",
  capability: { tolerance: 2, suites: [{ name: "det-01", before: 100, after: 100 }, { name: "det-33", before: 98, after: 97 }] },
  efficiency: [
    { metric: "每轮 prompt token", before: 12_000, after: 9_000, unit: "tok" },
    { metric: "p95 延迟", before: 8.1, after: 8.2, unit: "s" },
  ],
};

describe("adjudicateDoubleGate — 判例矩阵", () => {
  it("双门全过：能力容差内 + ≥1 项效率改善 → pass", () => {
    const v = adjudicateDoubleGate(PASSING);
    expect(v.verdict).toBe("pass");
    expect(v.capabilityGate).toBe("pass");
    expect(v.efficiencyGate).toBe("pass");
    // 容差内下降被诚实标注（det-33 100→…98→97 跌 1，容差内）
    expect(v.withinToleranceDrops.length).toBe(1);
  });

  it("门一咬人：单套件跌出容差 → 拒绝（聚合再好也没用）", () => {
    const v = adjudicateDoubleGate({
      ...PASSING,
      capability: {
        tolerance: 2,
        suites: [
          { name: "det-01", before: 100, after: 100 },
          { name: "det-99", before: 100, after: 90 }, // 聚合均值几乎不动，单套件崩 10 分
        ],
      },
    });
    expect(v.verdict).toBe("reject");
    expect(v.capabilityGate).toBe("reject");
    expect(v.reasons.some((r) => r.includes("det-99") && r.includes("超出预先声明的容差"))).toBe(true);
  });

  it("门二咬人：一项效率都没改善 → 拒绝（持平/变差都不算）", () => {
    const v = adjudicateDoubleGate({
      ...PASSING,
      efficiency: [
        { metric: "每轮 token", before: 9_000, after: 9_000 },
        { metric: "p95 延迟", before: 8, after: 9, unit: "s" },
      ],
    });
    expect(v.verdict).toBe("reject");
    expect(v.efficiencyGate).toBe("reject");
    expect(v.reasons.some((r) => r.includes("没有任何一项效率指标实测改善"))).toBe(true);
  });

  it("「少干活省出来的钱」判例：能力掉、token 省 → 拒绝", () => {
    const v = adjudicateDoubleGate({
      label: "激进压缩弧",
      capability: { tolerance: 1, suites: [{ name: "det-11", before: 95, after: 88 }] },
      efficiency: [{ metric: "总 token", before: 100_000, after: 40_000 }],
    });
    expect(v.verdict).toBe("reject");
    expect(v.reasons.some((r) => r.includes("省下来的钱"))).toBe(true);
  });

  it("方向感知：higher-better 指标升=改善，lower-better 升=恶化", () => {
    const v = adjudicateDoubleGate({
      ...PASSING,
      efficiency: [{ metric: "缓存命中率", before: 40, after: 55, betterWhen: "higher", unit: "%" }],
    });
    expect(v.efficiencyGate).toBe("pass");
    const v2 = adjudicateDoubleGate({
      ...PASSING,
      efficiency: [{ metric: "缓存命中率", before: 55, after: 40, betterWhen: "higher", unit: "%" }],
    });
    expect(v2.efficiencyGate).toBe("reject");
  });

  it("fail-closed：无能力面 / 负容差 / 缺一侧分数 → 拒绝不放行", () => {
    expect(adjudicateDoubleGate({ ...PASSING, capability: { tolerance: 2, suites: [] } }).verdict).toBe("reject");
    expect(adjudicateDoubleGate({ ...PASSING, capability: { tolerance: -1, suites: PASSING.capability.suites } }).verdict).toBe("reject");
    expect(adjudicateDoubleGate({ ...PASSING, capability: { tolerance: 2, suites: [{ name: "x", before: Number.NaN, after: 1 }] } }).verdict).toBe("reject");
    expect(adjudicateDoubleGate({ ...PASSING, efficiency: [] }).verdict).toBe("reject");
  });
});

describe("parseGateJson + formatDoubleGateReport", () => {
  it("parses the documented shape; rejects every malformed one", () => {
    const ok = parseGateJson(JSON.stringify(PASSING));
    expect(ok.error).toBeUndefined();
    expect(ok.input!.capability.tolerance).toBe(2);
    for (const bad of [
      "not json",
      "[]",
      "{}",
      JSON.stringify({ label: "x", capability: { tolerance: 1 }, efficiency: [] }),
      JSON.stringify({ label: "x", capability: { tolerance: 1, suites: [{ name: 1, before: 1, after: 1 }] }, efficiency: [] }),
      JSON.stringify({ label: "x", capability: { tolerance: 1, suites: [] }, efficiency: [{ metric: "m", before: 1, after: 1, betterWhen: "sideways" }] }),
    ]) {
      expect(parseGateJson(bad).error, bad).toBeDefined();
    }
  });

  it("中文人话报告包含两门结论与最终裁决", () => {
    const verdict = adjudicateDoubleGate(PASSING);
    const text = formatDoubleGateReport(PASSING, verdict);
    expect(text).toContain("双门验收裁决——上下文压缩时机弧");
    expect(text).toContain("能力门通过");
    expect(text).toContain("效率门通过");
    expect(text).toContain("结论：通过");
    expect(text).toContain("容差内下降");
    const rejectInput: DoubleGateInput = {
      label: "激进压缩弧",
      capability: { tolerance: 1, suites: [{ name: "det-11", before: 95, after: 88 }] },
      efficiency: [{ metric: "总 token", before: 100_000, after: 40_000 }],
    };
    const text2 = formatDoubleGateReport(rejectInput, adjudicateDoubleGate(rejectInput));
    expect(text2).toContain("结论：拒绝");
  });
});

describe("CLI 退出码", () => {
  it("0 = 通过，1 = 拒绝，2 = 输入坏", async () => {
    const dir = await mkdtemp(join(tmpdir(), "wudao-gate-cli-"));
    try {
      const passFile = join(dir, "pass.json");
      await writeFile(passFile, JSON.stringify(PASSING), "utf8");
      const failFile = join(dir, "fail.json");
      await writeFile(failFile, JSON.stringify({ ...PASSING, capability: { tolerance: 1, suites: [{ name: "det-11", before: 95, after: 88 }] } }), "utf8");
      const badFile = join(dir, "bad.json");
      await writeFile(badFile, "{oops", "utf8");
      expect(doubleGateMain(["--input", passFile])).toBe(0);
      expect(doubleGateMain(["--input", failFile])).toBe(1);
      expect(doubleGateMain(["--input", badFile])).toBe(2);
      expect(doubleGateMain([])).toBe(2);
      expect(doubleGateMain(["--input", join(dir, "missing.json")])).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
