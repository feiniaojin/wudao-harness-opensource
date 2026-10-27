// 永续 v6 wave2（reef C1）——配对回放门的聚焦测试。全局层隔离沿
// setup-global-home.ts（真 ~/.wudao 的规则绝不渗进门的基线）；配对回放在
// tmpdir 里跑真 loadContextRules/buildSystemPrompt（零网络）；骨干套件用
// stub（真 5 套件的门禁冒烟在 gate-cli 的实跑里，不在单测里烧 4 秒）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderRuleFile,
  selectGateSuites,
  pairedRulesReplay,
  runImprovementGate,
  GATE_SUITE_NAMES,
  type ImprovementGateInput,
} from "../src/improvement-gate.js";
import { deterministicSuites } from "../src/suites/deterministic.js";
import type { EvalDefinition } from "../src/runner.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "wudao-gate-test-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function def(name: string, errors: string[] = []): EvalDefinition<unknown, unknown> {
  return {
    name,
    kind: "deterministic",
    setup: async () => ({}),
    run: async () => ({}),
    assertions: () => errors,
  };
}

const STABLE_INPUT: ImprovementGateInput = {
  proposalId: "p1-a1b2c3d4",
  ruleFileName: "auto-p1-a1b2c3d4.md",
  ruleText: "运行 npm test 前先确认产物已构建；缺则先构建再跑测试，不要改测试本身。",
};

const GATED_INPUT: ImprovementGateInput = {
  proposalId: "p2-b1b2c3d4",
  ruleFileName: "auto-p2-b1b2c3d4.md",
  ruleText: "改动 rust 文件前先读目标引擎的兼容矩阵，禁止采用未探明引擎支持的新语法。",
  paths: ["**/*.rs", "src-tauri/**"],
};

describe("improvement-gate — 渲染与选套件", () => {
  it("renderRuleFile 字节钉（与 cli 侧 renderRuleFileForActivation 同字面量——drift-pin）", () => {
    expect(renderRuleFile(STABLE_INPUT)).toBe("运行 npm test 前先确认产物已构建；缺则先构建再跑测试，不要改测试本身。\n");
    expect(renderRuleFile(GATED_INPUT)).toBe("---\npaths:\n- **/*.rs\n- src-tauri/**\n---\n\n改动 rust 文件前先读目标引擎的兼容矩阵，禁止采用未探明引擎支持的新语法。\n");
  });

  it("骨干套件选择：名册内全中；未知名 fail-closed", () => {
    const picked = selectGateSuites(GATE_SUITE_NAMES, deterministicSuites);
    expect(picked.map((d) => d.name)).toEqual([...GATE_SUITE_NAMES]);
    expect(() => selectGateSuites(["det-99-not-real"], deterministicSuites)).toThrow(/not in the deterministic roster/);
  });
});

describe("improvement-gate — 配对回放（真装载器）", () => {
  it("良性 stable 规则：基线绿 + 候选绿（规则进 stable 车道与系统提示）", async () => {
    const r = await pairedRulesReplay(STABLE_INPUT, tmp);
    expect(r.baselineOk).toBe(true);
    expect(r.candidateOk).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("良性 gated 规则：候选绿（规则进 gated 车道、不进系统提示、matcher 命中）", async () => {
    const r = await pairedRulesReplay(GATED_INPUT, tmp);
    expect(r.baselineOk).toBe(true);
    expect(r.candidateOk).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("空正文规则：装载器跳过（warning）→ 候选红（提案被门拦下）", async () => {
    const r = await pairedRulesReplay({ proposalId: "p3", ruleFileName: "auto-p3.md", ruleText: "   " }, tmp);
    expect(r.baselineOk).toBe(true);
    expect(r.candidateOk).toBe(false);
    expect(r.errors.some((e) => e.includes("未装载") || e.includes("装载警告"))).toBe(true);
  });
});

describe("improvement-gate — 完整门（配对 + 骨干套件）", () => {
  it("全绿 stub → ok:true；套件未过 → ok:false 且 reason 点名套件", async () => {
    const ok = await runImprovementGate(STABLE_INPUT, { suites: [def("det-a"), def("det-b")], tmpRoot: tmp });
    expect(ok.ok).toBe(true);
    expect(ok.paired.baselineOk && ok.paired.candidateOk).toBe(true);
    expect(ok.suites.map((s) => s.status)).toEqual(["pass", "pass"]);

    const bad = await runImprovementGate(STABLE_INPUT, { suites: [def("det-a"), def("det-b", ["断言失败"])], tmpRoot: tmp });
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain("det-b");
  });

  it("套件 errored（非断言）同样不过门——reef 律：报错排在一切真分数之下", async () => {
    const boom: EvalDefinition<unknown, unknown> = {
      name: "det-boom",
      kind: "deterministic",
      setup: async () => {
        throw new Error("harness fault");
      },
      run: async () => ({}),
      assertions: () => [],
    };
    const r = await runImprovementGate(STABLE_INPUT, { suites: [boom], tmpRoot: tmp });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("det-boom");
  });
});

// gate-cli 的协议形状钉（实跑冒烟见下）：--proposal/--out 合同。
describe("improvement-gate — gate-cli 实跑冒烟（真 5 套件骨干，一次性 ~4s）", () => {
  it(
    "良性提案过真门：verdict.ok=true 且 5 套件全绿",
    async () => {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const run = promisify(execFile).bind(null, process.execPath);
      const proposalPath = join(tmp, "proposal.json");
      const outPath = join(tmp, "verdict.json");
      await writeFile(proposalPath, `${JSON.stringify(STABLE_INPUT)}\n`, "utf8");
      await run([join("dist", "gate-cli.js"), "--proposal", proposalPath, "--out", outPath], { cwd: process.cwd() });
      const verdict = JSON.parse(await readFile(outPath, "utf8")) as { ok: boolean; suites: { name: string; status: string }[] };
      expect(verdict.ok).toBe(true);
      expect(verdict.suites.length).toBe(GATE_SUITE_NAMES.length);
      expect(verdict.suites.every((s) => s.status === "pass")).toBe(true);
    },
    120_000,
  );
});
